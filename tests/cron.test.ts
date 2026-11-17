/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { CronError, nextCron, parseCron, validateCron } from '../src/main/routines/cron'
import { previewSchedule } from '../src/main/routines/schedule'
import { fromWall, wallTime } from '../src/main/routines/zone'

const UTC = 'UTC'
const at = (iso: string): number => Date.parse(iso)
const iso = (ts: number | null): string | null => (ts === null ? null : new Date(ts).toISOString())

describe('parseCron', () => {
  it('reads lists, ranges, steps and names', () => {
    const spec = parseCron('0,30 9-17/4 * jan-mar mon-fri')
    expect(spec.minutes).toEqual([0, 30])
    expect(spec.hours).toEqual([9, 13, 17])
    expect([...spec.months].sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect([...spec.weekdays].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
    expect(spec.anyDay).toBe(true)
    expect(spec.anyWeekday).toBe(false)
  })

  it('treats 7 as Sunday and accepts the @daily-style shorthands', () => {
    expect([...parseCron('0 9 * * 7').weekdays]).toEqual([0])
    expect(parseCron('@daily').hours).toEqual([0])
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45])
  })

  it('explains what is wrong, field by field', () => {
    expect(() => parseCron('0 9 * *')).toThrow(CronError)
    expect(() => parseCron('0 9 * *')).toThrow(/five fields/)
    expect(() => parseCron('61 9 * * *')).toThrow(/Minute/)
    expect(() => parseCron('0 25 * * *')).toThrow(/Hour/)
    expect(() => parseCron('0 9 * foo *')).toThrow(/month/i)
    expect(() => parseCron('0 9 * * 1-')).toThrow()
  })
})

describe('validateCron', () => {
  it('accepts a good expression and names the problem with a bad one', () => {
    expect(validateCron('0 9 * * 1-5')).toEqual({ ok: true })
    const bad = validateCron('0 9 * *')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/five fields/)
  })

  it('refuses an expression that never runs', () => {
    const never = validateCron('0 9 30 2 *')
    expect(never).toEqual({ ok: false, error: expect.stringMatching(/never runs/) })
  })
})

describe('nextCron', () => {
  it('finds the next weekday run and wraps over the weekend', () => {
    // Friday 2026-10-30 18:00 UTC → Monday 09:00.
    expect(iso(nextCron(parseCron('0 9 * * 1-5'), at('2026-10-30T18:00:00Z'), UTC))).toBe('2026-11-02T09:00:00.000Z')
  })

  it('wraps months and years', () => {
    expect(iso(nextCron(parseCron('0 0 1 * *'), at('2026-12-15T00:00:00Z'), UTC))).toBe('2027-01-01T00:00:00.000Z')
    expect(iso(nextCron(parseCron('59 23 31 12 *'), at('2026-12-31T23:59:00Z'), UTC))).toBe('2027-12-31T23:59:00.000Z')
  })

  it('runs strictly after `from`', () => {
    expect(iso(nextCron(parseCron('0 9 * * *'), at('2026-11-02T09:00:00Z'), UTC))).toBe('2026-11-03T09:00:00.000Z')
  })

  it('finds Feb 29 in the next leap year', () => {
    expect(iso(nextCron(parseCron('0 12 29 2 *'), at('2026-03-01T00:00:00Z'), UTC))).toBe('2028-02-29T12:00:00.000Z')
  })

  it('matches either day field when both are restricted, as classic cron does', () => {
    // The 13th, or any Friday: Friday 2026-11-06 comes before the 13th.
    expect(iso(nextCron(parseCron('0 9 13 * 5'), at('2026-11-02T00:00:00Z'), UTC))).toBe('2026-11-06T09:00:00.000Z')
  })

  it('keeps wall time across DST in the routine’s zone', () => {
    const zone = 'Europe/Amsterdam'
    // The clocks go back on 2026-10-25; 08:00 stays 08:00 local on both sides.
    const runs = previewSchedule({ kind: 'cron', expr: '0 8 * * *' }, zone, 3, at('2026-10-23T12:00:00Z'))
    expect(runs.map((r) => wallTime(r, zone).hour)).toEqual([8, 8, 8])
    expect(iso(runs[0]!)).toBe('2026-10-24T06:00:00.000Z')
    expect(iso(runs[1]!)).toBe('2026-10-25T07:00:00.000Z')
  })

  it('moves a time in the spring gap forward instead of skipping the day', () => {
    const zone = 'America/New_York'
    // 2026-03-08: 02:00 to 03:00 does not exist in New York.
    const next = nextCron(parseCron('30 2 * * *'), at('2026-03-08T05:00:00Z'), zone)
    expect(next).not.toBeNull()
    const wall = wallTime(next!, zone)
    expect([wall.day, wall.hour, wall.minute]).toEqual([8, 3, 30])
  })

  it('runs an autumn-repeated hour once', () => {
    const zone = 'America/New_York'
    // 2026-11-01: 01:30 happens twice; the first one counts.
    const runs = previewSchedule({ kind: 'cron', expr: '30 1 * * *' }, zone, 2, at('2026-11-01T04:00:00Z'))
    expect(iso(runs[0]!)).toBe(iso(fromWall(2026, 11, 1, 1, 30, zone)))
    expect(wallTime(runs[1]!, zone).day).toBe(2)
  })
})

describe('previewSchedule', () => {
  it('gives the next five runs of a cron expression', () => {
    const runs = previewSchedule({ kind: 'cron', expr: '*/30 9-10 * * *' }, UTC, 5, at('2026-11-02T08:00:00Z'))
    expect(runs.map(iso)).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-02T09:30:00.000Z',
      '2026-11-02T10:00:00.000Z',
      '2026-11-02T10:30:00.000Z',
      '2026-11-03T09:00:00.000Z',
    ])
  })

  it('stops early when the schedule ends', () => {
    expect(previewSchedule({ kind: 'once', at: at('2026-11-05T10:00:00Z') }, UTC, 5, at('2026-11-02T00:00:00Z'))).toEqual([at('2026-11-05T10:00:00Z')])
    expect(previewSchedule({ kind: 'once', at: at('2026-11-01T10:00:00Z') }, UTC, 5, at('2026-11-02T00:00:00Z'))).toEqual([])
  })
})
