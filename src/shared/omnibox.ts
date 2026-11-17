/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Command-bar rows and providers. The built-in groups register through
// the same provider API as the others (such as "search everything"). The
// pure ranking, highlighting, inline completion and dedupe live here too, so
// main's providers and the tests share them.
import type { CommandId } from './shortcuts'

export type OmniboxAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'switch-tab'; tabId: string }
  | { kind: 'command'; id: CommandId }
  | { kind: 'open-internal'; url: string }
  | { kind: 'ask'; text: string }
  /** A pack's command (docs/packs.md): main runs it in the window that committed it. */
  | { kind: 'pack'; packId: string; commandId: string }
  /** A website saved as an app (WA-01): back to its tab, else a new one. */
  | { kind: 'web-app'; appId: string }

export interface OmniboxRow {
  id: string
  group: string
  title: string
  subtitle?: string
  icon?: string
  /** Highlighted [start, end) ranges in `title`. */
  match?: [number, number][]
  action: OmniboxAction
  /** History rows: the row's ✕ removes the page from history. */
  removable?: boolean
  /** The address the row stands for (dedupe, removal and the ⌘C value). */
  url?: string
  /** A pinned tab ranks above other tabs. */
  pinned?: boolean
}

export interface OmniboxQueryContext {
  windowId: number
  profileId?: string
  signal: AbortSignal
}

export interface OmniboxProvider {
  id: string
  group: string
  order: number
  maxRows: number
  query(text: string, ctx: OmniboxQueryContext): Promise<OmniboxRow[]>
}

/** One group of rows as the command bar shows it. */
export interface OmniboxGroup {
  group: string
  rows: OmniboxRow[]
}


/** The built-in groups, in the order the bar shows them (SH-35). */
export const OMNIBOX_GROUPS = {
  typed: 'typed',
  top: 'top',
  ask: 'ask',
  suggest: 'suggest',
  tabs: 'tabs',
  bookmarks: 'bookmarks',
  history: 'history',
  commands: 'commands',
  settings: 'settings',
  // Universal search only.
  chats: 'chats',
  pages: 'pages',
  /** Packs' commands (docs/packs.md). */
  packs: 'packs',
  /** Websites saved as apps (WA-01). */
  apps: 'apps',
} as const

export type UniversalFilter = 'all' | 'tabs' | 'chats' | 'pages'

/** What the field completes to inline (SH-35): the typed text plus the rest of `text`. */
export interface OmniboxCompletion {
  /** The input it completes. */
  input: string
  /** The full field text with the completion: starts with `input` unless `typo`. */
  text: string
  url: string
  /** One typo on the host was tolerated: the field shows a hint instead of rewriting what you typed. */
  typo: boolean
}

/** What committing a row or the typed text did. `ask` is left to the chrome (it owns the composer). */
export type OmniboxCommitResult = { ok: true; ask?: string } | { ok: false; error: string }

export const DAY_MS = 86_400_000

/** An address the way people type it: no scheme, no www, no trailing slash. */
export function typedForm(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '')
}

/** Every case-insensitive occurrence of each word of `query` in `text`, merged. Word starts only when `wordStarts`. */
export function matchRanges(text: string, query: string, wordStarts = false): [number, number][] {
  const lower = text.toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const ranges: [number, number][] = []
  for (const word of words) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(word, from)
      if (at === -1) break
      const atStart = at === 0 || /[^a-z0-9]/i.test(lower[at - 1] ?? '')
      if (!wordStarts || atStart) ranges.push([at, at + word.length])
      from = at + 1
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}

/** How well a title and address match the input: 0 is no match; prefixes beat word starts beat anywhere. */
export function textScore(title: string, url: string, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const address = typedForm(url).toLowerCase()
  const name = title.toLowerCase()
  if (address.startsWith(q)) return 100
  if (name.startsWith(q)) return 70
  const words = q.split(/\s+/)
  const all = (hay: string, starts: boolean): boolean =>
    words.every((w) => (starts ? hay.split(/[^a-z0-9]+/i).some((part) => part.startsWith(w)) : hay.includes(w)))
  if (all(name, true)) return 55
  if (all(address, true)) return 45
  if (all(address, false)) return 25
  if (all(name, false)) return 20
  return 0
}

export interface VisitStats {
  url: string
  visits: number
  lastVisit: number
  /** Times the address was typed or picked from the bar. */
  typed?: number
  /** Recent visit times, newest last (at most a few). */
  visitTimes?: number[]
}

/** A history entry's score for an input: match, frequency and recency (a day-old visit counts most). */
export function frecency(stats: VisitStats, matchScore: number, now: number): number {
  if (matchScore === 0) return 0
  const ageDays = Math.max(0, (now - stats.lastVisit) / DAY_MS)
  const recency = Math.max(0, 30 - ageDays)
  return matchScore + Math.log2(1 + stats.visits) * 10 + recency + Math.min(5, stats.typed ?? 0) * 6
}

/**
 * Only strong candidates complete inline (SH-35): three or more visits in the
 * last week, typed often (twice or more), or picked for this same input in
 * the last day.
 */
export function isStrongCandidate(stats: VisitStats, now: number, pickedForInput = false): boolean {
  if (pickedForInput) return true
  const week = (stats.visitTimes ?? []).filter((t) => now - t <= 7 * DAY_MS).length
  return week >= 3 || (stats.typed ?? 0) >= 2
}

/** True when `a` and `b` differ by at most one edit (insert, delete, substitute or swap of neighbours). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    const diffs: number[] = []
    for (let i = 0; i < la; i++) if (a[i] !== b[i]) diffs.push(i)
    if (diffs.length === 1) return true
    const [x, y] = diffs
    return diffs.length === 2 && x !== undefined && y === x + 1 && a[x] === b[y] && a[y] === b[x]
  }
  const [short, long] = la < lb ? [a, b] : [b, a]
  let i = 0
  while (i < short.length && short[i] === long[i]) i++
  return short.slice(i) === long.slice(i + 1)
}

/**
 * The inline completion for `input` among candidates (best first), or null.
 * An exact prefix of the typed form completes in place; a host with one typo
 * (at least four characters typed) completes as a hint.
 */
export function inlineCompletion(input: string, candidates: readonly { url: string; strong: boolean }[]): OmniboxCompletion | null {
  const typed = input.trim()
  if (typed.length < 1 || /\s/.test(typed) || /^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) return null
  const lower = typed.toLowerCase()
  const strong = candidates.filter((c) => c.strong)
  for (const c of strong) {
    const form = typedForm(c.url)
    if (form.toLowerCase().startsWith(lower) && form.length > typed.length) return { input: typed, text: typed + form.slice(typed.length), url: c.url, typo: false }
  }
  if (lower.length < 4 || lower.includes('/')) return null
  for (const c of strong) {
    const host = typedForm(c.url).split('/')[0]?.toLowerCase() ?? ''
    // What was typed already starts this host: that is no typo.
    if (host.startsWith(lower)) continue
    // Compare against the host's start at the typed length (±1 for an insert or a drop).
    for (const len of [lower.length, lower.length - 1, lower.length + 1]) {
      if (len < 3 || len > host.length) continue
      if (host.slice(0, len) !== lower && withinOneEdit(lower, host.slice(0, len))) return { input: typed, text: typedForm(c.url), url: c.url, typo: true }
    }
  }
  return null
}

/** Drops rows whose address an earlier group already shows; the typed row stays. */
export function dedupeGroups(groups: readonly OmniboxGroup[]): OmniboxGroup[] {
  const seen = new Set<string>()
  const out: OmniboxGroup[] = []
  for (const group of groups) {
    const rows = group.rows.filter((row) => {
      const key = row.url ?? (row.action.kind === 'navigate' || row.action.kind === 'open-internal' ? row.action.url : null)
      if (!key || group.group === OMNIBOX_GROUPS.typed || group.group === OMNIBOX_GROUPS.suggest || group.group === OMNIBOX_GROUPS.ask) return true
      const norm = typedForm(key).toLowerCase()
      if (seen.has(norm)) return false
      seen.add(norm)
      return true
    })
    if (rows.length > 0) out.push({ group: group.group, rows })
  }
  return out
}

/** The rows in display order, for keyboard movement. */
export function flattenGroups(groups: readonly OmniboxGroup[]): OmniboxRow[] {
  return groups.flatMap((g) => g.rows)
}

/** Tab and ⇧Tab, ↑ and ↓: the next selection; -1 means the typed text itself (↑ from the first row). */
export function stepSelection(current: number, count: number, delta: 1 | -1, wrap: boolean): number {
  if (count === 0) return -1
  const next = current + delta
  if (next < -1) return wrap ? count - 1 : -1
  if (next >= count) return wrap ? -1 : count - 1
  return next
}

/** ⌘C in the field: a whole address when the selection is the untouched address, the selected text otherwise. */
export function copyValue(fieldText: string, selection: [number, number], originalUrl: string): string {
  const [start, end] = selection
  const selected = fieldText.slice(start, end)
  if (start === 0 && end === fieldText.length && originalUrl && (fieldText === originalUrl || fieldText === typedForm(originalUrl) || safeDecode(originalUrl) === fieldText)) return originalUrl
  return selected
}

/** The first row index of the group before or after `index`'s group. */
export function groupJump(groups: readonly OmniboxGroup[], index: number, delta: 1 | -1): number {
  const starts: number[] = []
  let at = 0
  for (const g of groups) {
    if (g.rows.length === 0) continue
    starts.push(at)
    at += g.rows.length
  }
  if (starts.length === 0) return -1
  let current = 0
  for (let i = 0; i < starts.length; i++) if ((starts[i] ?? 0) <= index) current = i
  const next = Math.min(starts.length - 1, Math.max(0, current + delta))
  return starts[next] ?? 0
}

function safeDecode(url: string): string {
  try {
    return decodeURI(url)
  } catch {
    return url
  }
}
