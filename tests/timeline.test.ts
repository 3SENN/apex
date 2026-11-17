/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ACTIVE_CAP_MS, SESSION_GAP_MS, groupSessions, siteInsights, siteLabel, summarizeDays, type Visit } from '../src/main/timeline/sessions'
import { InsightsCache, parseInsights } from '../src/main/timeline/insights'
import { VisitsLog, originOf } from '../src/main/timeline/visits'
import { calendarKey, historyView, lastVisitLabel, monthGrid, monthOf, parseTimelineQuery, scopeDays, scopeRange, shiftMonth, timelineRedirect, timelineUrl, totals, weekDays } from '../src/renderer/src/activity/logic'

const previousTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/Amsterdam'
})
afterAll(() => {
  process.env.TZ = previousTz
})

const at = (d: number, h: number, m = 0): number => new Date(2026, 9, d, h, m).getTime()
let nextId = 1
const v = (origin: string, time: number, dwellMin = 2, title = ''): Visit => ({ id: nextId++, url: `${origin}/page`, origin, title, at: time, dwellMs: dwellMin * 60_000 })

describe('sessions', () => {
  it('splits on gaps over 20 minutes after the last page was left', () => {
    const visits = [
      v('https://a.com', at(28, 9, 0), 10),
      v('https://b.com', at(28, 9, 25), 5), // 15 min after a.com was left: same session
      v('https://a.com', at(28, 10, 0), 1), // 30 min after: new session
      v('https://c.com', at(28, 14, 0), 1),
    ]
    const sessions = groupSessions(visits)
    expect(sessions).toHaveLength(3)
    expect(sessions[0]).toMatchObject({ start: at(28, 9, 0), end: at(28, 9, 30) })
    expect(sessions[0]?.sites.map((s) => s.origin)).toEqual(['https://a.com', 'https://b.com'])
    expect(sessions[1]?.start).toBe(at(28, 10, 0))
    expect(SESSION_GAP_MS).toBe(20 * 60_000)
  })

  it('caps one visit’s active time and orders sites by time', () => {
    const visits = [v('https://a.com', at(28, 9), 600, 'A long tab'), v('https://b.com', at(28, 9, 1), 3), v('https://b.com', at(28, 9, 5), 3, 'B latest')]
    const [session] = groupSessions(visits)
    expect(session?.sites[0]).toEqual({ origin: 'https://a.com', title: 'A long tab', visits: 1, activeMs: ACTIVE_CAP_MS })
    expect(session?.sites[1]).toEqual({ origin: 'https://b.com', title: 'B latest', visits: 2, activeMs: 6 * 60_000 })
    expect(groupSessions([v('https://x.org', at(28, 9))])[0]?.sites[0]?.title).toBe('x.org')
  })

  it('summarizes days newest first', () => {
    const days = summarizeDays([v('https://a.com', at(27, 9)), v('https://a.com', at(28, 9)), v('https://b.com', at(28, 15))])
    expect(days).toEqual([
      { day: '2026-10-28', visits: 2, activeMs: 4 * 60_000, sessions: 2 },
      { day: '2026-10-27', visits: 1, activeMs: 2 * 60_000, sessions: 1 },
    ])
  })

  it('builds the site insights table with sort and search', () => {
    const visits = [v('https://a.com', at(28, 9), 30, 'Alpha'), v('https://b.com', at(28, 10), 1, 'Beta'), v('https://b.com', at(28, 11), 1), v('https://www.c.org', at(28, 12), 3, 'Gamma docs')]
    expect(siteInsights(visits).map((s) => s.origin)).toEqual(['https://a.com', 'https://www.c.org', 'https://b.com'])
    expect(siteInsights(visits, { sort: 'visits' })[0]?.origin).toBe('https://b.com')
    expect(siteInsights(visits, { sort: 'recent' })[0]?.origin).toBe('https://www.c.org')
    expect(siteInsights(visits, { query: 'gamma' }).map((s) => s.origin)).toEqual(['https://www.c.org'])
    expect(siteInsights(visits, { query: 'b.com' })[0]).toMatchObject({ visits: 2, title: 'Beta', lastVisit: at(28, 11) })
    expect(siteLabel('https://www.c.org')).toBe('c.org')
  })
})

describe('the visits log', () => {
  let dir: string
  let log: VisitsLog
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apex-visits-'))
    log = new VisitsLog(join(dir, 'visits.sqlite'))
  })
  afterEach(() => {
    log.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records websites only, and prunes with history', () => {
    expect(log.record({ url: 'apex://settings', title: '', at: 1 })).toBeNull()
    const id = log.record({ url: 'https://a.com/x', title: 'A', at: 10 }) as number
    log.record({ url: 'https://a.com/y', title: 'A2', at: 20 })
    log.record({ url: 'https://b.com/', title: 'B', at: 30 })
    log.setDwell(id, 5000)
    expect(log.range(0, 100).map((r) => [r.origin, r.dwellMs])).toEqual([['https://a.com', 5000], ['https://a.com', 0], ['https://b.com', 0]])
    expect(log.removeUrl('https://a.com/x')).toBe(1)
    expect(log.range(0, 100)).toHaveLength(2)
    expect(log.clear()).toBe(2)
    expect(originOf('ftp://x')).toBeNull()
  })
})

describe('insights (opt-in)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apex-insights-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const note = { id: 'n1', kind: 'note' as const, at: 5, url: null, title: 'Notes', text: '- You compared hotels in Kyoto twice.', media: null }
  const site = { origin: 'https://a.com', title: 'A', visits: 3, activeMs: 60_000, lastVisit: 5 }

  it('makes no model call while insights are off, or with nothing to read', async () => {
    let calls = 0
    const cache = new InsightsCache(join(dir, 'i.json'), async () => {
      calls++
      return '[]'
    })
    expect(await cache.insights({ enabled: false, range: { from: 0, to: 10 }, notes: [note], sites: [site] })).toEqual([])
    expect(await cache.insights({ enabled: true, range: { from: 0, to: 10 }, notes: [], sites: [] })).toEqual([])
    expect(calls).toBe(0)
  })

  it('caches per range and hides dismissed insights', async () => {
    let calls = 0
    const cache = new InsightsCache(join(dir, 'i.json'), async (input) => {
      calls++
      expect(input.kind).toBe('activity')
      expect(input.prompt).toContain('Kyoto')
      return 'Here you go: [{"kind":"todo","title":"Book the Kyoto hotel","detail":"You compared two."},{"kind":"routine-idea","title":"Weekly price check","detail":"x"}]'
    }, () => 1000)
    const input = { enabled: true, range: { from: 0, to: 10 }, notes: [note], sites: [site] }
    const first = await cache.insights(input)
    expect(first.map((i) => i.kind)).toEqual(['todo', 'routine-idea'])
    expect(first[1]?.action).toEqual({ label: 'Make a routine', url: 'apex://routines/new' })
    expect(await cache.insights(input)).toHaveLength(2)
    expect(calls).toBe(1)
    cache.dismiss(first[0]?.id as string)
    expect((await cache.insights(input)).map((i) => i.title)).toEqual(['Weekly price check'])
  })

  it('drops malformed answers', () => {
    expect(parseInsights('no json here', 1)).toEqual([])
    expect(parseInsights('[{"kind":"gossip","title":"x"},{"kind":"habit"},{"kind":"focus","title":"Deep work mornings","detail":"…"}]', 1).map((i) => i.title)).toEqual(['Deep work mornings'])
    expect(parseInsights('[1, null, "x"]', 1)).toEqual([])
  })
})

describe('the timeline view (renderer logic)', () => {
  it('reads and writes ?scope= and ?date=, falling back to today by day', () => {
    const now = at(29, 10)
    expect(parseTimelineQuery('?scope=week&date=2026-10-20', now)).toEqual({ scope: 'week', day: '2026-10-20' })
    expect(parseTimelineQuery('scope=nope&date=2026-02-31', now)).toEqual({ scope: 'day', day: '2026-10-29' })
    expect(parseTimelineQuery('', now)).toEqual({ scope: 'day', day: '2026-10-29' })
    expect(timelineUrl('week', '2026-10-20')).toBe('apex://history?view=timeline&scope=week&date=2026-10-20')
  })

  it('lives on History: ?view=timeline picks it, and an old Workspace address goes there', () => {
    const now = at(29, 10)
    expect(historyView('view=timeline&scope=day')).toBe('timeline')
    expect(historyView('?view=timeline')).toBe('timeline')
    expect(historyView('')).toBe('list')
    expect(historyView('view=list')).toBe('list')
    expect(parseTimelineQuery('view=timeline&scope=week&date=2026-10-20', now)).toEqual({ scope: 'week', day: '2026-10-20' })
    expect(timelineRedirect('apex://workspace/timeline?scope=week&date=2026-10-20', now)).toBe('apex://history?view=timeline&scope=week&date=2026-10-20')
    expect(timelineRedirect('apex://workspace/timeline', now)).toBe('apex://history?view=timeline&scope=day&date=2026-10-29')
  })

  it('lays a month out in Monday-first weeks', () => {
    const october = monthGrid(2026, 9)
    // 1 October 2026 is a Thursday: three empty cells lead.
    expect(october[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(october.every((w) => w.length === 7)).toBe(true)
    expect(october.flat().filter(Boolean)).toHaveLength(31)
    expect(monthOf('2026-10-29')).toEqual({ year: 2026, month: 9 })
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 })
  })

  it('covers a day or its Monday-to-Sunday week, never past today, across the DST change', () => {
    expect(weekDays('2026-10-29')).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'])
    expect(scopeDays('week', '2026-10-29', '2026-10-29')).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'])
    expect(scopeDays('day', '2026-10-20', '2026-10-29')).toEqual(['2026-10-20'])
    // The week of 25 October 2026 holds the switch back from summer time: 7 days of 24, 25 and 23 hours still end on Sunday night.
    const week = scopeRange('week', '2026-10-25')
    expect(new Date(week.from).getDate()).toBe(19)
    expect(new Date(week.to).getDate()).toBe(25)
    expect(new Date(week.to).getHours()).toBe(23)
    const day = scopeRange('day', '2026-10-25')
    expect(day.to - day.from + 1).toBe(25 * 3_600_000)
  })

  it('moves the calendar focus by day, week and to the week’s ends', () => {
    expect(calendarKey('ArrowRight', '2026-10-31')).toBe('2026-11-01')
    expect(calendarKey('ArrowUp', '2026-10-05')).toBe('2026-09-28')
    expect(calendarKey('Home', '2026-10-29')).toBe('2026-10-26')
    expect(calendarKey('End', '2026-10-29')).toBe('2026-11-01')
    expect(calendarKey('a', '2026-10-29')).toBeNull()
  })

  it('adds up the summary tiles and labels the last visit', () => {
    expect(totals([{ visits: 2, activeMs: 60_000, sessions: 1 }, { visits: 3, activeMs: 120_000, sessions: 2 }])).toEqual({ visits: 5, activeMs: 180_000, sessions: 3 })
    expect(totals([])).toEqual({ visits: 0, activeMs: 0, sessions: 0 })
    expect(lastVisitLabel(at(29, 9, 5), at(29, 18), 'en-GB')).toBe('09:05')
    expect(lastVisitLabel(at(27, 9), at(29, 18), 'en-GB')).toMatch(/27/)
  })
})
