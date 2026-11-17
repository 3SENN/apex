/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The memory feature module (`memory` in FEATURES): memory build jobs, Tidy
// memory, opt-in activity memory, exclusions, the timeline and insights.
// Everything is built once at start-up from the app context; without it
// (unit tests that pass an empty context) every method answers
// "Not available yet".
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { DEFAULT_ACTIVITY_SETTINGS, type ActivityService, type MemoryJobsMethods, type MemoryUpkeepService } from '@shared/activity'
import { engineReady } from '@shared/engine'
import { SHARED_OWNER } from '@shared/chats'
import { DEFAULT_PROFILE_ID } from '@shared/profiles'
import type { Owner } from '@shared/services'
import type { TimelineService } from '@shared/timeline'
import { NOT_YET } from '../serviceKit'
import type { AppContext, Feature, WindowContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { MemoryJobs } from '../memoryJobs'
import { registerResetStep } from '../reset'
import { registerStorageCategory } from '../storage'
import { TidyMemory } from '../tidy'
import { registerTrashAdapter, trash, versions } from '../workspace/adapters'
import type { MemoryFeatureDeps } from './deps'
import { GUARDED_FIELDS_PROBE, THUMBNAIL_WIDTH } from './gate'
import { ActivityManager, type PageAccess } from './manager'
import { memoryTrashAdapter, memoryTrashId } from './memoryTrash'
import { bindActivitySearch, registerSearchActivity } from './tool'

/** The isolated world the guarded-field probe runs in, apart from the page's own scripts. */
const PROBE_WORLD = 1077

/** Registers the activity memory client tool (search_activity). */
export function registerMemoryTools(): void {
  registerSearchActivity()
}

interface Runtime {
  ctx: AppContext
  deps: MemoryFeatureDeps | null
  activity: ActivityManager
  jobs: MemoryJobs | null
  tidy: TidyMemory | null
  dispose(): void
}

function unavailable(what: string): never {
  throw new Error(`${NOT_YET}: ${what}`)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function createRuntime(ctx: AppContext): Runtime {
  const deps = ctx.memoryDeps ?? null
  const chats = ctx.maintenance?.chats ?? null
  const ownChats = new Set<string>()
  const cleanups: Array<() => void> = []
  const companionName = (id: string): string => deps?.companions.find(id)?.name ?? 'Companion'
  const snapshot = (owner: Owner, path: string, text: string): void => versions.snapshot({ kind: 'memory', owner, path }, text, 'saved')

  const dataDirFor = (profileId: string): string => {
    try {
      return ctx.content.profiles.dataDir(profileId)
    } catch {
      return profileId === DEFAULT_PROFILE_ID ? ctx.dataDir : join(ctx.dataDir, 'profiles', profileId)
    }
  }
  const currentProfile = (): string => {
    try {
      const win = ctx.windows.focused() ?? ctx.windows.all()[0]
      return win ? ctx.content.profiles.profileOf(win.chrome) : DEFAULT_PROFILE_ID
    } catch {
      return DEFAULT_PROFILE_ID
    }
  }

  const activity = new ActivityManager({
    dataDirFor,
    currentProfile,
    flags: () => ctx.settings.get().flags ?? {},
    complete: (input) => ctx.agent.complete(input),
    activeCompanion: () => deps?.companions.activeId() ?? null,
    memory: deps
      ? {
          read: (path, owner) => deps.memory.read(path, owner),
          write: (path, text, owner, author) => {
            deps.memory.write(path, text, owner, author)
            ctx.broadcast({ type: 'memory', owner })
          },
        }
      : null,
    broadcast: (status) => ctx.broadcast({ type: 'activity-status', status }),
  })

  let jobs: MemoryJobs | null = null
  let tidy: TidyMemory | null = null
  if (deps && chats) {
    const chatSource = { list: () => chats.list(), load: (id: string) => chats.load(id) }
    jobs = new MemoryJobs({
      file: join(ctx.dataDir, 'memory-jobs.json'),
      chats: chatSource,
      memory: deps.memory,
      host: { runBackground: (input) => ctx.agent.runBackground(input), stop: (chatId) => ctx.agent.stop(chatId) },
      activeCompanion: () => deps.companions.activeId(),
      companionName,
      engine: () => ({ engine: ctx.settings.get().engine, model: ctx.settings.get().model }),
      snapshot,
      broadcast: (job) => ctx.broadcast({ type: 'memory-job', job }),
      ownChats,
    })
    tidy = new TidyMemory({
      file: join(ctx.dataDir, 'tidy.json'),
      host: { runBackground: (input) => ctx.agent.runBackground(input) },
      chats: chatSource,
      memory: deps.memory,
      companions: () => deps.companions.list().map((c) => ({ id: c.id, name: c.name })),
      // The real status of the chosen engine (a key saved, or another engine set up and signed in).
      engineReady: () => tidyEngineReady(ctx),
      snapshot,
      broadcast: (pass) => ctx.broadcast({ type: 'tidy', pass }),
      ownChats,
    })

    // Every save from an editor keeps a version; every delete goes to Recently Deleted.
    deps.memory.setGuards({
      beforeWrite: (owner, path, previous) => snapshot(owner, path, previous),
      beforeRemove: (owner, path) => void trash.put('memory', memoryTrashId(owner, path)),
    })
    try {
      registerTrashAdapter(memoryTrashAdapter(deps.memory, companionName))
    } catch (err) {
      log.warn('memory', 'Memory trash adapter not registered', { error: errorText(err) })
    }
  }

  if (deps) {
    const removed = (url: string): void => activity.historyRemoved(url)
    const cleared = (): void => activity.historyRemoved(null)
    deps.history.on('removed', removed)
    deps.history.on('cleared', cleared)
  }

  bindActivitySearch({ offeredTo: (chatId) => activity.offeredTo(chatId), search: (q) => activity.search(q), enabled: () => activity.service().settings().enabled })

  try {
    cleanups.push(
      registerStorageCategory({
        id: 'activity-memory',
        label: mainT('memory.storage.label'),
        order: 45,
        measure: async () => activity.size(),
        clear: { label: mainT('memory.storage.clear'), run: async () => void activity.clearAll() },
      }),
      registerResetStep({
        id: 'activity-memory',
        order: 45,
        label: mainT('memory.storage.reset'),
        run: async ({ dryRun }) => {
          if (!dryRun) {
            activity.clearAll()
            activity.service().update({ ...DEFAULT_ACTIVITY_SETTINGS })
            tidy?.update({ enabled: false })
          }
          return { removed: [mainT('memory.storage.label')] }
        },
      }),
    )
  } catch (err) {
    log.warn('activity', 'Storage category not registered', { error: errorText(err) })
  }

  activity.start()
  tidy?.start()
  return {
    ctx,
    deps,
    activity,
    jobs,
    tidy,
    dispose() {
      tidy?.dispose()
      activity.dispose()
      bindActivitySearch(null)
      for (const fn of cleanups) fn()
    },
  }
}

/** What capture may do with one tab: read its address, text and fields, and take a masked thumbnail. */
function pageAccess(rt: Runtime, win: WindowContext, tabId: string): PageAccess {
  const wc = (): WebContents | null => {
    const contents = win.tabs.find(tabId)?.view.webContents
    return contents && !contents.isDestroyed() ? contents : null
  }
  return {
    url: () => wc()?.getURL() ?? null,
    title: () => wc()?.getTitle() ?? '',
    async text() {
      const contents = wc()
      if (!contents || !rt.deps) return ''
      const text = await rt.deps.bridge.request<unknown>(contents, { op: 'getText' }, 8_000)
      return typeof text === 'string' ? text : ''
    },
    async guarded() {
      const contents = wc()
      if (!contents) return true
      try {
        if ((await rt.ctx.personal.masker.guardedRects(tabId)).length > 0) return true
      } catch {
        // The masker is not ready: the probe below still decides.
      }
      try {
        return (await contents.executeJavaScriptInIsolatedWorld(PROBE_WORLD, [{ code: GUARDED_FIELDS_PROBE }])) === true
      } catch {
        // Can't tell: treat it as guarded and capture nothing.
        return true
      }
    },
    async thumbnail() {
      const contents = wc()
      if (!contents) return null
      let image: Electron.NativeImage
      try {
        image = await rt.ctx.personal.masker.capture(tabId, { maxEdge: THUMBNAIL_WIDTH })
      } catch {
        // The page was already checked for guarded fields, so a plain capture is safe.
        image = await contents.capturePage()
      }
      if (image.isEmpty()) return null
      const scaled = image.getSize().width > THUMBNAIL_WIDTH ? image.resize({ width: THUMBNAIL_WIDTH, quality: 'good' }) : image
      return scaled.toJPEG(70)
    },
  }
}

function removeAllNotes(rt: Runtime, owner: Owner): number {
  const deps = rt.deps ?? unavailable('memory store')
  const notes = deps.memory.list(owner)
  const count = notes.length
  if (count === 0) return 0
  try {
    trash.put('memory', memoryTrashId(owner, '*'))
  } catch (err) {
    // Without Recently Deleted the notes are deleted one by one (each tries the trash again).
    log.warn('memory', 'Recently Deleted unavailable for delete all', { error: errorText(err) })
  }
  // After a move to the trash the files are gone already; remove() still drops who wrote them.
  for (const file of notes) deps.memory.remove(file.path, owner)
  rt.ctx.broadcast({ type: 'memory', owner })
  log.info('memory', 'Deleted all notes', { owner: owner === SHARED_OWNER ? 'shared' : 'companion', count })
  return count
}

export function createMemoryFeatures(): Feature {
  let runtime: Runtime | null = null
  const rt = (): Runtime => runtime ?? unavailable('memory upkeep')
  const jobs = (): MemoryJobs => rt().jobs ?? unavailable('memory jobs')
  const tidy = (): TidyMemory => rt().tidy ?? unavailable('Tidy memory')
  const activity = (): ActivityService => rt().activity.service()
  const timeline = (): TimelineService => rt().activity.timeline()

  return {
    name: 'memory',
    app(ctx) {
      registerMemoryTools()
      if (ctx?.dataDir && ctx.settings && !runtime) {
        try {
          runtime = createRuntime(ctx)
        } catch (err) {
          log.error('activity', 'Memory upkeep could not start', { error: errorText(err) })
        }
      }
      const memory: MemoryJobsMethods = {
        estimateBuild: (owner) => jobs().estimateBuild(owner),
        startJob: (kind, owner, options) => jobs().startJob(kind, owner, options),
        cancelJob: (id) => jobs().cancelJob(id),
        retryJob: (id) => jobs().retryJob(id),
        jobs: () => jobs().jobs(),
        removeAll: (owner) => removeAllNotes(rt(), owner),
      }
      const memoryUpkeep: MemoryUpkeepService = {
        settings: () => tidy().settings(),
        update: (patch) => tidy().update(patch),
        passes: (limit) => tidy().passes(limit),
        runNow: (companionId) => tidy().runNow(companionId),
        schedule: () => tidy().schedule(),
      }
      const activityService: ActivityService = {
        status: () => activity().status(),
        settings: () => activity().settings(),
        update: (patch) => activity().update(patch),
        pause: (until) => activity().pause(until),
        resume: () => activity().resume(),
        override: (o) => activity().override(o),
        items: (q) => activity().items(q),
        remove: (ids) => activity().remove(ids),
        clear: (range) => activity().clear(range),
        chatIncluded: (chatId) => activity().chatIncluded(chatId),
        includeInChat: (chatId, included) => activity().includeInChat(chatId, included),
      }
      const timelineService: TimelineService = {
        days: (range) => timeline().days(range),
        sessions: (day) => timeline().sessions(day),
        sites: (q) => timeline().sites(q),
        insights: (range) => timeline().insights(range),
        dismissInsight: (id) => timeline().dismissInsight(id),
      }
      return { memory, memoryUpkeep, activity: activityService, timeline: timelineService }
    },
    window(win) {
      const current = runtime
      if (!current) return
      // A private window's pages never reach the timeline or activity memory.
      win.tabs.on('page-visited', (visit) => current.activity.onVisit({ ...visit, privateWindow: visit.privateWindow || win.kind === 'private' }, pageAccess(current, win, visit.tabId)))
      win.tabs.on('page-titled', (t) => current.activity.onTitle(t.tabId, t.url, t.title))
      win.tabs.on('page-left', (left) => current.activity.onLeft(left))
    },
    dispose() {
      runtime?.dispose()
      runtime = null
    },
  }
}

/** Whether the engine background chats use can run now; without a status source, only a saved key counts. */
export function tidyEngineReady(ctx: Pick<AppContext, 'settings' | 'engineStatus'>): boolean {
  const engine = ctx.settings.get().engine
  const status = ctx.engineStatus?.()
  if (status) return engineReady(status, engine)
  return engine === 'api-key' && ctx.settings.view().hasApiKey
}
