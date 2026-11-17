/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Five-field cron expressions for advanced routine schedules (SK-08):
// minute, hour, day of month, month and day of week, with lists, ranges,
// steps, month and weekday names, and the @daily-style shorthands. As in
// classic cron, when both day fields are restricted a day matches either.
import { civilDate, fromWall, wallTime } from './zone'
import { mainT } from '../i18n/mainT'

export interface CronSpec {
  minutes: number[]
  hours: number[]
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** Day of month and day of week were both '*' (or '?'), or only one was restricted. */
  anyDay: boolean
  anyWeekday: boolean
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const SHORTHANDS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

interface FieldRule {
  label: string
  min: number
  max: number
  names?: readonly string[]
  /** Day of week: 7 is Sunday too. */
  sevenIsZero?: boolean
}

const FIELDS: readonly FieldRule[] = [
  { get label() { return mainT('skills.mainCron.minute') }, min: 0, max: 59 },
  { get label() { return mainT('skills.mainCron.hour') }, min: 0, max: 23 },
  { get label() { return mainT('skills.mainCron.dayOfMonth') }, min: 1, max: 31 },
  { get label() { return mainT('skills.mainCron.month') }, min: 1, max: 12, names: MONTHS },
  { get label() { return mainT('skills.mainCron.dayOfWeek') }, min: 0, max: 7, names: WEEKDAYS, sevenIsZero: true },
]

export class CronError extends Error {}

function value(token: string, rule: FieldRule): number {
  const lower = token.toLowerCase()
  const named = rule.names?.indexOf(lower) ?? -1
  if (named >= 0) return named + (rule.names === MONTHS ? 1 : 0)
  if (!/^\d+$/.test(token)) throw new CronError(`“${token}” isn’t a valid ${rule.label.toLowerCase()}.`)
  const n = Number(token)
  if (n < rule.min || n > rule.max) throw new CronError(`${rule.label} must be ${rule.min}–${rule.max}.`)
  return n
}

function field(text: string, rule: FieldRule): { values: Set<number>; star: boolean } {
  const values = new Set<number>()
  let star = false
  for (const part of text.split(',')) {
    if (part === '') throw new CronError(`${rule.label} has an empty item in its list.`)
    const [range = '', stepText, extra] = part.split('/')
    if (extra !== undefined) throw new CronError(`${rule.label} has more than one step.`)
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new CronError(`${rule.label} needs a step of 1 or more after “/”.`)
      step = Number(stepText)
    }
    let from: number
    let to: number
    if (range === '*' || range === '?') {
      from = rule.min
      to = rule.sevenIsZero ? 6 : rule.max
      if (stepText === undefined) star = true
    } else if (range.includes('-')) {
      const [a = '', b = '', more] = range.split('-')
      if (more !== undefined || a === '' || b === '') throw new CronError(`“${range}” isn’t a valid range.`)
      from = value(a, rule)
      to = value(b, rule)
    } else {
      from = value(range, rule)
      // "5/15" means from 5 to the end, every 15.
      to = stepText !== undefined ? (rule.sevenIsZero ? 6 : rule.max) : from
    }
    const span = rule.max - rule.min + 1
    // A range may wrap (fri-mon, 22-2); the steps continue across the end.
    const count = to >= from ? to - from + 1 : to + span - from + 1
    for (let i = 0; i < count; i += step) {
      let n = from + i
      if (n > rule.max) n -= span
      values.add(rule.sevenIsZero && n === 7 ? 0 : n)
    }
  }
  return { values, star }
}

/** Parses an expression; throws a CronError with a sentence for the person typing it. */
export function parseCron(expr: string): CronSpec {
  const trimmed = expr.trim()
  const text = SHORTHANDS[trimmed.toLowerCase()] ?? trimmed
  const fields = text.split(/\s+/).filter(Boolean)
  if (fields.length !== 5) throw new CronError('Use five fields: minute, hour, day of month, month and day of week (for example “0 9 * * 1-5”).')
  const [m, h, dom, mon, dow] = fields.map((f, i) => field(f, FIELDS[i]!))
  const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b)
  return {
    minutes: sorted(m!.values),
    hours: sorted(h!.values),
    days: dom!.values,
    months: mon!.values,
    weekdays: dow!.values,
    anyDay: dom!.star,
    anyWeekday: dow!.star,
  }
}

function dayMatches(spec: CronSpec, day: number, weekday: number): boolean {
  if (spec.anyDay && spec.anyWeekday) return true
  if (spec.anyDay) return spec.weekdays.has(weekday)
  if (spec.anyWeekday) return spec.days.has(day)
  return spec.days.has(day) || spec.weekdays.has(weekday)
}

/** Searching further than this means the expression never runs (Feb 30) or almost never. */
const SEARCH_DAYS = 366 * 8 + 2

/** The first run strictly after `from` in the zone, or null when there is none within eight years. */
export function nextCron(spec: CronSpec, from: number, zone: string | null): number | null {
  const start = wallTime(from, zone)
  for (let offset = 0; offset <= SEARCH_DAYS; offset++) {
    const d = civilDate(start.year, start.month, start.day + offset)
    if (!spec.months.has(d.month) || !dayMatches(spec, d.day, d.weekday)) continue
    for (const hour of spec.hours) {
      // Skip the hours of the first day that are already gone, without converting them.
      if (offset === 0 && hour < start.hour - 1) continue
      for (const minute of spec.minutes) {
        const at = fromWall(d.year, d.month, d.day, hour, minute, zone)
        if (at > from) return at
      }
    }
  }
  return null
}

export function validateCron(expr: string, now = Date.now()): { ok: true } | { ok: false; error: string } {
  try {
    const spec = parseCron(expr)
    if (nextCron(spec, now, null) === null) return { ok: false, error: mainT('skills.mainCron.thisScheduleNeverRuns') }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof CronError ? err.message : mainT('skills.mainCron.thisIsnTA') }
  }
}
