/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chrome's side of activity memory, the timeline and memory upkeep:
// labels, choices and calendar arithmetic, kept pure for tests.
import { ACTIVITY_ITEM_KINDS, localDayBounds, localDayKey, nextLocalMidnight, startOfLocalDay, type ActivityItemKind, type ActivityStatus, type MemoryJob, type TidyPass } from '@shared/activity'
import type { MessageKey } from '@shared/i18n/core'
import type { MenuRow } from '../chat/logic/addMenu'

type T = (key: MessageKey, vars?: Record<string, string | number>) => string

/** Day chips run Monday to Sunday; values are Date#getDay numbers. */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

export const PAUSE_CHOICES = [15, 60, 180, 'today'] as const
export type PauseChoice = (typeof PAUSE_CHOICES)[number]

export const PAUSE_KEYS: Record<PauseChoice, MessageKey> = {
  15: 'memory.activity.pause15',
  60: 'memory.activity.pause60',
  180: 'memory.activity.pause180',
  today: 'memory.activity.pauseToday',
}

/** Retention can be shortened from the defaults (30, 90, until deleted), and set back. */
export const RETENTION_CHOICES = {
  screenshotsDays: [1, 7, 14, 30],
  capturesDays: [7, 30, 60, 90],
  notesDays: [null, 365, 90, 30],
} as const

export const STATE_KEYS: Record<ActivityStatus['state'], MessageKey> = {
  off: 'memory.activity.state.off',
  capturing: 'memory.activity.state.capturing',
  'outside-hours': 'memory.activity.state.outside',
  paused: 'memory.activity.state.paused',
}

/** A one-letter chip label for a weekday in the current locale. */
export function dayLetter(day: number, locale?: string): string {
  // 2026-11-01 is a Sunday; add the day number to land on that weekday.
  return new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(new Date(2026, 10, 1 + day))
}

export function toggleDay(days: readonly number[], day: number): number[] {
  return (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]).sort((a, b) => a - b)
}

/** "09:00"; the end of the day reads "24:00". */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/** A time as a clock, with the weekday when it isn't today. */
export function whenLabel(at: number, now: number, locale?: string): string {
  const time = new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (startOfLocalDay(at) === startOfLocalDay(now)) return time
  return `${new Date(at).toLocaleDateString(locale, { weekday: 'short' })} ${time}`
}

/** The status line: "Capturing", "Paused until 14:30", "Outside your hours". */
export function statusLine(status: ActivityStatus, now: number, t: T): string {
  const label = t(STATE_KEYS[status.state])
  const until = status.state === 'paused' ? status.pausedUntil : status.state === 'capturing' ? status.overrideUntil : null
  return until ? `${label} ${t('memory.activity.until', { time: whenLabel(until, now) })}` : label
}

/** Whole hours from the next one, for "capture until". */
export function untilChoices(now: number, count = 4): number[] {
  const d = new Date(now)
  return Array.from({ length: count }, (_, i) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1 + i).getTime())
}

export function tomorrow(now: number): number {
  return nextLocalMidnight(now)
}

/** "45 min", "2 h 5 min". */
export function activeLabel(ms: number, t: T): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return t('memory.timeline.minutes', { count: Math.max(minutes, ms > 0 ? 1 : 0) })
  return t('memory.timeline.hours', { h: Math.floor(minutes / 60), m: minutes % 60 })
}

// ── Calendar ──

/** The days of a month as Monday-first weeks; days outside the month are null. */
export function monthGrid(year: number, month: number): Array<Array<string | null>> {
  const first = new Date(year, month, 1)
  const lead = (first.getDay() + 6) % 7
  const length = new Date(year, month + 1, 0).getDate()
  const cells: Array<string | null> = [...Array<null>(lead).fill(null)]
  for (let d = 1; d <= length; d++) cells.push(localDayKey(new Date(year, month, d).getTime()))
  while (cells.length % 7 !== 0) cells.push(null)
  const weeks: Array<Array<string | null>> = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

/** The Monday-to-Sunday week a day falls in, as local day keys. */
export function weekDays(day: string): string[] {
  const { from } = localDayBounds(day)
  const d = new Date(from)
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (_, i) => localDayKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i).getTime()))
}

/** The range a scope covers: one day, or its week. `to` is the last millisecond. */
export function scopeRange(scope: 'day' | 'week', day: string): { from: number; to: number } {
  if (scope === 'day') {
    const { from, to } = localDayBounds(day)
    return { from, to: to - 1 }
  }
  const days = weekDays(day)
  return { from: localDayBounds(days[0] as string).from, to: localDayBounds(days[6] as string).to - 1 }
}

export function shiftDay(day: string, delta: number): string {
  const { from } = localDayBounds(day)
  const d = new Date(from)
  return localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta).getTime())
}

/** Reads ?scope=day|week&date=YYYY-MM-DD; anything else falls back to today by day. */
export function parseTimelineQuery(search: string, now: number): { scope: 'day' | 'week'; day: string } {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const scope = params.get('scope') === 'week' ? 'week' : 'day'
  const date = params.get('date') ?? ''
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) && localDayKey(localDayBounds(date).from) === date ? date : localDayKey(now)
  return { scope, day }
}

// ── Memory upkeep ──

export const JOB_STATE_KEYS: Record<MemoryJob['state'], MessageKey> = {
  running: 'memory.jobs.running',
  done: 'memory.jobs.done',
  cancelled: 'memory.jobs.cancelled',
  failed: 'memory.jobs.failed',
  interrupted: 'memory.jobs.interrupted',
}

export function canRetry(job: MemoryJob): boolean {
  return job.state === 'failed' || job.state === 'cancelled' || job.state === 'interrupted'
}

/** Jobs for one owner, newest first, with the running one on top. */
export function jobsFor(jobs: readonly MemoryJob[], owner: string): MemoryJob[] {
  return jobs.filter((j) => j.owner === owner).sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running'))
}

/** Replaces a job in the list from a `memory-job` event, adding it when new. */
export function upsertJob(jobs: readonly MemoryJob[], job: MemoryJob): MemoryJob[] {
  const i = jobs.findIndex((j) => j.id === job.id)
  return i < 0 ? [job, ...jobs] : jobs.map((j) => (j.id === job.id ? job : j))
}

export function passTitleKey(pass: TidyPass): MessageKey {
  return pass.status === 'ok' ? 'memory.card.passTitleOk' : pass.status === 'skipped' ? 'memory.card.passTitleSkipped' : 'memory.card.passTitleError'
}

// ── The + menu's switch (CH-21) ──

export const ACTIVITY_ROW_ID = 'activity:toggle'

/** A divider and the switch row, or nothing while activity memory is off, unknown, or the chat is private. */
export function activityRows(state: { enabled: boolean; included: boolean } | null, isPrivate: boolean, label: string): MenuRow[] {
  if (!state || !state.enabled || isPrivate) return []
  return [
    { id: 'sep-activity', label: '', kind: 'separator' },
    { id: ACTIVITY_ROW_ID, label, kind: 'item', checked: state.included },
  ]
}


/** Items per page; Show more adds another page. */
export const INSPECTOR_PAGE = 50

export type KindFilter = 'all' | ActivityItemKind
export const KIND_FILTERS: readonly KindFilter[] = ['all', ...ACTIVITY_ITEM_KINDS]

/** One local day's items, of one kind or all, matching every word typed. */
export function inspectorQuery(day: string, kind: KindFilter, query: string, limit: number): { from: number; to: number; kind?: ActivityItemKind; query?: string; offset: number; limit: number } {
  const { from, to } = localDayBounds(day)
  const words = query.trim().slice(0, 500)
  return { from, to: to - 1, ...(kind === 'all' ? {} : { kind }), ...(words ? { query: words } : {}), offset: 0, limit }
}

/** "14:05" in the person's locale. */
export function timeLabel(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

/** "Mon 3 Nov" (with the year when it isn't this one). */
export function dateLabel(at: number, now: number, locale?: string): string {
  const d = new Date(at)
  return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) })
}

// ── Clear (ST-51) ──

export type ClearChoice = 'today' | 'week' | 'all'
export const CLEAR_CHOICES: readonly ClearChoice[] = ['today', 'week', 'all']

/** "Wed 29 Oct", "From Thu 23 Oct to Wed 29 Oct", or "Everything recorded so far". */
export function clearRangeText(range: { from: number | null; to: number }, now: number, t: T, locale?: string): string {
  if (range.from === null) return t('memory.activity.clearEverything')
  const from = dateLabel(range.from, now, locale)
  const to = dateLabel(range.to, now, locale)
  return from === to ? from : t('memory.activity.clearRange', { from, to })
}


export type TimelineScope = 'day' | 'week'

/** The timeline on the History page: atelier://history?view=timeline&scope=…&date=…. */
export function timelineUrl(scope: TimelineScope, day: string): string {
  return `atelier://history?view=timeline&scope=${scope}&date=${day}`
}

/** Which view of History an address asks for (?view=timeline, else the list). */
export function historyView(search: string): 'list' | 'timeline' {
  return new URLSearchParams(search).get('view') === 'timeline' ? 'timeline' : 'list'
}

/** Where an old atelier://workspace/timeline address goes now, with its scope and day. */
export function timelineRedirect(url: string, now: number): string {
  const { scope, day } = parseTimelineQuery(url.split('?')[1] ?? '', now)
  return timelineUrl(scope, day)
}

/** The days a scope shows, oldest first; never past today. */
export function scopeDays(scope: TimelineScope, day: string, today: string): string[] {
  return (scope === 'day' ? [day] : weekDays(day)).filter((d) => d <= today)
}

/** Totals for the summary tiles. */
export function totals(days: ReadonlyArray<{ visits: number; activeMs: number; sessions: number }>): { visits: number; activeMs: number; sessions: number } {
  return days.reduce((sum, d) => ({ visits: sum.visits + d.visits, activeMs: sum.activeMs + d.activeMs, sessions: sum.sessions + d.sessions }), { visits: 0, activeMs: 0, sessions: 0 })
}

/** Moves the calendar's focus with the arrow keys (a week up or down), Home/End to the week's ends; null for other keys. */
export function calendarKey(key: string, day: string): string | null {
  switch (key) {
    case 'ArrowLeft':
      return shiftDay(day, -1)
    case 'ArrowRight':
      return shiftDay(day, 1)
    case 'ArrowUp':
      return shiftDay(day, -7)
    case 'ArrowDown':
      return shiftDay(day, 7)
    case 'Home':
      return weekDays(day)[0] ?? day
    case 'End':
      return weekDays(day)[6] ?? day
    default:
      return null
  }
}

/** The month (year and 0-based month) a day key falls in. */
export function monthOf(day: string): { year: number; month: number } {
  const d = new Date(localDayBounds(day).from)
  return { year: d.getFullYear(), month: d.getMonth() }
}

export function shiftMonth(view: { year: number; month: number }, delta: number): { year: number; month: number } {
  const d = new Date(view.year, view.month + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() }
}

/** Today's visits read as a time, older ones as a date. */
export function lastVisitLabel(at: number, now: number, locale?: string): string {
  return startOfLocalDay(at) === startOfLocalDay(now) ? timeLabel(at, locale) : dateLabel(at, now, locale)
}
