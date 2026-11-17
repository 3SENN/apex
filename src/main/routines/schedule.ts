/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// When routines run (SK-08): daily at a wall time on chosen days, every N
// minutes (optionally inside a daily window and on chosen days), a cron
// expression, or once. Every kind is read in the routine's time zone (null
// follows the system), so a 08:00 routine stays at 08:00 across DST.
import { INTERVAL_MINUTES, type LegacyRoutineSchedule, type RoutineSchedule } from '@shared/routines'
import { nextCron, parseCron, validateCron } from './cron'
import { civilDate, fromWall, isTimeZone, wallTime } from './zone'

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/
const MINUTE = 60_000

export type AnySchedule = RoutineSchedule | LegacyRoutineSchedule

export function isLegacySchedule(schedule: AnySchedule): schedule is LegacyRoutineSchedule {
  return schedule.kind === 'interval' && 'hours' in schedule
}

/**
 * Older schedules counted intervals in hours (1–168). Up to a day becomes minutes; a
 * week keeps its weekday and time as cron; anything else between is clamped
 * to once a day, with a notice the Routines page shows.
 */
export function migrateSchedule(schedule: AnySchedule, anchor: number | null = null, zone: string | null = null): { schedule: RoutineSchedule; notice: string | null } {
  if (!isLegacySchedule(schedule)) return { schedule, notice: null }
  const hours = Math.max(1, Math.round(schedule.hours))
  if (hours <= 24) return { schedule: { kind: 'interval', minutes: hours * 60 }, notice: null }
  if (hours === 168) {
    const at = wallTime(anchor ?? Date.now(), zone)
    return { schedule: { kind: 'cron', expr: `${at.minute} ${at.hour} * * ${at.weekday}` }, notice: null }
  }
  return {
    schedule: { kind: 'interval', minutes: INTERVAL_MINUTES.max },
    notice: `This routine ran every ${hours} hours. Intervals now go up to a day, so it runs daily; pick an advanced schedule to run it less often.`,
  }
}

function cleanDays(days: readonly number[] | undefined): number[] {
  return [...new Set(days ?? [])].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b)
}

/** Throws a sentence naming what to fix. `now` is used for one-off times. */
export function validateSchedule(schedule: AnySchedule, options: { now?: number; requireFuture?: boolean; timeZone?: string | null } = {}): void {
  if (options.timeZone && !isTimeZone(options.timeZone)) throw new Error('Pick a time zone from the list.')
  switch (schedule.kind) {
    case 'daily':
      if (!TIME.test(schedule.time)) throw new Error('Use a 24-hour time such as 08:30.')
      if (schedule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Days are 0 (Sunday) to 6 (Saturday).')
      return
    case 'interval': {
      if (isLegacySchedule(schedule)) {
        if (!(schedule.hours >= 1 && schedule.hours <= 168)) throw new Error('Intervals are between 1 and 168 hours.')
        return
      }
      if (!Number.isInteger(schedule.minutes) || schedule.minutes < INTERVAL_MINUTES.min || schedule.minutes > INTERVAL_MINUTES.max) {
        throw new Error('Choose every 30 minutes up to every 24 hours.')
      }
      if (schedule.between) {
        const { start, end } = schedule.between
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440) throw new Error('The window is in minutes of the day, from 0 to 1440.')
        if (start >= end) throw new Error('The window has to start before it ends.')
      }
      if (schedule.days?.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Days are 0 (Sunday) to 6 (Saturday).')
      return
    }
    case 'cron': {
      const check = validateCron(schedule.expr, options.now)
      if (!check.ok) throw new Error(check.error)
      return
    }
    case 'once':
      if (!Number.isFinite(schedule.at)) throw new Error('Pick a date and time.')
      if (options.requireFuture && schedule.at <= (options.now ?? Date.now())) throw new Error('Pick a time in the future.')
      return
  }
}

function nextDaily(time: string, days: readonly number[], from: number, zone: string | null): number | null {
  const [, hh = '0', mm = '0'] = TIME.exec(time) ?? []
  const allowed = cleanDays(days)
  const start = wallTime(from, zone)
  for (let offset = 0; offset <= 8; offset++) {
    const d = civilDate(start.year, start.month, start.day + offset)
    if (allowed.length > 0 && allowed.length < 7 && !allowed.includes(d.weekday)) continue
    const at = fromWall(d.year, d.month, d.day, Number(hh), Number(mm), zone)
    if (at > from) return at
  }
  return null
}

function nextInterval(schedule: Extract<RoutineSchedule, { kind: 'interval' }>, from: number, zone: string | null): number | null {
  const allowed = cleanDays(schedule.days)
  // Without a window or days it simply repeats from the last run, as older schedules did.
  if (!schedule.between && (allowed.length === 0 || allowed.length === 7)) return from + schedule.minutes * MINUTE
  // With either, runs line up from the window's start each day: 09:00, 09:30 …
  // The window is in minutes of the day (the schedule schema): 540 to 1020 runs from 09:00 until before 17:00.
  const start = schedule.between?.start ?? 0
  const end = schedule.between?.end ?? 1440
  const first = wallTime(from, zone)
  for (let offset = 0; offset <= 8; offset++) {
    const d = civilDate(first.year, first.month, first.day + offset)
    if (allowed.length > 0 && allowed.length < 7 && !allowed.includes(d.weekday)) continue
    for (let m = start; m < end; m += schedule.minutes) {
      if (offset === 0 && m < first.hour * 60 + first.minute - 60) continue
      const at = fromWall(d.year, d.month, d.day, Math.floor(m / 60), m % 60, zone)
      if (at > from) return at
    }
  }
  return null
}

/** The next run strictly after `from`; null when there is none (a one-off time that passed, or a cron that never matches). */
export function nextRunAfter(schedule: AnySchedule, from: number, zone: string | null = null): number | null {
  const s = migrateSchedule(schedule, from, zone).schedule
  switch (s.kind) {
    case 'daily':
      return nextDaily(s.time, s.days, from, zone)
    case 'interval':
      return nextInterval(s, from, zone)
    case 'cron':
      try {
        return nextCron(parseCron(s.expr), from, zone)
      } catch {
        return null
      }
    case 'once':
      return s.at > from ? s.at : null
  }
}

/** The next `count` runs after `from`, for the editor's preview. */
export function previewSchedule(schedule: AnySchedule, zone: string | null, count = 5, from = Date.now()): number[] {
  const out: number[] = []
  let cursor = from
  while (out.length < count) {
    const next = nextRunAfter(schedule, cursor, zone)
    if (next === null) break
    out.push(next)
    cursor = next
  }
  return out
}
