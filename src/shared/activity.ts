/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Activity and memory contract: memory upkeep (Tidy memory, CO-09),
// memory build jobs, and opt-in activity memory (
// ST-47 to ST-52, OV-24). Activity state is per profile
// (<profile dataDir>/activity/), Tidy is app-wide (userData/tidy.json).
// Activity memory is off by default and captures stay on this device.
import type { Owner } from './services'
import { SENSITIVE_CATEGORIES, type Exclusions, type SensitiveCategory } from './exclusions'
import type { TimelineService } from './timeline'

// ── Memory jobs and Tidy memory ──

export interface MemoryJob {
  id: string
  kind: 'build' | 'reorganize'
  owner: Owner
  state: 'running' | 'done' | 'cancelled' | 'failed' | 'interrupted'
  done: number
  total: number
  /** The background chat doing the work, to open from the job row. */
  chatId: string | null
  error?: string
  /** Chats a build left out because the decision model was sure they hold nothing lasting (DC-17). */
  skippedChats?: number
}

export interface MemoryBuildEstimate {
  chats: number
  messages: number
  approxInputTokens: number
  /** An estimate on the API-key engine; null otherwise. */
  approxCostUsd: number | null
}

export interface TidySettings {
  enabled: boolean
  /** Local hour (0–23) after which the nightly pass may run. */
  afterHour: number
}

export interface TidyPass {
  id: string
  companionId: string
  chatId: string | null
  at: number
  status: 'ok' | 'skipped' | 'error'
  reason?: string
  notesChanged: number
  /** New chats left out because the decision model was sure they hold nothing lasting (DC-17). */
  skippedChats?: number
}

/** Methods the activity feature adds to the `memory` namespace. */
export interface MemoryJobsMethods {
  estimateBuild(owner: Owner | 'all'): MemoryBuildEstimate
  startJob(kind: MemoryJob['kind'], owner: Owner, options?: { chatIds?: string[] }): MemoryJob
  cancelJob(id: string): void
  /** Runs a failed, cancelled or interrupted job again from the batch it stopped at. */
  retryJob(id: string): MemoryJob
  jobs(): MemoryJob[]
  /** Removes every note of `owner`, through Recently Deleted; returns how many. */
  removeAll(owner: Owner): number
}

export interface MemoryUpkeepService {
  settings(): TidySettings
  update(patch: Partial<TidySettings>): TidySettings
  passes(limit?: number): TidyPass[]
  runNow(companionId?: string): void
  /** When the next nightly pass may run (null while off) and whether one is running (CO-09). */
  schedule(): TidySchedule
}

export interface TidySchedule {
  nextAt: number | null
  lastAt: number | null
  running: boolean
}

// ── Activity memory ──

export interface ActivitySettings {
  enabled: boolean
  schedule: { on: boolean; days: number[]; startHour: number; endHour: number }
  override: { kind: 'none' } | { kind: 'on-until'; until: number } | { kind: 'off-until'; until: number }
  pausedUntil: number | null
  retention: { screenshotsDays: number; capturesDays: number; notesDays: number | null }
  excluded: Exclusions
  /** Suggested routines and insights from activity; both off by default. */
  proactive: { routines: boolean; insights: boolean }
}

export interface ActivityStatus {
  state: 'off' | 'capturing' | 'outside-hours' | 'paused'
  pausedUntil: number | null
  overrideUntil: number | null
  /** When the state changes next by itself (schedule edge, pause end), or null. */
  nextChange: number | null
}

export type ActivityItemKind = 'visit' | 'capture' | 'screenshot' | 'note'
export const ACTIVITY_ITEM_KINDS = ['visit', 'capture', 'screenshot', 'note'] as const satisfies readonly ActivityItemKind[]

export interface ActivityItem {
  id: string
  kind: ActivityItemKind
  at: number
  url: string | null
  title: string
  /** Captured text or the note; screenshots carry a small JPEG data URL in `media`. */
  text: string | null
  media: string | null
}

export type ActivityOverride = { kind: 'on-until'; until: number } | { kind: 'off-until-tomorrow' } | { kind: 'none' }

export interface ActivityService {
  status(): ActivityStatus
  settings(): ActivitySettings
  update(patch: Partial<ActivitySettings>): ActivitySettings
  pause(until: number | 'today'): ActivityStatus
  resume(): ActivityStatus
  override(o: ActivityOverride): ActivityStatus
  items(q: { from?: number; to?: number; query?: string; kind?: ActivityItemKind; offset?: number; limit?: number }): { items: ActivityItem[]; total: number }
  remove(ids: string[]): number
  clear(range: 'today' | 'week' | 'all'): { deleted: number; from: number | null; to: number }
  /** CH-21: whether search_activity is offered to a chat not started yet (default on). */
  chatIncluded(chatId: string): boolean
  includeInChat(chatId: string, included: boolean): boolean
}

export const DEFAULT_ACTIVITY_SETTINGS: Readonly<ActivitySettings> = {
  enabled: false,
  // ST-50: set hours on, weekdays.
  schedule: { on: true, days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 },
  override: { kind: 'none' },
  pausedUntil: null,
  // ST-52: screenshots about a month, raw captures about three months, notes until you delete them.
  retention: { screenshotsDays: 30, capturesDays: 90, notesDays: null },
  excluded: { categories: ['health', 'finance', 'adult', 'dating', 'religion', 'politics', 'government-id'], sites: [] },
  proactive: { routines: false, insights: false },
}

export interface MemoryFeatureServices {
  memoryUpkeep: MemoryUpkeepService
  activity: ActivityService
  timeline: TimelineService
}

/** AppEvent additions of the activity feature. */
export type MemoryFeatureEvent =
  | { type: 'memory-job'; job: MemoryJob }
  | { type: 'tidy'; pass: TidyPass }
  | { type: 'activity-status'; status: ActivityStatus }

// ── Pure helpers (shared by main and the renderer) ──

const DAY_MS = 86_400_000

/** Local midnight at the start of the day `at` falls on. */
export function startOfLocalDay(at: number): number {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** The next local midnight after `at` (DST-safe: built from the calendar date, not +24 h). */
export function nextLocalMidnight(at: number): number {
  const d = new Date(at)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** 'YYYY-MM-DD' in local time. */
export function localDayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local start and end (exclusive) of a 'YYYY-MM-DD' day. */
export function localDayBounds(day: string): { from: number; to: number } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return { from: new Date(y, m - 1, d).getTime(), to: new Date(y, m - 1, d + 1).getTime() }
}

type Schedule = ActivitySettings['schedule']

/** True when start and end are the same hour: the window is empty and nothing is captured (ST-50's warning). */
export function scheduleIsEmpty(schedule: Schedule): boolean {
  return schedule.startHour % 24 === schedule.endHour % 24 || schedule.days.length === 0
}

/**
 * Whether `at` falls inside the set hours. A window belongs to the day it
 * starts on; when the end is not after the start it wraps past midnight
 * into the next day (22 to 6 on Friday runs into Saturday morning).
 */
export function inActiveHours(schedule: Schedule, at: number): boolean {
  if (!schedule.on) return true
  if (scheduleIsEmpty(schedule)) return false
  const d = new Date(at)
  const hour = d.getHours()
  const day = d.getDay()
  const start = schedule.startHour
  const end = schedule.endHour
  if (start < end) return schedule.days.includes(day) && hour >= start && hour < end
  const yesterday = (day + 6) % 7
  return (schedule.days.includes(day) && hour >= start) || (schedule.days.includes(yesterday) && hour < end)
}

/** The next local hour boundary after `at` where the set hours switch on or off, or null within 8 days. */
export function nextScheduleEdge(schedule: Schedule, at: number): number | null {
  if (!schedule.on || scheduleIsEmpty(schedule)) return null
  const now = inActiveHours(schedule, at)
  const d = new Date(at)
  // Local wall-clock hours, so a DST change moves the edge with the clock.
  for (let step = 1; step <= 8 * 24 + 2; step++) {
    const edge = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + step).getTime()
    if (edge <= at) continue
    if (inActiveHours(schedule, edge) !== now) return edge
  }
  return null
}

/**
 * Activity memory's state at `now` (ST-49, ST-50, OV-24). Order: off, then
 * a pause or "off until", then "on until", then the set hours. Expired
 * pauses and overrides are ignored.
 */
export function activityStatusAt(settings: ActivitySettings, now: number): ActivityStatus {
  if (!settings.enabled) return { state: 'off', pausedUntil: null, overrideUntil: null, nextChange: null }
  const pause = settings.pausedUntil !== null && settings.pausedUntil > now ? settings.pausedUntil : null
  const override = settings.override.kind !== 'none' && settings.override.until > now ? settings.override : null
  const offUntil = override?.kind === 'off-until' ? override.until : null
  if (pause !== null || offUntil !== null) {
    const until = Math.max(pause ?? 0, offUntil ?? 0)
    return { state: 'paused', pausedUntil: until, overrideUntil: offUntil, nextChange: until }
  }
  if (override?.kind === 'on-until') return { state: 'capturing', pausedUntil: null, overrideUntil: override.until, nextChange: override.until }
  const inside = inActiveHours(settings.schedule, now)
  return { state: inside ? 'capturing' : 'outside-hours', pausedUntil: null, overrideUntil: null, nextChange: nextScheduleEdge(settings.schedule, now) }
}

/** When a pause chosen now ends: a number of minutes, or the rest of today. */
export function pauseEnd(choice: number | 'today', now: number): number {
  return choice === 'today' ? nextLocalMidnight(now) : now + choice * 60_000
}

/**
 * The most recent moment the nightly tidy became due: today's `afterHour`
 * if it has passed, else yesterday's. Built from the calendar date so DST
 * days keep the local hour.
 */
export function tidyBoundary(now: number, afterHour: number): number {
  const d = new Date(now)
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), afterHour).getTime()
  return today <= now ? today : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, afterHour).getTime()
}

/** The nightly pass is due once per night after `afterHour`, and at the next start when a night was missed. */
export function isTidyDue(now: number, afterHour: number, lastRunAt: number | null): boolean {
  return lastRunAt === null || lastRunAt < tidyBoundary(now, afterHour)
}

/** When the next nightly pass may run: now when it is due, else the next `afterHour`. */
export function nextTidyAt(now: number, afterHour: number, lastRunAt: number | null): number {
  if (isTidyDue(now, afterHour, lastRunAt)) return now
  const d = new Date(tidyBoundary(now, afterHour))
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, afterHour).getTime()
}

/** The local-day range a clear removes, as shown before you confirm (ST-51). */
export function clearRange(range: 'today' | 'week' | 'all', now: number): { from: number | null; to: number } {
  if (range === 'all') return { from: null, to: now }
  const today = startOfLocalDay(now)
  if (range === 'today') return { from: today, to: now }
  const d = new Date(today)
  return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime(), to: now }
}

/** The oldest capture time each kind keeps (ST-52); null keeps everything of that kind. */
export function retentionCutoffs(retention: ActivitySettings['retention'], now: number): Record<ActivityItemKind, number | null> {
  return {
    screenshot: now - retention.screenshotsDays * DAY_MS,
    capture: now - retention.capturesDays * DAY_MS,
    visit: now - retention.capturesDays * DAY_MS,
    note: retention.notesDays === null ? null : now - retention.notesDays * DAY_MS,
  }
}

/** True when any retention period got shorter, so cleanup runs at once. */
export function retentionShortened(before: ActivitySettings['retention'], after: ActivitySettings['retention']): boolean {
  const notes = (n: number | null): number => n ?? Number.POSITIVE_INFINITY
  return after.screenshotsDays < before.screenshotsDays || after.capturesDays < before.capturesDays || notes(after.notesDays) < notes(before.notesDays)
}

/** Settings read from disk, field by field over the defaults; anything invalid falls back. */
export function normalizeActivitySettings(raw: unknown): ActivitySettings {
  const d = DEFAULT_ACTIVITY_SETTINGS
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const int = (v: unknown, min: number, max: number, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback)
  const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  const s = r.schedule && typeof r.schedule === 'object' ? (r.schedule as Record<string, unknown>) : {}
  const days = Array.isArray(s.days) ? [...new Set(s.days.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 6))].sort() : [...d.schedule.days]
  const o = r.override && typeof r.override === 'object' ? (r.override as Record<string, unknown>) : {}
  const until = time(o.until)
  const override: ActivitySettings['override'] = (o.kind === 'on-until' || o.kind === 'off-until') && until !== null ? { kind: o.kind, until } : { kind: 'none' }
  const ret = r.retention && typeof r.retention === 'object' ? (r.retention as Record<string, unknown>) : {}
  const ex = r.excluded && typeof r.excluded === 'object' ? (r.excluded as Record<string, unknown>) : {}
  const categories = Array.isArray(ex.categories) ? ex.categories.filter((c): c is SensitiveCategory => (SENSITIVE_CATEGORIES as readonly unknown[]).includes(c)) : [...d.excluded.categories]
  const sites = Array.isArray(ex.sites) ? ex.sites.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 253).slice(0, 1000) : []
  const p = r.proactive && typeof r.proactive === 'object' ? (r.proactive as Record<string, unknown>) : {}
  return {
    enabled: r.enabled === true,
    schedule: {
      on: typeof s.on === 'boolean' ? s.on : d.schedule.on,
      days,
      startHour: int(s.startHour, 0, 23, d.schedule.startHour),
      endHour: int(s.endHour, 0, 24, d.schedule.endHour),
    },
    override,
    pausedUntil: time(r.pausedUntil),
    retention: {
      screenshotsDays: int(ret.screenshotsDays, 1, 365, d.retention.screenshotsDays),
      capturesDays: int(ret.capturesDays, 1, 3650, d.retention.capturesDays),
      notesDays: typeof ret.notesDays === 'number' && Number.isInteger(ret.notesDays) && ret.notesDays >= 1 && ret.notesDays <= 3650 ? ret.notesDays : d.retention.notesDays,
    },
    excluded: { categories: [...new Set(categories)], sites },
    proactive: { routines: p.routines === true, insights: p.insights === true },
  }
}
