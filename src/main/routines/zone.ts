/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Wall-clock time in an IANA zone, without a date library. Schedules are
// written in wall time ("08:00 on weekdays"), so every next-run search
// walks civil dates and converts each candidate back to an instant here.
// DST: a time that doesn't exist (the spring gap) runs at the same distance
// past the gap; a time that happens twice (the autumn overlap) runs once,
// at its first occurrence.

export interface WallTime {
  year: number
  /** 1–12 */
  month: number
  day: number
  hour: number
  minute: number
  /** 0 Sunday – 6 Saturday */
  weekday: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The system's own zone, for routines whose zone is null. */
export function systemZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Whether the runtime knows this IANA zone. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formatters.set(zone, f)
  }
  return f
}

/** Calendar maths on civil dates (no zone): the weekday and a day offset. */
export function civilDate(year: number, month: number, day: number): { year: number; month: number; day: number; weekday: number } {
  const d = new Date(Date.UTC(year, month - 1, day))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay() }
}

function parts(ts: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
  for (const p of formatter(zone).formatToParts(new Date(ts))) {
    if (p.type in out) out[p.type as keyof typeof out] = Number(p.value)
  }
  // Some runtimes print midnight as 24 even with h23.
  if (out.hour === 24) out.hour = 0
  return out
}

/** The zone's offset from UTC at an instant, in ms (wall minus UTC). */
export function offsetAt(ts: number, zone: string): number {
  const p = parts(ts, zone)
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return wall - Math.floor(ts / 1000) * 1000
}

export function wallTime(ts: number, zone: string | null): WallTime {
  const p = parts(ts, zone ?? systemZone())
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, weekday: civilDate(p.year, p.month, p.day).weekday }
}

const HOURS_14 = 14 * 3_600_000

/** The instant a wall time happens in a zone (see the DST rules above). */
export function fromWall(year: number, month: number, day: number, hour: number, minute: number, zone: string | null): number {
  const z = zone ?? systemZone()
  const local = Date.UTC(year, month - 1, day, hour, minute)
  // The two offsets a wall time can meet are the ones half a day either side.
  const before = offsetAt(local - HOURS_14, z)
  const after = offsetAt(local + HOURS_14, z)
  const valid = [...new Set([before, after])].map((o) => local - o).filter((t) => offsetAt(t, z) === local - t)
  if (valid.length > 0) return Math.min(...valid)
  // In the spring gap: the same distance past it, so 02:30 becomes 03:30.
  return local - before
}
