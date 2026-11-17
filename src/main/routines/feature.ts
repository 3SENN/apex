/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The skills-and-routines feature module (`skillsRoutines` in FEATURES): skill folders,
// built-in skills, Save as skill, full routines, run history, one-off tasks
// and suggested routines. It takes the base stores and runner from
// AppContext.skillRoutines, attaches the run records and host to the runner, and
// registers the client tools, the `skill` trash adapter and the `skill`
// export source. Until index.ts passes skillRoutines (and in contract tests), every
// method throws 'Not available yet'.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialog } from 'electron'
import { isExcluded, type Exclusions } from '@shared/exclusions'
import type { Routine, RoutinesMethods } from '@shared/routines'
import type { Services } from '@shared/services'
import type { SkillsMethods } from '@shared/skills'
import { clientTool, registerClientTool } from '../agent/tools/registry'
import { stubMethods } from '../serviceKit'
import { registerExportSource } from '../exporter'
import type { AppContext, Feature } from '../features/types'
import { createSkillsService } from '../skills/service'
import type { SkillStore } from '../skills/store'
import { registerTrashAdapter, trash, trashAdapter, versions } from '../workspace/adapters'
import { validateCron } from './cron'
import { RoutineRunStore } from './runs'
import type { SkillRoutineRuntime } from './runtime'
import { previewSchedule } from './schedule'
import type { RoutineStore } from './store'
import { RoutineSuggestions } from './suggestions'
import { skillRoutineTools } from './tools'
import { mainT } from '../i18n/mainT'

type SkillsNs = Services['skills']
type RoutinesNs = Services['routines']

const SKILL_METHODS = ['list', 'save', 'remove', 'exportFile', 'importFile', 'get', 'duplicate', 'files', 'readFile', 'writeFile', 'addFile', 'removeFile', 'reveal', 'draftFromChat', 'run'] as const satisfies readonly (keyof SkillsNs)[]
const ROUTINE_METHODS = ['list', 'save', 'remove', 'runNow', 'get', 'setEnabled', 'runs', 'markRunsRead', 'previewSchedule', 'validateCron', 'suggestions', 'dismissSuggestion'] as const satisfies readonly (keyof RoutinesNs)[]

/** Registers the skill and routine client tools (propose_routine, list_routines, draft_skill, read_skill); once per process. */
export function registerSkillRoutineTools(deps?: { routines: RoutineStore; skills: SkillStore }): void {
  if (!deps) return
  for (const tool of skillRoutineTools(deps)) if (!clientTool(tool.name)) registerClientTool(tool)
}

/** The `skill` kind of Recently Deleted: the folder moves into the trash, and back on restore. */
function registerSkillTrash(store: SkillStore): void {
  if (trashAdapter('skill')) return
  registerTrashAdapter({
    kind: 'skill',
    title: (id) => `/${store.require(id).name}`,
    snapshot(id) {
      const entry = store.entry(id)
      const dir = store.folderOf(id)
      if (!entry || !dir) throw new Error('This skill no longer exists.')
      return { payload: entry, files: [dir] }
    },
    restore(payload, files) {
      const folder = files[0]
      if (!folder) throw new Error('The skill’s folder is missing from Recently Deleted.')
      return `/${store.restoreFolder(payload as Parameters<SkillStore['restoreFolder']>[0], folder).name}`
    },
  })
}

/** activity/settings.json's proactive.routines and exclusions (the activity memory's file); off when missing. */
function readProactive(dataDir: string): { routines: boolean; excluded: Exclusions | null } {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'activity', 'settings.json'), 'utf8')) as { proactive?: { routines?: unknown }; excluded?: Exclusions }
    return { routines: raw.proactive?.routines === true, excluded: raw.excluded ?? null }
  } catch {
    return { routines: false, excluded: null }
  }
}

function wire(app: AppContext, rt: SkillRoutineRuntime): { skills: SkillsNs; routines: RoutinesNs } {
  const { skills, routines, runner, chats, companions } = rt
  const runs = new RoutineRunStore(join(app.dataDir, 'routines.sqlite'))
  // A routine may wait for a companion, append to a chat, or start from a skill: the store asks.
  routines.bind({
    companionExists: (id) => companions.find(id) !== undefined,
    chatProblem: (chatId) => {
      const chat = chats.summary(chatId)
      return !chat ? 'missing' : chat.private ? 'private' : null
    },
    skillExists: (id) => skills.get(id) !== undefined,
  })
  skills.bind({ snapshot: (ref, text, label) => versions.snapshot(ref, text, label) })
  runner.attach({
    host: app.agent,
    runs,
    activeCompanionId: () => companions.get().id,
    skillName: (id) => skills.get(id)?.name ?? null,
    canAppend: (chatId) => {
      const chat = chats.summary(chatId)
      return chat !== undefined && !chat.private
    },
    patchChat: (chatId, patch) => void chats.update([chatId], patch),
  })
  runs.on('changed', (routineId) => app.broadcast({ type: 'routine-runs', routineId }))
  // Opening a run's chat reads it.
  chats.on('changed', (items) => {
    if (runs.unreadCount() === 0) return
    runs.markChatsRead(items.filter((c) => c.routineRun !== null && !c.unread).map((c) => c.id))
  })
  registerSkillRoutineTools({ routines, skills })
  registerSkillTrash(skills)
  registerExportSource('skill', { title: (id) => `/${skills.require(id).name}`, markdown: (id) => skills.markdown(id) })

  const suggestions = new RoutineSuggestions({
    dataDir: app.dataDir,
    proactive: () => readProactive(app.dataDir),
    chats: () => chats.list(),
    ...(rt.timeline ? { sites: (q: { from: number; to: number }) => rt.timeline!.sites({ ...q, sort: 'visits' }) } : {}),
    isExcluded,
    routineNames: () => routines.list().map((r) => r.name),
  })

  const win = (): Electron.BrowserWindow | undefined => rt.window() ?? undefined
  const skillsService = createSkillsService({
    store: skills,
    host: app.agent,
    chats,
    companions,
    broadcast: app.broadcast,
    trash: (id) => void trash.put('skill', id),
    reveal: (path) => rt.reveal?.(path),
    startChatFallback: (text, companionId) => {
      const chat = app.agent.create(companionId ? { companionId } : {})
      app.agent.send(chat.id, text)
      return chat.id
    },
    dialogs: {
      async saveFile(defaultName) {
        const w = win()
        const picked = await (w ? dialog.showSaveDialog(w, { defaultPath: defaultName, filters: [{ name: mainT('skills.mainFeature.skill'), extensions: ['md'] }] }) : dialog.showSaveDialog({ defaultPath: defaultName }))
        return picked.canceled || !picked.filePath ? null : picked.filePath
      },
      async pickFolder() {
        const w = win()
        const options: Electron.OpenDialogOptions = { title: mainT('skills.mainFeature.exportTheSkillFolder'), properties: ['openDirectory', 'createDirectory'] }
        const picked = await (w ? dialog.showOpenDialog(w, options) : dialog.showOpenDialog(options))
        return picked.canceled ? null : (picked.filePaths[0] ?? null)
      },
      async openFile() {
        const w = win()
        const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: mainT('skills.mainFeature.skill'), extensions: ['md', 'markdown', 'txt'] }] }
        const picked = await (w ? dialog.showOpenDialog(w, options) : dialog.showOpenDialog(options))
        return picked.canceled ? null : (picked.filePaths[0] ?? null)
      },
    },
    writeFile: (path, text) => writeFileSync(path, text, 'utf8'),
  })

  const get = (id: string): Routine => {
    const r = routines.get(id)
    if (!r) throw new Error('This routine no longer exists.')
    return r
  }
  const routinesService: RoutinesNs = {
    list: (filter) => routines.query(filter ?? {}),
    get,
    save: (input) => routines.save(input),
    remove: (id) => routines.remove(id),
    runNow(id) {
      const r = get(id)
      if (r.needsCompanion) throw new Error('Pick a companion for this routine first.')
      if (runner.isRunning(id)) throw new Error(`${r.name} is already running.`)
      void runner.runNow(id)
    },
    setEnabled: (id, enabled) => routines.setEnabled(id, enabled),
    runs: (query) => runs.list(query),
    markRunsRead: (routineId) => runs.markRead(routineId),
    previewSchedule: (schedule, timeZone, count) => previewSchedule(schedule, timeZone, count ?? 5),
    validateCron: (expr) => validateCron(expr),
    suggestions: () => suggestions.list(),
    dismissSuggestion: (id) => suggestions.dismiss(id),
  }
  return { skills: skillsService, routines: routinesService }
}

export function createSkillRoutineFeatures(): Feature {
  let wired: { skills: SkillsNs; routines: RoutinesNs } | null = null
  return {
    name: 'skillsRoutines',
    app(app) {
      const rt = app.skillRoutines
      if (!rt) {
        // Not wired (contract tests): every method says so.
        return {
          skills: stubMethods<SkillsNs>([...SKILL_METHODS]) as Partial<SkillsNs> & SkillsMethods,
          routines: stubMethods<RoutinesNs>([...ROUTINE_METHODS]) as Partial<RoutinesNs> & RoutinesMethods,
        }
      }
      wired = wire(app, rt)
      return wired
    },
    dispose() {
      wired = null
    },
  }
}
