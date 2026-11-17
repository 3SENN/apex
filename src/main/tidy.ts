/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tidy memory (ST-48, CO-09): an opt-in nightly pass, off by
// default. Once a night after `afterHour` (3 by default) while Atelier is open,
// or at the next start when a night was missed, each companion with new
// chats since its last pass gets one background chat that reads those chats
// and its notes and rewrites the notes. Every note is kept as a version
// first. A pass is skipped when no engine is ready, and the rest of the
// night is skipped after a provider rate limit or quota error; Atelier has no
// quota of its own. With the decision model on for memory (DC-17), new chats
// it is sure hold nothing lasting are left out, and a night where that is
// every chat records a skipped pass without a background chat. State lives
// in userData/tidy.json.
import { randomUUID } from 'node:crypto'
import { isTidyDue, nextTidyAt, type TidyPass, type TidySchedule, type TidySettings } from '@shared/activity'
import type { ChatSummary } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { MemoryFile, Owner } from '@shared/services'
import type { AgentHostApi } from './agent/hostApi'
import { decider } from './decisions/service'
import { log } from './log'
import { chatTranscript, eligibleChats, nothingToRemember, type Transcript } from './memoryJobs'
import { writeAtomic } from './settings'
import { readJson } from './stores'
import { mainT } from './i18n/mainT'

const CHECK_MS = 15 * 60_000
/** A first pass reads at most this far back. */
const FIRST_LOOKBACK_MS = 7 * 86_400_000
const CHATS_BUDGET = 60_000
const KEEP_PASSES = 200

export const DEFAULT_TIDY: TidySettings = { enabled: false, afterHour: 3 }

interface TidyFile {
  settings: TidySettings
  passes: TidyPass[]
  lastRunAt: number | null
  lastPassAt: Record<string, number>
}

/** Provider limits end the night: the next companions would hit them too. */
export function isRateLimit(message: string): boolean {
  return /rate.?limit|quota|\b429\b|overloaded|usage limit|credit balance/i.test(message)
}

export function tidyPrompt(transcripts: readonly string[], notes: readonly MemoryFile[]): string {
  return [
    'This is your nightly memory tidy. Read the conversations below and the notes in /memories/ (use the memory tool to view them).',
    'Update the notes: add what is worth remembering from these chats, merge duplicates, settle contradictions in favour of the newest information, and remove what is plainly outdated. Keep files short, one topic each.',
    'Never invent anything. Leave out health, money, relationships, religion, politics and identity numbers unless the person asked you to remember them.',
    'When you are done, reply with one short line about what changed.',
    '',
    `Notes now: ${notes.map((n) => n.path).join(', ') || '(none)'}`,
    '',
    '<conversations>',
    transcripts.join('\n\n---\n\n'),
    '</conversations>',
  ].join('\n')
}

export interface TidyDeps {
  /** userData/tidy.json */
  file: string
  host: Pick<AgentHostApi, 'runBackground'>
  chats: { list(): ChatSummary[]; load(id: string): { log: readonly AgentEvent[] } }
  memory: {
    list(owner: Owner): MemoryFile[]
    read(path: string, owner: Owner): string
    on(event: 'changed', fn: (owner: Owner, path: string) => void): unknown
    off(event: 'changed', fn: (owner: Owner, path: string) => void): unknown
  }
  companions(): Array<{ id: string; name: string }>
  /** An engine that can run a background chat right now (the API key is set, or another engine is chosen). */
  engineReady(): boolean
  snapshot(owner: Owner, path: string, text: string): void
  broadcast(pass: TidyPass): void
  ownChats: Set<string>
  now?(): number
}

export class TidyMemory {
  readonly #deps: TidyDeps
  readonly #now: () => number
  #state: TidyFile
  #timer: ReturnType<typeof setInterval> | null = null
  #running = false

  constructor(deps: TidyDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
    const raw = (readJson(deps.file) ?? {}) as Partial<TidyFile>
    const s = (raw.settings ?? {}) as Partial<TidySettings>
    this.#state = {
      settings: {
        enabled: s.enabled === true,
        afterHour: typeof s.afterHour === 'number' && Number.isInteger(s.afterHour) && s.afterHour >= 0 && s.afterHour <= 23 ? s.afterHour : DEFAULT_TIDY.afterHour,
      },
      passes: Array.isArray(raw.passes) ? raw.passes.filter((p) => p && typeof p.id === 'string') : [],
      lastRunAt: typeof raw.lastRunAt === 'number' ? raw.lastRunAt : null,
      lastPassAt: raw.lastPassAt && typeof raw.lastPassAt === 'object' ? raw.lastPassAt : {},
    }
    for (const p of this.#state.passes) if (p.chatId) deps.ownChats.add(p.chatId)
  }

  #save(): void {
    writeAtomic(this.#deps.file, JSON.stringify({ ...this.#state, passes: this.#state.passes.slice(0, KEEP_PASSES) }))
  }

  settings(): TidySettings {
    return { ...this.#state.settings }
  }

  update(patch: Partial<TidySettings>): TidySettings {
    const turningOn = patch.enabled === true && !this.#state.settings.enabled
    this.#state.settings = { ...this.#state.settings, ...patch }
    // Switching it on waits for tonight instead of tidying straight away.
    if (turningOn && this.#state.lastRunAt === null) this.#state.lastRunAt = this.#now()
    this.#save()
    return this.settings()
  }

  passes(limit = 50): TidyPass[] {
    return this.#state.passes.slice(0, limit)
  }

  schedule(): TidySchedule {
    const { enabled, afterHour } = this.#state.settings
    return {
      nextAt: enabled ? nextTidyAt(this.#now(), afterHour, this.#state.lastRunAt) : null,
      lastAt: this.#state.passes[0]?.at ?? null,
      running: this.#running,
    }
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.check(), CHECK_MS)
    this.#timer.unref?.()
    // A missed night runs soon after start, not in the middle of start-up.
    const first = setTimeout(() => void this.check(), 60_000)
    first.unref?.()
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /** Runs tonight's pass when it is due. */
  async check(): Promise<void> {
    const { enabled, afterHour } = this.#state.settings
    if (!enabled || this.#running || !isTidyDue(this.#now(), afterHour, this.#state.lastRunAt)) return
    await this.run()
  }

  runNow(companionId?: string): void {
    void this.run(companionId)
  }

  /** One pass for each companion with something new (or just `only`). Resolves with the passes recorded. */
  async run(only?: string): Promise<TidyPass[]> {
    if (this.#running) return []
    this.#running = true
    const recorded: TidyPass[] = []
    const record = (pass: TidyPass): void => {
      recorded.push(pass)
      this.#state.passes.unshift(pass)
      this.#save()
      this.#deps.broadcast(pass)
    }
    try {
      const startedAt = this.#now()
      let limited: string | null = null
      const companions = this.#deps.companions().filter((c) => !only || c.id === only)
      const all = this.#deps.chats.list()
      for (const companion of companions) {
        const since = this.#state.lastPassAt[companion.id] ?? startedAt - FIRST_LOOKBACK_MS
        let chats = eligibleChats(all, companion.id, this.#deps.ownChats).filter((c) => c.lastActiveAt > since)
        // Nothing new: no pass, no model call.
        if (chats.length === 0 && !only) continue
        const base = { id: randomUUID(), companionId: companion.id, chatId: null, at: this.#now(), notesChanged: 0 }
        if (!this.#deps.engineReady()) {
          record({ ...base, status: 'skipped', reason: mainT('chat.mainTidy.noEngineIsReady') })
          continue
        }
        if (limited) {
          record({ ...base, status: 'skipped', reason: limited })
          continue
        }
        // DC-17: chats the decision model is sure hold nothing lasting are left out (off: nothing is asked).
        let texts: Map<string, string> | undefined
        let skippedChats = 0
        if (chats.length > 0 && decider().active('memory')) {
          texts = new Map()
          const transcripts: Transcript[] = []
          for (const chat of chats) {
            try {
              const t = chatTranscript(chat, this.#deps.chats.load(chat.id).log, companion.name)
              transcripts.push(t)
              texts.set(chat.id, t.text)
            } catch {
              // An unreadable chat is left out of tonight's pass anyway.
            }
          }
          const skipped = await nothingToRemember(transcripts)
          skippedChats = skipped.size
          chats = chats.filter((c) => !skipped.has(c.id))
          // Every chat judged: nothing to tidy, no background chat, and the next night starts after them.
          // "Tidy now" for one companion still tidies its notes.
          if (skippedChats > 0 && transcripts.length === skippedChats && !only) {
            record({ ...base, status: 'skipped', reason: mainT('chat.mainTidy.nothingNewWorth'), skippedChats })
            this.#state.lastPassAt[companion.id] = startedAt
            continue
          }
        }
        const pass = await this.#pass(companion, chats, skippedChats > 0 ? { ...base, skippedChats } : base, texts)
        record(pass)
        // A failed pass leaves the mark where it was, so the next night reads these chats again.
        if (pass.status === 'ok') this.#state.lastPassAt[companion.id] = startedAt
        if (pass.status === 'skipped' && pass.reason) limited = pass.reason
      }
      if (!only) this.#state.lastRunAt = startedAt
      this.#save()
    } finally {
      this.#running = false
    }
    return recorded
  }

  async #pass(companion: { id: string; name: string }, chats: ChatSummary[], base: Omit<TidyPass, 'status'>, texts?: ReadonlyMap<string, string>): Promise<TidyPass> {
    const owner = companion.id
    const notes = this.#deps.memory.list(owner)
    for (const note of notes) {
      try {
        this.#deps.snapshot(owner, note.path, this.#deps.memory.read(note.path, owner))
      } catch (err) {
        log.warn('tidy', 'Could not keep a version before tidying', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    const transcripts: string[] = []
    let size = 0
    // Newest chats first, so a long day still covers what just happened.
    for (const chat of [...chats].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
      try {
        const text = texts?.get(chat.id) ?? chatTranscript(chat, this.#deps.chats.load(chat.id).log, companion.name).text
        if (size + text.length > CHATS_BUDGET) break
        transcripts.push(text)
        size += text.length
      } catch {
        // An unreadable chat is left out of tonight's pass.
      }
    }
    const changed = new Set<string>()
    const listener = (who: Owner, path: string): void => {
      if (who === owner) changed.add(path)
    }
    this.#deps.memory.on('changed', listener)
    try {
      const result = await this.#deps.host.runBackground({
        companionId: owner,
        prompt: tidyPrompt(transcripts, notes),
        kind: 'tidy',
        title: mainT('chat.mainTidy.tidyingSMemory', { name: companion.name }),
        capabilities: { memory: true, webTools: false, connectors: false },
      })
      if (result.chatId) this.#deps.ownChats.add(result.chatId)
      if (!result.ok) return { ...base, chatId: result.chatId, status: 'error', reason: mainT('chat.mainTidy.theTidyChatEnded', { status: result.status }), notesChanged: changed.size }
      return { ...base, chatId: result.chatId, status: 'ok', notesChanged: changed.size }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isRateLimit(message)) return { ...base, status: 'skipped', reason: mainT('chat.mainTidy.yourProviderSRate'), notesChanged: 0 }
      return { ...base, status: 'error', reason: message, notesChanged: changed.size }
    } finally {
      this.#deps.memory.off('changed', listener)
    }
  }
}
