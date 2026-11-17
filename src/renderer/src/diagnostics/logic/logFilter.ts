/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { LOG_LEVELS, matchesLogQuery, type LogEntry, type LogLevel, type LogQuery } from '@shared/diagnostics'

// apex://logs filters and the list window: the
// query sent to main, live lines filtered the same way main filters, the
// copy text and the rows a virtualized list draws.

export interface LogFilterState {
  text: string
  /** Empty means every level. */
  levels: LogLevel[]
  /** '' means every source. */
  source: string
}

export const EMPTY_FILTER: LogFilterState = { text: '', levels: [], source: '' }
export const LOG_PAGE = 1000
/** Lines kept in the view; the oldest go first while the live tail runs. */
export const LOG_VIEW_MAX = 5000

/** Sources the menu always offers, before any line shows them. */
export const KNOWN_SOURCES = ['main', 'chrome', 'agent', 'crash', 'diagnostics', 'updates', 'routines', 'speech', 'migrations', 'system', 'i18n'] as const

export function toLogQuery(state: LogFilterState, page: { before?: number; limit?: number } = {}): LogQuery {
  const q: LogQuery = { limit: page.limit ?? LOG_PAGE }
  if (state.levels.length > 0 && state.levels.length < LOG_LEVELS.length) q.levels = [...state.levels]
  if (state.source) q.sources = [state.source]
  const text = state.text.trim()
  if (text) q.text = text.slice(0, 500)
  if (page.before !== undefined) q.before = page.before
  return q
}

export function isFiltered(state: LogFilterState): boolean {
  return state.text.trim() !== '' || state.levels.length > 0 || state.source !== ''
}

export function toggleLevel(levels: readonly LogLevel[], level: LogLevel): LogLevel[] {
  const next = levels.includes(level) ? levels.filter((l) => l !== level) : [...levels, level]
  // Keep the canonical order, so queries compare equal.
  return LOG_LEVELS.filter((l) => next.includes(l))
}

/** A live line appended when it matches; the oldest lines go past `max`. Null when it doesn't match. */
export function appendLive(list: readonly LogEntry[], entry: LogEntry, state: LogFilterState, max = LOG_VIEW_MAX): LogEntry[] | null {
  if (!matchesLogQuery(entry, toLogQuery(state))) return null
  const next = [...list, entry]
  return next.length > max ? next.slice(next.length - max) : next
}

/** Older lines in front of the current ones. */
export function prependOlder(older: readonly LogEntry[], current: readonly LogEntry[], max = LOG_VIEW_MAX): LogEntry[] {
  return [...older, ...current].slice(0, max)
}

/** Every source in the lines plus the known ones, sorted. */
export function sourcesOf(entries: readonly LogEntry[], known: readonly string[] = KNOWN_SOURCES): string[] {
  return [...new Set([...known, ...entries.map((e) => e.source)])].sort((a, b) => a.localeCompare(b))
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}

/** 14:03:07.120, in local time. */
export function formatTime(t: number): string {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** 2026-10-29 14:03:07.120 */
export function formatStamp(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(t)}`
}

export function dataText(entry: LogEntry): string {
  return Object.entries(entry.data ?? {})
    .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
    .join(' ')
}

/** One line of the copy text. */
export function formatLogLine(entry: LogEntry): string {
  const data = dataText(entry)
  return `${formatStamp(entry.t)} ${entry.level.toUpperCase().padEnd(5)} [${entry.source}] ${entry.message}${data ? ` ${data}` : ''}`
}

export function copyText(entries: readonly LogEntry[]): string {
  return entries.map(formatLogLine).join('\n')
}

/** The rows a fixed-height list draws for a scroll position, with some to spare either side. */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 8): { start: number; end: number } {
  if (count === 0 || rowHeight <= 0) return { start: 0, end: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight)
  const visible = Math.ceil(Math.max(0, viewport) / rowHeight) + 1
  return { start: Math.max(0, first - overscan), end: Math.min(count, first + visible + overscan) }
}

/** Near enough to the bottom that new live lines keep it pinned there. */
export function atBottom(scrollTop: number, viewport: number, scrollHeight: number, slack = 24): boolean {
  return scrollHeight - (scrollTop + viewport) <= slack
}

/** The next selected row for a key, or null when the key doesn't move it. */
export function moveSelection(key: string, current: number | null, count: number, pageRows: number): number | null {
  if (count === 0) return null
  const at = current ?? count - 1
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, current === null ? count - 1 : at + 1)
    case 'ArrowUp':
      return Math.max(0, current === null ? count - 1 : at - 1)
    case 'PageDown':
      return Math.min(count - 1, at + pageRows)
    case 'PageUp':
      return Math.max(0, at - pageRows)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}
