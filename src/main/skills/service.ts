/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The `skills` namespace over the folder store: the Skills page's
// filters, the editor's files, export and import, Save as skill (a draft
// from a chat, written by the quick model) and Run. Deletes go to Recently
// Deleted through the `skill` trash adapter.
import { BRAND_NAME } from '@shared/branding'
import { cpSync, existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { SHARED_OWNER } from '@shared/chats'
import type { AppEvent, Owner } from '@shared/services'
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_PATTERN, filterSkills, type Skill, type SkillDraft, type SkillFilter, type SkillSaveInput, type SkillsMethods } from '@shared/skills'
import type { AgentHostApi } from '../agent/hostApi'
import { chatMarkdown } from '../chats'
import { NOT_YET } from '../serviceKit'
import { SKILL_FILE_MAX_BYTES as IMPORT_MAX_BYTES } from '../skillFiles'
import { parseSkillDocument, skillNameFromFile } from './format'
import type { SkillStore } from './store'

/** Apex's own drafting prompt for Save as skill. */
export const DRAFT_SYSTEM = `You turn a conversation into a reusable skill for ${BRAND_NAME}, a web browser with a built-in assistant. A skill is a set of instructions the assistant follows whenever the user types /name.

Reply with JSON only, no prose and no code fence:
{"name": "...", "description": "...", "instructions": "...", "steps": [{"title": "...", "instructions": "..."}]}

- name: lowercase letters, digits and dashes, at most 40 characters. Name the kind of task, not this one conversation's topic.
- description: one sentence on what the skill is for, at most 300 characters.
- instructions: generalise what worked in the conversation: what to do, what to ask for when it is missing, and how the result should look. Write them to the assistant.
- steps: only when the task has distinct stages done in order; otherwise an empty list.
- Leave out personal details, one-off facts, names of people and anything that looks secret.
- Write in the language the user wrote in.`

const TRANSCRIPT_MAX = 40_000

const draftReply = z.object({
  name: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  instructions: z.string().max(60_000).optional(),
  steps: z.array(z.object({ title: z.string().max(400).optional(), instructions: z.string().max(30_000).optional() })).max(50).optional(),
})

/** The model's reply as a skill draft; throws when it can't be used. */
export function parseDraftReply(reply: string, fallbackName: string): SkillDraft {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  let raw: unknown = null
  if (start >= 0 && end > start) {
    try {
      raw = JSON.parse(reply.slice(start, end + 1))
    } catch {
      raw = null
    }
  }
  const parsed = draftReply.safeParse(raw)
  if (!parsed.success) throw new Error('Couldn’t draft a skill from this chat. Try again, or write one yourself.')
  const d = parsed.data
  const steps = (d.steps ?? []).map((s, i) => ({ id: `step-${i + 1}`, title: (s.title ?? '').trim().slice(0, 200), instructions: (s.instructions ?? '').trim().slice(0, 20_000) })).filter((s) => s.title || s.instructions)
  const instructions = (d.instructions ?? '').trim().slice(0, 50_000)
  if (!instructions && steps.length === 0) throw new Error('Couldn’t draft a skill from this chat. Try again, or write one yourself.')
  const nameRaw = (d.name ?? '').trim().toLowerCase()
  const name = SKILL_NAME_PATTERN.test(nameRaw) ? nameRaw : skillNameFromFile(nameRaw || fallbackName) || 'new-skill'
  return { name, description: (d.description ?? '').replace(/\s+/g, ' ').trim().slice(0, SKILL_DESCRIPTION_MAX), instructions, steps }
}

export interface SkillServiceDeps {
  store: SkillStore
  host: AgentHostApi
  chats: { summary(id: string): { title: string; createdAt: number; companionId: string } | undefined; load(id: string): { log: import('@shared/ipc').AgentEvent[] } }
  companions: { find(id: string): { id: string; name: string } | undefined; get(): { id: string; name: string } }
  /** The basic chat start (create + send), used when startChat isn't available. */
  startChatFallback(text: string, companionId: string | undefined): string
  broadcast(event: AppEvent): void
  /** Moves a skill into Recently Deleted; throws 'Not available yet' until the workspace feature fills it. */
  trash(id: string): void
  reveal(path: string): void
  dialogs: {
    saveFile(defaultName: string): Promise<string | null>
    pickFolder(): Promise<string | null>
    openFile(): Promise<string | null>
  }
  writeFile(path: string, text: string): void
}

type SkillsService = SkillsMethods & {
  list(filter?: SkillFilter): Skill[]
  save(input: SkillSaveInput): Skill
  remove(id: string): void
  exportFile(id: string): Promise<string | null>
  importFile(owner?: Owner): Promise<Skill | null>
}

export function createSkillsService(deps: SkillServiceDeps): SkillsService {
  const { store } = deps
  const checkOwner = (owner: Owner | undefined): Owner | undefined => {
    if (owner === undefined || owner === SHARED_OWNER || deps.companions.find(owner)) return owner
    throw new Error('That companion no longer exists.')
  }
  const files = (id: string): void => deps.broadcast({ type: 'skill-files', skillId: id })

  return {
    list(filter) {
      // The folders are the truth: pick up edits made in Finder.
      store.rescan()
      return filterSkills(store.all(), filter ?? {}, SHARED_OWNER)
    },
    get: (id) => store.require(id),
    save: (input) => store.save({ ...input, owner: checkOwner(input.owner) }),
    remove(id) {
      const skill = store.require(id)
      if (skill.source === 'builtin') throw new Error('Built-in skills can’t be deleted.')
      try {
        deps.trash(id)
        store.forget(id)
      } catch (err) {
        // Recently Deleted isn't in yet: the page already asked, so delete outright.
        if (!(err instanceof Error) || err.message !== NOT_YET) throw err
        store.remove(id)
      }
    },
    duplicate: (id, owner) => store.duplicate(id, checkOwner(owner)),
    files: (id) => store.files(id),
    readFile: (id, path) => store.readFile(id, path),
    writeFile(id, path, text) {
      const file = store.writeFile(id, path, text)
      files(id)
      return file
    },
    addFile(id, name, base64) {
      const file = store.addFile(id, name, base64)
      files(id)
      return file
    },
    removeFile(id, path) {
      store.removeFile(id, path)
      files(id)
    },
    reveal(id) {
      const dir = store.folderOf(id)
      if (!dir) throw new Error(`Built-in skills live inside ${BRAND_NAME}. Duplicate it to get a folder of your own.`)
      deps.reveal(join(dir, 'SKILL.md'))
    },
    async exportFile(id) {
      const skill = store.require(id)
      const dir = store.folderOf(id)
      if (dir && skill.files.length > 0) {
        // Supporting files only make sense together: copy the whole folder.
        const target = await deps.dialogs.pickFolder()
        if (!target) return null
        let dest = join(target, skill.name)
        for (let n = 2; existsSync(dest); n++) dest = join(target, `${skill.name} ${n}`)
        cpSync(dir, dest, { recursive: true, filter: (src) => !basename(src).startsWith('.') })
        return dest
      }
      const path = await deps.dialogs.saveFile(`${skill.name}.md`)
      if (!path) return null
      deps.writeFile(path, store.markdown(id))
      return path
    },
    async importFile(owner) {
      const path = await deps.dialogs.openFile()
      if (!path) return null
      if (statSync(path).size > IMPORT_MAX_BYTES) throw new Error('This skill file is too large to import.')
      const doc = parseSkillDocument(readFileSync(path, 'utf8'), { fileName: basename(path), deriveDescription: true })
      return store.save({ name: doc.name, description: doc.description, instructions: doc.instructions, steps: doc.steps, owner: checkOwner(owner) })
    },
    async draftFromChat(chatId) {
      const summary = deps.chats.summary(chatId)
      if (!summary) throw new Error('This chat no longer exists.')
      const companion = deps.companions.find(summary.companionId)
      let transcript = chatMarkdown(summary, deps.chats.load(chatId).log, companion?.name ?? 'Assistant')
      // Long chats: the end holds what finally worked.
      if (transcript.length > TRANSCRIPT_MAX) transcript = `…\n${transcript.slice(-TRANSCRIPT_MAX)}`
      const reply = await deps.host.complete({
        ...(companion ? { companionId: companion.id } : {}),
        system: DRAFT_SYSTEM,
        prompt: `Here is the conversation to turn into a skill:\n\n<conversation>\n${transcript}\n</conversation>`,
        maxTokens: 2000,
        kind: 'draft',
      })
      return { ...parseDraftReply(reply, summary.title), owner: companion ? companion.id : SHARED_OWNER }
    },
    run(id, companionId) {
      const skill = store.require(id)
      const target = companionId ?? (skill.source === 'user' && skill.owner !== SHARED_OWNER ? skill.owner : undefined)
      if (target && !deps.companions.find(target)) throw new Error('That companion no longer exists.')
      try {
        return deps.host.startChat(`/${skill.name}`, { ...(target ? { companionId: target } : {}), open: 'none' })
      } catch (err) {
        if (!(err instanceof Error) || err.message !== NOT_YET) throw err
        return deps.startChatFallback(`/${skill.name}`, target)
      }
    },
  }
}
