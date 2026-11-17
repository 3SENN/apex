/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure rules behind @ mentions and # record search (CH-25, CH-08): where a
// trigger word starts and ends around the caret, how picking one rewrites
// the draft, which candidates a filter and query keep, and which mention
// tokens were typed away. No DOM, so it is unit-tested in node.

export type TriggerChar = '@' | '#'

export interface Trigger {
  char: TriggerChar
  /** What was typed after the trigger, up to the caret. */
  query: string
  /** Index of the trigger character. */
  start: number
  /** End of the trigger word (the caret may sit inside it). */
  end: number
}

/** Long words are text, not a search. */
const QUERY_MAX = 60

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)

/**
 * The @ or # word the caret is in, when that word starts with the trigger.
 * "@" counts only at the start of a word, so e-mail addresses and URL
 * fragments never open a list.
 */
export function triggerAt(text: string, caret: number): Trigger | null {
  if (caret < 1 || caret > text.length) return null
  let start = caret
  while (start > 0 && !isSpace(text[start - 1])) start--
  const char = text[start]
  if (char !== '@' && char !== '#') return null
  let end = caret
  while (end < text.length && !isSpace(text[end])) end++
  const query = text.slice(start + 1, caret)
  if (query.length > QUERY_MAX || /[@#]/.test(text.slice(start + 1, end))) return null
  return { char, query, start, end }
}

/** # searches only once something follows it ("# " is a heading, "#" alone nothing yet). */
export function recordQuery(trigger: Trigger | null): string | null {
  if (!trigger || trigger.char !== '#') return null
  const q = trigger.query.trim()
  return q.length >= 1 ? q : null
}

/**
 * Replaces the trigger word with `replacement` (a token like "@Docs", or ''
 * to drop it) and returns the new draft with the caret after it. A space
 * follows a token unless one is already there; dropping the word never
 * leaves a double space.
 */
export function replaceTrigger(text: string, trigger: Pick<Trigger, 'start' | 'end'>, replacement: string): { text: string; caret: number } {
  const before = text.slice(0, trigger.start)
  let after = text.slice(trigger.end)
  if (replacement === '') {
    if ((before === '' || before.endsWith(' ')) && after.startsWith(' ')) after = after.slice(1)
    return { text: before + after, caret: before.length }
  }
  const caret = before.length + replacement.length
  if (after.startsWith(' ')) return { text: before + replacement + after, caret: caret + 1 }
  if (after.startsWith('\n')) return { text: before + replacement + after, caret }
  return { text: `${before}${replacement} ${after}`, caret: caret + 1 }
}

export type MentionKind = 'tab' | 'chat' | 'companion' | 'connector'
export type MentionFilter = 'all' | MentionKind

export const MENTION_FILTERS: readonly MentionFilter[] = ['all', 'tab', 'chat', 'companion', 'connector']

export interface MentionCandidate {
  kind: MentionKind
  id: string
  label: string
  /** A second, muted part: the host of a tab, the companion of a chat. */
  detail?: string
  /** A tab's favicon. */
  icon?: string | null
}

const KIND_ORDER: Record<MentionKind, number> = { tab: 0, chat: 1, companion: 2, connector: 3 }

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** 0 when the label starts with the query, 1 when a word in it does, 2 for any other hit; null for no hit. */
function rank(candidate: MentionCandidate, query: string): number | null {
  if (!query) return 0
  const label = fold(candidate.label)
  if (label.startsWith(query)) return 0
  if (label.split(/[\s\-_.:/]+/).some((w) => w.startsWith(query))) return 1
  if (label.includes(query) || fold(candidate.detail ?? '').includes(query)) return 2
  return null
}

/**
 * The candidates a filter and query keep, best match first, kinds in their
 * filter order. "All" shows a few of each kind so one kind can't crowd out
 * the others.
 */
export function filterMentions(candidates: readonly MentionCandidate[], filter: MentionFilter, query: string, limit = filter === 'all' ? 12 : 30): MentionCandidate[] {
  const q = fold(query.trim())
  const hits: { c: MentionCandidate; r: number; i: number }[] = []
  candidates.forEach((c, i) => {
    if (filter !== 'all' && c.kind !== filter) return
    const r = rank(c, q)
    if (r !== null) hits.push({ c, r, i })
  })
  hits.sort((a, b) => (filter === 'all' ? KIND_ORDER[a.c.kind] - KIND_ORDER[b.c.kind] : 0) || a.r - b.r || a.i - b.i)
  if (filter !== 'all') return hits.slice(0, limit).map((h) => h.c)
  const perKind = Math.max(3, Math.ceil(limit / 4))
  const counts: Partial<Record<MentionKind, number>> = {}
  const out: MentionCandidate[] = []
  for (const h of hits) {
    const n = counts[h.c.kind] ?? 0
    if (n >= perKind) continue
    counts[h.c.kind] = n + 1
    out.push(h.c)
    if (out.length >= limit) break
  }
  return out
}

/** The next filter chip (Tab), or the previous one (⇧Tab). */
export function cycleFilter(filter: MentionFilter, direction: 1 | -1): MentionFilter {
  const i = MENTION_FILTERS.indexOf(filter)
  const n = MENTION_FILTERS.length
  return MENTION_FILTERS[(((i + direction) % n) + n) % n] ?? 'all'
}

/** The inline token a mention leaves in the draft. */
export function mentionToken(label: string): string {
  const clean = label.replace(/\s+/g, ' ').trim().slice(0, 60)
  return `@${clean || 'untitled'}`
}

/** Ids of mention attachments whose token is no longer in the draft (typed or cut away). */
export function orphanedTokens(text: string, tokens: ReadonlyMap<string, string>): string[] {
  const out: string[] = []
  for (const [id, token] of tokens) if (!text.includes(token)) out.push(id)
  return out
}

export type ListKey = { type: 'move'; active: number } | { type: 'pick'; index: number } | { type: 'filter'; direction: 1 | -1 } | { type: 'close' }

/**
 * A key in the composer while a mention or record list shows (the field
 * keeps focus). ↑ and ↓ move and wrap, Enter picks, Tab changes the mention
 * filter (or picks a record), Esc closes. Anything else types as usual.
 */
export function listKey(key: string, shift: boolean, count: number, active: number, withFilters: boolean): ListKey | null {
  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (count === 0) return null
      const step = key === 'ArrowDown' ? 1 : -1
      const from = active < 0 ? (step === 1 ? -1 : 0) : active
      return { type: 'move', active: (((from + step) % count) + count) % count }
    }
    case 'Enter':
      if (shift) return null
      return count > 0 && active >= 0 ? { type: 'pick', index: active } : null
    case 'Tab':
      if (withFilters) return { type: 'filter', direction: shift ? -1 : 1 }
      return count > 0 && active >= 0 ? { type: 'pick', index: active } : null
    case 'Escape':
      return { type: 'close' }
    default:
      return null
  }
}
