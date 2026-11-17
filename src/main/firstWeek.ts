/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AUTO_ITEMS,
  FIRST_WEEK_GLYPHS,
  FIRST_WEEK_HUES,
  FIRST_WEEK_VERSION,
  HIDE_NOTE_MAX,
  HIDE_REASONS,
  STARTERS_MAX,
  STICKY_SIGNALS,
  dismissAllUnlocksAt,
  nextMorning,
  orderPlan,
  planItems,
  type AutoItemId,
  type FirstWeekHideReason,
  type FirstWeekSignals,
  type FirstWeekView,
  type StarterChat,
} from '@shared/firstWeek'
import { writeAtomic } from './settings'
import { mainT } from './i18n/mainT'

// The getting-started record (userData/first-week.json): created when setup
// finishes, versioned and schema-checked on every load. A file that can't be
// used (unreadable, invalid, or from a newer Apex) is kept aside as
// first-week.invalid.json and started over, and the page says so once.

export const ITEM_ID = new RegExp(`^(s[1-${STARTERS_MAX}]|${AUTO_ITEMS.join('|')})$`)
const itemId = z.string().regex(ITEM_ID)
const time = z.number().int().nonnegative()

const starterSchema = z.object({
  id: z.string().regex(/^s[1-9]$/),
  title: z.string().min(1).max(80),
  description: z.string().max(160),
  prompt: z.string().min(1).max(1000),
  glyph: z.enum(FIRST_WEEK_GLYPHS),
  hue: z.enum(FIRST_WEEK_HUES),
}).strict()

export const recordSchema = z.object({
  version: z.literal(FIRST_WEEK_VERSION),
  createdAt: time,
  /** Off after "Hide getting started"; the reason is kept with it. */
  enabled: z.boolean(),
  hidden: z.object({ reason: z.enum(HIDE_REASONS), note: z.string().max(HIDE_NOTE_MAX), at: time }).strict().nullable(),
  snoozedUntil: time.nullable(),
  /** When the page opened itself as a tab after setup (it does that once). */
  autoOpenedAt: time.nullable(),
  completed: z.record(itemId, time),
  dismissed: z.record(itemId, time),
  starters: z.object({
    source: z.enum(['personal', 'curated']),
    at: time,
    /** A personal set was attempted; it is never retried after that. */
    personalTried: z.boolean(),
    items: z.array(starterSchema).max(STARTERS_MAX),
  }).strict().nullable(),
  /** Companion id to a fingerprint of how it looked when setup finished. */
  baseline: z.record(z.string().max(128), z.string().max(32)),
}).strict()

export type FirstWeekRecord = z.infer<typeof recordSchema>

/** What can be observed live; import and companion changes are tracked by the store itself. */
export type LiveSignals = Pick<FirstWeekSignals, 'default-browser' | 'connect-app' | 'set-up-routine' | 'try-dictation'>

export interface CompanionFingerprint {
  id: string
  fingerprint: string
}

export interface FirstWeekDeps {
  live(): LiveSignals
  /** Every companion as it is now. */
  companions(): CompanionFingerprint[]
  /** Setup has finished (settings.onboarded). Records for people who finished it before this page existed are created on first view. */
  onboarded(): boolean
  /** Writes personal starters; null when there is no key or the call failed. Omitted: curated only. */
  personalStarters?: (signal: AbortSignal) => Promise<StarterChat[] | null>
  curatedStarters(): StarterChat[]
  now?: () => number
}

/** A short stable hash (FNV-1a) of what makes a companion look and act like itself. */
export function companionFingerprint(c: { name: string; persona: string; look: unknown; instructions: string }): string {
  const text = JSON.stringify([c.name, c.persona, c.look, c.instructions])
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Customised: a companion changed since setup, or a new one was added. */
export function companionCustomised(baseline: Readonly<Record<string, string>>, now: readonly CompanionFingerprint[]): boolean {
  return now.some((c) => baseline[c.id] !== c.fingerprint)
}

export type LoadResult = { record: FirstWeekRecord | null; notice: string | null }

/** Reads a record from disk; `notice` is set when the file existed but couldn't be used. */
export function readRecord(text: string | null): LoadResult {
  if (text === null) return { record: null, notice: null }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { record: null, notice: mainT('firstRun.mainFirstWeek.yourGettingStartedProgress') }
  }
  const version = raw && typeof raw === 'object' ? (raw as { version?: unknown }).version : undefined
  if (typeof version === 'number' && version > FIRST_WEEK_VERSION) {
    return { record: null, notice: mainT('firstRun.mainFirstWeek.yourGettingStartedProgress2') }
  }
  const parsed = recordSchema.safeParse(raw)
  if (!parsed.success) return { record: null, notice: mainT('firstRun.mainFirstWeek.yourGettingStartedProgress3') }
  return { record: parsed.data, notice: null }
}

export class FirstWeekStore extends EventEmitter<{ changed: [FirstWeekView] }> {
  readonly #path: string
  readonly #deps: FirstWeekDeps
  #record: FirstWeekRecord | null
  #notice: string | null
  #personalizing: AbortController | null = null

  constructor(dataDir: string, deps: FirstWeekDeps) {
    super()
    this.#path = join(dataDir, 'first-week.json')
    this.#deps = deps
    const text = existsSync(this.#path) ? safeRead(this.#path) : null
    const { record, notice } = readRecord(text)
    this.#record = record
    this.#notice = notice
    if (notice) {
      // Keep the unusable file for diagnosis, then start over.
      if (text !== null) writeAtomic(join(dataDir, 'first-week.invalid.json'), text)
      if (this.#deps.onboarded()) {
        this.#record = this.#fresh()
        this.#save()
      } else rmSync(this.#path, { force: true })
    }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  #fresh(): FirstWeekRecord {
    const now = this.#now()
    return {
      version: FIRST_WEEK_VERSION,
      createdAt: now,
      enabled: true,
      hidden: null,
      snoozedUntil: null,
      autoOpenedAt: null,
      completed: {},
      dismissed: {},
      starters: { source: 'curated', at: now, personalTried: false, items: this.#deps.curatedStarters() },
      baseline: Object.fromEntries(this.#deps.companions().map((c) => [c.id, c.fingerprint])),
    }
  }

  #save(): void {
    if (this.#record) writeAtomic(this.#path, JSON.stringify(this.#record, null, 2))
  }

  /** The record, creating it for people who finished setup before the page existed. */
  #ensure(): FirstWeekRecord | null {
    if (!this.#record && this.#deps.onboarded()) {
      this.#record = this.#fresh()
      // They already saw setup end; the page only opens on its own right after it.
      this.#record.autoOpenedAt = this.#record.createdAt
      this.#save()
      this.#personalize()
    }
    return this.#record
  }

  #signals(record: FirstWeekRecord): FirstWeekSignals {
    return {
      ...this.#deps.live(),
      'import-data': Object.hasOwn(record.completed, 'import-data'),
      // Observed elsewhere (meeting-transcribed, artifact-built) and kept done once signalled.
      'record-meeting': Object.hasOwn(record.completed, 'record-meeting'),
      'build-artifact': Object.hasOwn(record.completed, 'build-artifact'),
      // NT-01: the address feature's web-searched signal (a new tab searched or went to a typed site).
      'search-web': Object.hasOwn(record.completed, 'search-web'),
      'customise-companion': companionCustomised(record.baseline, this.#deps.companions()),
    }
  }

  /** Records sticky signals as done, so they stay done (deleting the connector later doesn't undo the step). */
  #recordSignals(record: FirstWeekRecord, signals: FirstWeekSignals): boolean {
    let changed = false
    for (const id of STICKY_SIGNALS) {
      if (signals[id] && !Object.hasOwn(record.completed, id)) {
        record.completed[id] = this.#now()
        changed = true
      }
    }
    return changed
  }

  /** The page's state. Reruns every check (the default-browser one is live). */
  view(): FirstWeekView {
    const record = this.#ensure()
    const now = this.#now()
    if (!record) {
      return { status: 'not-created', notice: null, items: [], done: 0, total: 0, createdAt: null, snoozedUntil: null, dismissAllAt: null, canDismissAll: false, personalizing: false, startersSource: null, hiddenReason: null }
    }
    const signals = this.#signals(record)
    if (this.#recordSignals(record, signals)) this.#save()
    const all = planItems({ starters: record.starters?.items ?? [], completed: record.completed, dismissed: {}, signals })
    const items = orderPlan(all.filter((i) => !Object.hasOwn(record.dismissed, i.id)))
    const dismissAllAt = dismissAllUnlocksAt(record.createdAt)
    return {
      status: this.#notice ? 'invalid' : record.enabled ? 'ready' : 'off',
      notice: this.#notice,
      items,
      done: all.filter((i) => i.done).length,
      total: all.length,
      createdAt: record.createdAt,
      snoozedUntil: record.snoozedUntil !== null && record.snoozedUntil > now ? record.snoozedUntil : null,
      dismissAllAt,
      canDismissAll: now >= dismissAllAt && items.length > 0,
      personalizing: this.#personalizing !== null,
      startersSource: record.starters?.source ?? null,
      hiddenReason: record.enabled ? null : (record.hidden?.reason ?? null),
    }
  }

  /** Called when setup finishes. Returns true the one time the page should open as a tab. */
  setupFinished(): boolean {
    if (!this.#record) {
      this.#record = this.#fresh()
      this.#notice = null
    }
    const open = this.#record.autoOpenedAt === null
    if (open) this.#record.autoOpenedAt = this.#now()
    this.#save()
    this.#personalize()
    this.#emit()
    return open
  }

  /** A completion Apex observed elsewhere (an import that brought something over). */
  signal(id: AutoItemId): void {
    const record = this.#ensure()
    if (!record || Object.hasOwn(record.completed, id)) return
    record.completed[id] = this.#now()
    this.#save()
    this.#emit()
  }

  /** Something a signal depends on changed (connectors, routines, companions): push a fresh view. */
  refresh(): void {
    if (this.#record) this.#emit()
  }

  /** Starters are marked by hand (opening one marks it too). */
  setDone(id: string, done: boolean): FirstWeekView {
    return this.#mutate((record) => {
      itemId.parse(id)
      if (done) record.completed[id] ??= this.#now()
      else delete record.completed[id]
    })
  }

  dismiss(id: string): FirstWeekView {
    return this.#mutate((record) => {
      itemId.parse(id)
      record.dismissed[id] ??= this.#now()
    })
  }

  restore(id: string): FirstWeekView {
    return this.#mutate((record) => {
      itemId.parse(id)
      delete record.dismissed[id]
    })
  }

  /** Clears every remaining card; allowed from 30 days after setup. */
  dismissAll(): FirstWeekView {
    return this.#mutate((record) => {
      if (this.#now() < dismissAllUnlocksAt(record.createdAt)) throw new Error('Dismiss all becomes available 30 days after setup.')
      const now = this.#now()
      for (const item of this.view().items) record.dismissed[item.id] ??= now
    })
  }

  /** Hides the plan until 9:00 tomorrow, local time. */
  snooze(): FirstWeekView {
    return this.#mutate((record) => {
      record.snoozedUntil = nextMorning(this.#now())
    })
  }

  unsnooze(): FirstWeekView {
    return this.#mutate((record) => {
      record.snoozedUntil = null
    })
  }

  /** Switches the plan off and records why. */
  hide(reason: FirstWeekHideReason, note = ''): FirstWeekView {
    return this.#mutate((record) => {
      record.enabled = false
      record.hidden = { reason, note: note.trim().slice(0, HIDE_NOTE_MAX), at: this.#now() }
    })
  }

  /** Switches it back on; the reason it was hidden stays on record. */
  show(): FirstWeekView {
    return this.#mutate((record) => {
      record.enabled = true
      record.snoozedUntil = null
    })
  }

  /** The reset notice has been seen. */
  acknowledge(): FirstWeekView {
    this.#notice = null
    this.#emit()
    return this.view()
  }

  dispose(): void {
    this.#personalizing?.abort()
  }

  #mutate(change: (record: FirstWeekRecord) => void): FirstWeekView {
    const record = this.#ensure()
    if (!record) throw new Error('Getting started appears once setup has finished.')
    change(record)
    this.#save()
    this.#emit()
    return this.view()
  }

  #emit(): void {
    this.emit('changed', this.view())
  }

  /**
   * Replaces the curated starters with personal ones, once. It never runs
   * after a starter was opened or put aside, so cards don't change under you.
   */
  #personalize(): void {
    const record = this.#record
    const write = this.#deps.personalStarters
    if (!record || !write || this.#personalizing || record.starters?.personalTried) return
    const touched = (record.starters?.items ?? []).some((s) => Object.hasOwn(record.completed, s.id) || Object.hasOwn(record.dismissed, s.id))
    if (touched) return
    const abort = new AbortController()
    this.#personalizing = abort
    this.#emit()
    void write(abort.signal).then(
      (starters) => this.#finishPersonal(record, starters),
      () => this.#finishPersonal(record, null),
    )
  }

  #finishPersonal(record: FirstWeekRecord, starters: StarterChat[] | null): void {
    this.#personalizing = null
    // The record may have been reset or replaced meanwhile.
    if (record !== this.#record) return
    const touched = (record.starters?.items ?? []).some((s) => Object.hasOwn(record.completed, s.id) || Object.hasOwn(record.dismissed, s.id))
    const now = this.#now()
    if (starters && starters.length > 0 && !touched) {
      record.starters = { source: 'personal', at: now, personalTried: true, items: starters.slice(0, STARTERS_MAX) }
    } else if (record.starters) {
      // No key yet keeps the door open: a key added later can still personalise.
      record.starters.personalTried = starters !== null || touched
    }
    this.#save()
    this.#emit()
  }

  /** Tries the personal starters again if they were never written (for example, a key was added after setup). */
  retryPersonal(): void {
    this.#personalize()
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    // Unreadable counts as damaged, not as missing.
    return '\u0000'
  }
}
