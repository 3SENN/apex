/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ChatFeedback, ChatListFilter, ChatStatus, ChatSummary, MessageDetails } from '@shared/chats'
import type { EngineId } from '@shared/engine'
import type { AgentEvent, Effort } from '@shared/ipc'
import { writeAtomic } from './settings'
import { readJson } from './stores'
import type { ChatGrant } from '@shared/agentTools'
import { normalizeAgentToolsCapabilities, normalizeGrants, normalizeSummaryLinks } from './agent/chatFormatAgentTools'
import type { TranscriptImport } from '@shared/exportFormat'
import { notYet } from './serviceKit'
import { normalizeRichChatCapabilities, normalizeAttachmentLog, type RichChatCapabilities } from './agent/chatFormatRichChat'
import { CHAT_FORMAT_VERSION, type MigrationOutcome } from '@shared/migrations'
import { BACKUP_DIR } from './migrations/backup'
import { upgradeChatFile, type ChatFileResult } from './migrations/runner'
import { mainT } from './i18n/mainT'

// Saved chats: an index of summaries (index.json) plus one file per chat with
// its fixed setup, API history and compacted event log. The index is the
// source of truth for summary fields (title, flags, status); a chat file
// carries a copy so a lost index can be rebuilt.

/** What a chat was started with. Tools, system prompt and effort stay fixed for its lifetime. */
export interface ChatCapabilities {
  model: string
  /** Absent in chats from before per-chat effort; they follow the global setting. */
  effort?: Effort
  browser: boolean
  webTools: boolean
  memory: boolean
  connectorIds: string[]
  /** 'companion': /memories is the companion's folder and /memories/shared the shared one. Absent in older chats, where /memories is the shared folder. */
  memoryScope?: 'companion'
  /** What runs the chat (ST-58). Absent in chats from before engines: the API key. */
  engine?: EngineId
  // Absent in older chats: [] and false, see chatFormatAgentTools
  /** Client-tool names frozen at the first message, sorted. */
  clientTools?: string[]
  private?: boolean
  // Load fills these for older chats; see chatFormatRichChat
  documents?: RichChatCapabilities['documents']
  compaction?: RichChatCapabilities['compaction']
  containerId?: RichChatCapabilities['containerId']
  localTools?: RichChatCapabilities['localTools']
  toolPolicies?: RichChatCapabilities['toolPolicies']
  cClientTools?: RichChatCapabilities['cClientTools']
}

export interface ChatContent {
  id: string
  capabilities: ChatCapabilities
  system: string
  messages: BetaMessageParam[]
  log: AgentEvent[]
  /** Per model turn, keyed by turnId. */
  details: Record<string, MessageDetails>
  /** Ratings by turnId. Local only, never sent to the model. */
  feedback: Record<string, ChatFeedback>
  /** The engine's own conversation to continue (its session id), when it keeps one. */
  engineSession?: EngineSession | null
  // Remembered approvals, scope 'chat'; absent in older chats: []
  grants?: ChatGrant[]
  /** DC-15: where a quick decision changed the effort of the messages a person sent (absent: the chat's effort throughout). */
  effortMarks?: EffortMark[]
}

/**
 * DC-15: a change of effort the chat keeps: from the typed message at `at` in
 * its history on, turns run at `effort` until the next mark. Saved with the
 * chat so every later request sends the same history (see turnDecisions.ts).
 */
export interface EffortMark {
  at: number
  effort: Effort
}

const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Saved effort marks, in order and inside the history; anything malformed is dropped. */
export function effortMarksOf(raw: unknown, messages: number): EffortMark[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const marks: EffortMark[] = []
  for (const item of raw as unknown[]) {
    if (!isObject(item)) continue
    const { at, effort } = item
    if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at >= messages || (marks.at(-1)?.at ?? -1) >= at) continue
    if (typeof effort !== 'string' || !EFFORT_LEVELS.includes(effort as Effort)) continue
    marks.push({ at, effort: effort as Effort })
  }
  return marks.length > 0 ? marks : undefined
}

/** An engine's own session a chat continues. `fork` continues it under a new id (a duplicated chat). */
export interface EngineSession {
  id: string
  fork?: boolean
}

export type ChatRecord = ChatSummary & ChatContent

export type ChatPatch = Partial<Omit<ChatSummary, 'id' | 'draft'>>

const CHAT_ID = /^[0-9a-f-]{36}$/
const STATUSES: readonly ChatStatus[] = ['idle', 'running', 'needs-approval', 'error', 'finished']
const SEARCH_TEXT_MAX = 64 * 1024
export const CHAT_TITLE_MAX = 120

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

const SESSION_ID = /^[A-Za-z0-9-]{8,128}$/

/** A saved engine session, or null when missing or malformed. */
export function engineSessionOf(raw: unknown): EngineSession | null {
  if (!isObject(raw) || !str(raw.id) || !SESSION_ID.test(raw.id)) return null
  return raw.fork === true ? { id: raw.id, fork: true } : { id: raw.id }
}

export const INTERRUPTED = `Not executed: ${BRAND_NAME} closed before this step finished.`

/**
 * A chat saved between an assistant's tool calls and their results (Atelier quit
 * or crashed during a step or an approval) ends on unanswered tool_use
 * blocks, which the API rejects on every later request. Answers each one with
 * an error result so the history is valid again. Returns the messages
 * unchanged when nothing is dangling.
 */
export function closeDanglingToolUses(messages: BetaMessageParam[]): BetaMessageParam[] {
  const last = messages.at(-1)
  if (last?.role !== 'assistant' || typeof last.content === 'string') return messages
  const calls = last.content.flatMap((block) => (block.type === 'tool_use' ? [block] : []))
  if (calls.length === 0) return messages
  const results = calls.map((call) => ({
    type: 'tool_result' as const,
    tool_use_id: call.id,
    ...('toolset_name' in call && typeof call.toolset_name === 'string' ? { toolset_name: call.toolset_name } : {}),
    is_error: true,
    content: INTERRUPTED,
  }))
  return [...messages, { role: 'user', content: results }]
}

export function chatTitle(text: string): string {
  const firstLine = text.replace(/<skill name="([^"]+)">[\s\S]*?<\/skill>/, '/$1').trim().split('\n')[0] ?? ''
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine || mainT('chat.mainChats.newChat')
}

/**
 * Fills summary fields added since a chat was saved. Old chats belong to
 * `defaultCompanionId` (the companion migrated from the single profile), and
 * nothing is running after a restart.
 */
export function normalizeSummary(raw: Record<string, unknown>, defaultCompanionId: string): ChatSummary {
  const createdAt = num(raw.createdAt, 0)
  const updatedAt = num(raw.updatedAt, createdAt)
  const saved = STATUSES.find((s) => s === raw.status) ?? 'idle'
  return {
    id: String(raw.id),
    title: str(raw.title) && raw.title.trim() ? raw.title : mainT('chat.mainChats.newChat'),
    createdAt,
    updatedAt,
    lastActiveAt: num(raw.lastActiveAt, updatedAt),
    routineId: str(raw.routineId) ? raw.routineId : null,
    companionId: str(raw.companionId) && raw.companionId ? raw.companionId : defaultCompanionId,
    model: str(raw.model) ? raw.model : '',
    status: saved === 'running' || saved === 'needs-approval' ? 'idle' : saved,
    unread: raw.unread === true,
    pinned: raw.pinned === true,
    archived: raw.archived === true,
    needsInput: raw.needsInput === true,
    draft: false,
    actWithoutAsking: raw.actWithoutAsking === true,
    muted: raw.muted === true,
    ...normalizeSummaryLinks(raw),
  }
}

/** Your messages and the replies' text, lowercased, for content search. */
export function searchTextOf(log: readonly AgentEvent[]): string {
  const parts: string[] = []
  let size = 0
  for (const event of log) {
    const text = event.type === 'user-message' || event.type === 'text-delta' ? event.text : null
    if (!text) continue
    parts.push(text)
    size += text.length + 1
    if (size >= SEARCH_TEXT_MAX) break
  }
  return parts.join('\n').slice(0, SEARCH_TEXT_MAX).toLowerCase()
}

/**
 * Filters, ranks and pages summaries. Archived chats appear only for the
 * 'archived' status; pinned chats always come first. `text` returns a chat's
 * lowercased content and is called only when the title doesn't match.
 */
export function filterChats(chats: readonly ChatSummary[], filter: ChatListFilter, text: (id: string) => string): ChatSummary[] {
  const terms = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const scored: Array<{ chat: ChatSummary; score: number }> = []
  for (const chat of chats) {
    if (filter.status === 'archived' ? !chat.archived : chat.archived) continue
    // Private chats are never listed; children only when asked
    if (chat.private) continue
    const children = filter.children ?? 'exclude'
    if (children === 'exclude' ? chat.parentChatId !== null : children === 'only' && chat.parentChatId === null) continue
    if (filter.imported === 'only' ? chat.imported === null : filter.imported === 'exclude' && chat.imported !== null) continue
    if (filter.projectId !== undefined && chat.projectId !== filter.projectId) continue
    if (filter.status === 'unread' && !chat.unread) continue
    if (filter.status === 'needs-input' && !chat.needsInput) continue
    if (filter.companionId && chat.companionId !== filter.companionId) continue
    if (filter.routine === 'only' && !chat.routineId) continue
    if (filter.routine === 'exclude' && chat.routineId) continue
    let score = 0
    if (terms.length > 0) {
      const title = chat.title.toLowerCase()
      let body: string | null = null
      let matched = true
      for (const term of terms) {
        if (title.includes(term)) score += title.startsWith(term) ? 4 : 3
        else if ((body ??= text(chat.id)).includes(term)) score += 1
        else {
          matched = false
          break
        }
      }
      if (!matched) continue
      if (terms.length > 1 && title.includes(terms.join(' '))) score += 5
    }
    scored.push({ chat, score })
  }
  const sort = filter.sort === 'best-match' && terms.length === 0 ? 'recent' : (filter.sort ?? 'recent')
  scored.sort(
    (a, b) =>
      Number(b.chat.pinned) - Number(a.chat.pinned) ||
      (sort === 'best-match' ? b.score - a.score : 0) ||
      (sort === 'oldest' ? a.chat.createdAt - b.chat.createdAt : b.chat.lastActiveAt - a.chat.lastActiveAt),
  )
  const offset = Math.max(0, filter.offset ?? 0)
  return scored.slice(offset, offset + Math.max(1, filter.limit ?? 200)).map((s) => s.chat)
}

/** A chat as Markdown: your messages, replies, tool steps and notices. Thinking is left out. */
export function chatMarkdown(
  summary: Pick<ChatSummary, 'title' | 'createdAt'>,
  log: readonly AgentEvent[],
  companionName: string,
  formatDate: (ms: number) => string = (ms) => new Date(ms).toLocaleString(),
): string {
  const out: string[] = [`# ${summary.title}`, '', `*${companionName} · ${formatDate(summary.createdAt)}*`]
  let speaker: 'you' | 'companion' | null = null
  const say = (who: 'you' | 'companion'): void => {
    if (speaker === who) return
    speaker = who
    out.push('', `**${who === 'you' ? 'You' : companionName}**`)
  }
  for (const event of log) {
    switch (event.type) {
      case 'user-message':
        say('you')
        out.push('', event.text)
        break
      case 'text-delta':
        if (!event.text.trim()) break
        say('companion')
        out.push('', event.text.trim())
        break
      case 'tool':
        say('companion')
        out.push('', `- ${event.label}${event.state === 'error' ? ' (failed)' : ''}`)
        break
      case 'approval':
        say('companion')
        out.push('', mainT('chat.mainChats.askedForApproval', { description: event.description }))
        break
      case 'approval-resolved':
        out.push('', `> ${event.allowed ? mainT('chat.mainChats.youAllowedIt') : mainT('chat.mainChats.youDeclined')}`)
        break
      case 'error':
        out.push('', `> ${event.message}`)
        break
      default:
        break
    }
  }
  return `${out.join('\n')}\n`
}

/** A safe file name for an exported chat or companion. */
export function exportFileName(title: string, extension: string): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).trim()
  return `${base || 'Untitled'}.${extension}`
}

// `removed`: ids deleted for good, for the search index and projects.
// `migration`: a chat file was brought up to date, or couldn't be.
export class ChatStore extends EventEmitter<{ changed: [ChatSummary[]]; removed: [string[]]; migration: [MigrationOutcome] }> {
  readonly #dir: string
  #index: ChatSummary[]
  readonly #search = new Map<string, string>()

  /** `defaultCompanionId` owns chats saved before companions had ids. */
  constructor(dataDir: string, defaultCompanionId: string) {
    super()
    this.#dir = join(dataDir, 'chats')
    mkdirSync(this.#dir, { recursive: true })
    const raw = readJson(join(this.#dir, 'index.json'))
    const entries = Array.isArray(raw) ? raw.filter((v): v is Record<string, unknown> => isObject(v) && str(v.id) && CHAT_ID.test(v.id)) : []
    let migrated = false
    this.#index = entries.map((entry) => {
      const summary = normalizeSummary(entry, defaultCompanionId)
      if (!('companionId' in entry) || !('status' in entry)) migrated = true
      // Older index entries lack the model; read it once from the chat file.
      if (!str(entry.model)) {
        const file = readJson(this.#file(summary.id))
        const caps = isObject(file) && isObject(file.capabilities) ? file.capabilities : null
        if (caps && str(caps.model)) summary.model = caps.model
        migrated = true
      }
      return summary
    })
    if (migrated) this.#writeIndex(false)
  }

  /** Saved chats, most recently active first. */
  list(): ChatSummary[] {
    return this.#index.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  query(filter: ChatListFilter = {}): ChatSummary[] {
    return filterChats(this.#index, filter, (id) => this.searchText(id))
  }

  // An imported, read-only transcript; the conversation importer calls it
  /**
   * Saves an imported conversation as a read-only chat: its log holds your
   * messages and the replies' text, and its API history stays empty, because
   * imported turns can't join a model conversation (CH-31).
   */
  importTranscript(input: TranscriptImport, now = Date.now()): ChatSummary {
    const id = randomUUID()
    const log: AgentEvent[] = []
    const details: Record<string, MessageDetails> = {}
    for (const message of input.messages) {
      const text = message.text.trim()
      if (!text) continue
      if (message.role === 'user') {
        log.push({ type: 'user-message', id: randomUUID(), text })
      } else {
        const turnId = randomUUID()
        log.push({ type: 'text-delta', turnId, text })
        // A known time keeps the reply's timestamp for exports; usage stays empty.
        if (message.at !== null) details[turnId] = { turnId, at: message.at, model: '', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: null, memoryPaths: [] }
      }
    }
    const createdAt = input.imported.originalCreatedAt ?? input.messages.find((m) => m.at !== null)?.at ?? now
    const title = (input.title.replace(/\s+/g, ' ').trim() || input.imported.originalTitle.trim() || mainT('chat.mainChats.importedChat')).slice(0, CHAT_TITLE_MAX)
    const summary: ChatSummary = {
      ...normalizeSummary({ id, title, createdAt, updatedAt: now, lastActiveAt: now, companionId: input.companionId, status: 'finished' }, input.companionId),
      imported: { ...input.imported, importedAt: input.imported.importedAt || now },
    }
    const content: ChatContent = {
      id,
      capabilities: { model: '', browser: false, webTools: false, memory: false, connectorIds: [], clientTools: [], private: false },
      system: '',
      messages: [],
      log,
      details,
      feedback: {},
      engineSession: null,
      grants: [],
    }
    this.save(content, { created: summary, touch: false })
    return this.summary(id) ?? summary
  }

  summary(id: string): ChatSummary | undefined {
    const found = this.#index.find((c) => c.id === id)
    return found ? { ...found } : undefined
  }

  load(id: string): ChatContent {
    if (!CHAT_ID.test(id)) throw new Error('This chat no longer exists.')
    // SS-09: an older file is backed up and brought up to date first; a damaged or newer one throws ChatMigrationError.
    const raw = this.upgradeFile(id).record
    if (!isObject(raw) || !Array.isArray(raw.messages) || !isObject(raw.capabilities)) {
      throw new Error(this.summary(id) ? 'This chat could not be read.' : 'This chat no longer exists.')
    }
    return {
      id,
      capabilities: { ...(raw.capabilities as unknown as ChatCapabilities), ...normalizeRichChatCapabilities(raw.capabilities as Record<string, unknown>), ...normalizeAgentToolsCapabilities(raw.capabilities as Record<string, unknown>) },
      system: str(raw.system) ? raw.system : '',
      messages: closeDanglingToolUses(raw.messages as BetaMessageParam[]),
      // Older inline attachment views become AttachmentRef.
      log: Array.isArray(raw.log) ? normalizeAttachmentLog(raw.log as AgentEvent[]) : [],
      details: isObject(raw.details) ? (raw.details as Record<string, MessageDetails>) : {},
      feedback: isObject(raw.feedback) ? (raw.feedback as Record<string, ChatFeedback>) : {},
      engineSession: engineSessionOf(raw.engineSession),
      grants: normalizeGrants(raw.grants),
      ...(Array.isArray(raw.effortMarks) ? { effortMarks: effortMarksOf(raw.effortMarks, raw.messages.length) } : {}), // DC-15
    }
  }

  /**
   * Writes a chat's content. The first save of a new chat passes its summary
   * as `created`; `patch` changes summary fields in the same write, and
   * `touch: false` keeps updatedAt (ratings don't count as activity).
   */
  save(content: ChatContent, options: { created?: ChatSummary; patch?: ChatPatch; touch?: boolean } = {}): void {
    const existing = this.#index.find((c) => c.id === content.id)
    const base: ChatSummary = existing ?? { ...(options.created ?? this.#missing(content.id)), draft: false }
    const summary: ChatSummary = { ...base, ...options.patch, ...(options.touch === false && existing ? {} : { updatedAt: Date.now() }) }
    writeAtomic(this.#file(content.id), JSON.stringify({ ...summary, ...content, formatVersion: CHAT_FORMAT_VERSION }))
    const text = searchTextOf(content.log)
    this.#search.set(content.id, text)
    writeAtomic(this.#textFile(content.id), text)
    this.#index = [...this.#index.filter((c) => c.id !== content.id), summary]
    this.#writeIndex()
  }

  /** The chat's file on disk (migration backups, Show file and smoke seeding). */
  fileOf(id: string): string {
    if (!CHAT_ID.test(id)) throw new Error('This chat no longer exists.')
    return this.#file(id)
  }

  /**
   * Brings the chat's file up to CHAT_FORMAT_VERSION (backup first) and
   * emits `migration` when it changed or couldn't. Throws ChatMigrationError
   * for a damaged file or one a newer Atelier saved; a missing file gives no record.
   */
  upgradeFile(id: string): ChatFileResult {
    const result = upgradeChatFile({ id, file: this.fileOf(id), backupDir: join(this.#dir, BACKUP_DIR), title: this.summary(id)?.title ?? '' })
    if (result.outcome) this.emit('migration', result.outcome)
    if (result.error) throw result.error
    return result
  }

  /** Changes summary fields of saved chats; unknown ids are skipped. Returns the updated summaries. */
  update(ids: readonly string[], patch: ChatPatch): ChatSummary[] {
    const wanted = new Set(ids)
    const changed: ChatSummary[] = []
    this.#index = this.#index.map((chat) => {
      if (!wanted.has(chat.id)) return chat
      const next = { ...chat, ...patch }
      if ((Object.keys(patch) as Array<keyof ChatPatch>).some((key) => next[key] !== chat[key])) changed.push(next)
      return next
    })
    if (changed.length > 0) this.#writeIndex()
    return changed
  }

  remove(ids: readonly string[]): void {
    const gone = new Set(ids.filter((id) => CHAT_ID.test(id)))
    for (const id of gone) {
      rmSync(this.#file(id), { force: true })
      rmSync(this.#textFile(id), { force: true })
      this.#search.delete(id)
    }
    const before = this.#index.length
    this.#index = this.#index.filter((c) => !gone.has(c.id))
    if (this.#index.length !== before) this.#writeIndex()
    if (gone.size > 0) this.emit('removed', [...gone])
  }

  /** Copies a chat's history, log and ratings into a new, unpinned chat. */
  duplicate(id: string, now = Date.now()): ChatSummary {
    const source = this.summary(id)
    if (!source) throw new Error('This chat no longer exists.')
    const content = this.load(id)
    const copyId = randomUUID()
    const title = mainT('chat.mainChats.copy', { value: source.title.slice(0, CHAT_TITLE_MAX - 7) })
    const summary: ChatSummary = {
      ...source,
      id: copyId,
      title,
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
      status: source.status === 'running' || source.status === 'needs-approval' ? 'idle' : source.status,
      unread: false,
      pinned: false,
      archived: false,
      needsInput: false,
    }
    // A copy continues the same engine conversation under its own new id.
    const engineSession = content.engineSession ? { id: content.engineSession.id, fork: true } : null
    this.save({ ...structuredClone(content), id: copyId, engineSession }, { created: summary })
    return this.summary(copyId) ?? summary
  }

  searchText(id: string): string {
    const cached = this.#search.get(id)
    if (cached !== undefined) return cached
    let text: string
    if (existsSync(this.#textFile(id))) {
      text = readFileSync(this.#textFile(id), 'utf8')
    } else {
      // Chats saved before search keep no text file; build it once.
      try {
        text = searchTextOf(this.load(id).log)
        writeAtomic(this.#textFile(id), text)
      } catch {
        text = ''
      }
    }
    this.#search.set(id, text)
    return text
  }

  #missing(id: string): never {
    throw new Error(`Chat ${id} has no summary yet.`)
  }

  #file(id: string): string {
    return join(this.#dir, `${id}.json`)
  }

  #textFile(id: string): string {
    return join(this.#dir, `${id}.txt`)
  }

  #writeIndex(emit = true): void {
    writeAtomic(join(this.#dir, 'index.json'), JSON.stringify(this.#index))
    if (emit) this.emit('changed', this.list())
  }
}
