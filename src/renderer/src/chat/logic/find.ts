/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LogItem } from '../../agentLog'
import { markdownText, parseMarkdown } from './markdown'
import { stripSkillCommand } from './skillChip'

// Find in a chat (CH-37). The index covers the whole folded log, so messages
// that are not rendered yet (paging) still count and can be jumped to; the
// view then highlights the same occurrence inside the rendered message.

/** One searchable message: your text as sent, a reply's text as it renders. */
export interface FindEntry {
  itemId: string
  text: string
}

export interface FindMatch {
  itemId: string
  /** Which occurrence inside the message (0-based), for mapping onto the rendered text. */
  occurrence: number
  start: number
  end: number
}

/** Longest query searched; longer input is cut (a pasted paragraph). */
export const FIND_QUERY_MAX = 250

export function findEntries(items: readonly LogItem[]): FindEntry[] {
  const out: FindEntry[] = []
  for (const item of items) {
    if (item.kind === 'user') out.push({ itemId: item.id, text: item.skill ? stripSkillCommand(item.text, item.skill.name) : item.text })
    else if (item.kind === 'assistant' && item.text.trim()) out.push({ itemId: item.id, text: markdownText(parseMarkdown(item.text)) })
  }
  return out
}

const fold = (text: string): string => text.toLocaleLowerCase()

/** Non-overlapping, case-insensitive occurrences of `query` in `text`. */
export function occurrences(text: string, query: string): Array<[number, number]> {
  const q = fold(query.slice(0, FIND_QUERY_MAX))
  if (!q.trim()) return []
  const hay = fold(text)
  // Lowercasing can change lengths for a few scripts; fall back to exact matching then.
  const sameLength = hay.length === text.length
  const source = sameLength ? hay : text
  const needle = sameLength ? q : query.slice(0, FIND_QUERY_MAX)
  const out: Array<[number, number]> = []
  let from = 0
  while (from <= source.length - needle.length) {
    const at = source.indexOf(needle, from)
    if (at < 0) break
    out.push([at, at + needle.length])
    from = at + needle.length
  }
  return out
}

export function findMatches(entries: readonly FindEntry[], query: string): FindMatch[] {
  const out: FindMatch[] = []
  for (const entry of entries) {
    occurrences(entry.text, query).forEach(([start, end], occurrence) => out.push({ itemId: entry.itemId, occurrence, start, end }))
  }
  return out
}

/** The next or previous match, wrapping around; -1 when there is none. */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return -1
  if (current < 0) return direction === 1 ? 0 : total - 1
  return (current + direction + total) % total
}

/** After the query changes: the first match at or after the old one's message, so the view doesn't jump back to the top. */
export function nearestMatch(matches: readonly FindMatch[], entries: readonly FindEntry[], previousItemId: string | null): number {
  if (matches.length === 0) return -1
  if (!previousItemId) return matches.length - 1
  const order = new Map(entries.map((e, i) => [e.itemId, i]))
  const from = order.get(previousItemId) ?? 0
  const index = matches.findIndex((m) => (order.get(m.itemId) ?? 0) >= from)
  return index < 0 ? matches.length - 1 : index
}

/** "3 of 12", "No results" or nothing for an empty query. */
export function findCountLabel(current: number, total: number, query: string, words: { of: string; none: string }): string {
  if (!query.trim()) return ''
  if (total === 0) return words.none
  return `${current + 1} ${words.of} ${total}`
}

/** Most older pages find loads for one search (a very long chat stops there). */
export const FIND_PAGE_LIMIT = 60

/** Whether part of the saved log is not loaded yet (the log's paging: above 0, older pages can load). */
export const needsOlderPages = (logStart: number): boolean => logStart > 0

/**
 * The matches inside one message's rendered text, as [start, end) ranges:
 * what the view paints. A rendered message can differ from the folded text
 * (Markdown removed), so the view maps by occurrence, not by offset.
 */
export function highlightRanges(renderedText: string, query: string): Array<[number, number]> {
  return occurrences(renderedText, query)
}
