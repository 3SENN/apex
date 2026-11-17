/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './settings'

export interface HistoryEntry {
  url: string
  title: string
  visits: number
  lastVisit: number
  /** SH-35: times the address was typed or picked in the command bar. */
  typed?: number
  /** The latest visit times, newest last, for the week count of inline completion. */
  visitTimes?: number[]
}

const MAX_ENTRIES = 5000
const VISIT_TIMES_KEPT = 10
const PICKS_MAX = 500
const SAVE_DELAY_MS = 1500
const DAY_MS = 86_400_000

function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/i, '')
}

/** Scores history entries against omnibox input; higher is better. */
export function rankHistory(entries: Iterable<HistoryEntry>, query: string, now: number, limit = 6): HistoryEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: Array<{ entry: HistoryEntry; score: number }> = []
  for (const entry of entries) {
    const url = displayUrl(entry.url).toLowerCase()
    const title = entry.title.toLowerCase()
    let match = 0
    if (url.startsWith(q)) match = 100
    else if (title.startsWith(q)) match = 60
    else if (title.split(/\s+/).some((word) => word.startsWith(q))) match = 40
    else if (url.includes(q)) match = 25
    else if (title.includes(q)) match = 20
    if (match === 0) continue
    const ageDays = Math.max(0, (now - entry.lastVisit) / DAY_MS)
    const score = match + Math.log2(1 + entry.visits) * 10 + Math.max(0, 30 - ageDays)
    scored.push({ entry, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.entry)
}

let current: HistoryStore | null = null

/** The store the bootstrap built; the address feature reads the same instance through here. */
export function historyStore(): HistoryStore | null {
  return current
}

/** How the command bar remembers a pick: the input as typed, folded. */
export function pickKey(input: string): string {
  return input.trim().toLowerCase()
}

// 'recorded', 'removed' and 'cleared' feed the search index, visits log and timeline.
export class HistoryStore extends EventEmitter<{ recorded: [url: string, title: string, at: number]; removed: [url: string]; cleared: [] }> {
  readonly #path: string
  readonly #entries = new Map<string, HistoryEntry>()
  #saveTimer: NodeJS.Timeout | null = null
  // What was picked in the command bar for an input, so the same input completes to it for a day.
  readonly #picksPath: string
  readonly #picks = new Map<string, { url: string; at: number }>()
  /** Typed addresses that haven't loaded yet; record() counts them when the visit lands. */
  readonly #pendingTyped = new Set<string>()

  constructor(dataDir: string) {
    super()
    this.#path = join(dataDir, 'history.json')
    this.#picksPath = join(dataDir, 'omnibox-picks.json')
    current = this
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#picksPath, 'utf8'))
      if (raw && typeof raw === 'object') {
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          const v = value as { url?: unknown; at?: unknown }
          if (typeof v?.url === 'string' && typeof v.at === 'number') this.#picks.set(key, { url: v.url, at: v.at })
        }
      }
    } catch {
      // No picks yet.
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (isEntry(item)) this.#entries.set(item.url, item)
        }
      }
    } catch {
      // First run, or an unreadable file: start empty.
    }
  }

  record(url: string, title: string): void {
    if (!/^https?:/i.test(url)) return
    const existing = this.#entries.get(url)
    this.#entries.delete(url)
    const at = Date.now()
    const typed = (existing?.typed ?? 0) + (this.#pendingTyped.delete(url) ? 1 : 0)
    this.#entries.set(url, {
      url,
      title: title || existing?.title || '',
      visits: (existing?.visits ?? 0) + 1,
      lastVisit: at,
      ...(typed > 0 ? { typed } : {}),
      visitTimes: [...(existing?.visitTimes ?? []), at].slice(-VISIT_TIMES_KEPT),
    })
    this.#trim()
    this.#scheduleSave()
    this.emit('recorded', url, title || existing?.title || '', at)
  }

  updateTitle(url: string, title: string): void {
    const entry = this.#entries.get(url)
    if (!entry || !title || entry.title === title) return
    entry.title = title
    this.#scheduleSave()
  }


  /** An address was typed (or picked) in the command bar; the visit that follows counts it. */
  noteTyped(url: string): void {
    const entry = this.#entries.get(url)
    if (entry) {
      entry.typed = (entry.typed ?? 0) + 1
      this.#scheduleSave()
    } else {
      this.#pendingTyped.add(url)
      if (this.#pendingTyped.size > 50) this.#pendingTyped.delete(this.#pendingTyped.values().next().value as string)
    }
  }

  /** Remembers which address an input led to (SH-35's "picked for this same query in the last day"). */
  notePick(input: string, url: string, at = Date.now()): void {
    const key = pickKey(input)
    if (!key || !/^https?:/i.test(url)) return
    this.#picks.delete(key)
    this.#picks.set(key, { url, at })
    while (this.#picks.size > PICKS_MAX) this.#picks.delete(this.#picks.keys().next().value as string)
    this.#scheduleSave()
  }

  /** The address picked for this input within the last day, if any. */
  pickFor(input: string, now = Date.now()): string | null {
    const pick = this.#picks.get(pickKey(input))
    return pick && now - pick.at <= DAY_MS ? pick.url : null
  }

  get(url: string): HistoryEntry | undefined {
    return this.#entries.get(url)
  }

  /** Every entry, least recently visited first. */
  entries(): IterableIterator<HistoryEntry> {
    return this.#entries.values()
  }

  suggest(query: string): HistoryEntry[] {
    return rankHistory(this.#entries.values(), query, Date.now())
  }

  /** Most recent first; with a query, ranked like the omnibox. */
  search(query: string, limit: number): HistoryEntry[] {
    if (query.trim()) return rankHistory(this.#entries.values(), query, Date.now(), limit)
    return [...this.#entries.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, limit)
  }

  remove(url: string): void {
    // A removed page stops completing too.
    for (const [key, pick] of this.#picks) if (pick.url === url) this.#picks.delete(key)
    if (!this.#entries.delete(url)) return
    this.#scheduleSave()
    this.emit('removed', url)
  }

  clear(): void {
    this.#entries.clear()
    this.#picks.clear()
    this.#pendingTyped.clear()
    this.flush()
    this.emit('cleared')
  }

  /** Merges imported entries, keeping the higher visit count and latest visit. */
  importMany(items: HistoryEntry[]): number {
    let added = 0
    for (const item of items) {
      if (!/^https?:/i.test(item.url)) continue
      const existing = this.#entries.get(item.url)
      if (!existing) added++
      this.#entries.set(item.url, {
        ...existing,
        url: item.url,
        title: existing?.title || item.title,
        visits: Math.max(existing?.visits ?? 0, item.visits),
        lastVisit: Math.max(existing?.lastVisit ?? 0, item.lastVisit),
      })
    }
    // Keep the most recently visited entries when over the cap.
    const sorted = [...this.#entries.values()].sort((a, b) => a.lastVisit - b.lastVisit)
    this.#entries.clear()
    for (const entry of sorted.slice(-MAX_ENTRIES)) this.#entries.set(entry.url, entry)
    this.#scheduleSave()
    return added
  }

  flush(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer)
    this.#saveTimer = null
    writeAtomic(this.#path, JSON.stringify([...this.#entries.values()]))
    writeAtomic(this.#picksPath, JSON.stringify(Object.fromEntries(this.#picks)))
  }

  #trim(): void {
    // Map iteration is insertion order and record() re-inserts on visit, so
    // the first keys are the least recently visited.
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return
    this.#saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS)
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v.typed !== undefined && typeof v.typed !== 'number') delete v.typed
  if (v.visitTimes !== undefined && !(Array.isArray(v.visitTimes) && v.visitTimes.every((t) => typeof t === 'number'))) delete v.visitTimes
  return typeof v.url === 'string' && typeof v.title === 'string' && typeof v.visits === 'number' && typeof v.lastVisit === 'number'
}
