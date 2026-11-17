/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ACTIVITY_SETTINGS,
  activityStatusAt,
  clearRange,
  inActiveHours,
  nextLocalMidnight,
  nextScheduleEdge,
  normalizeActivitySettings,
  pauseEnd,
  retentionCutoffs,
  retentionShortened,
  scheduleIsEmpty,
  type ActivitySettings,
  type ActivityStatus,
} from '@shared/activity'
import { SENSITIVE_CATEGORIES } from '@shared/exclusions'
import type { PageVisit } from '@shared/timeline'
import { captureGate } from '../src/main/activity/gate'
import { ACTIVITY_ROW_ID, activityRows, canRetry, clearRangeText, inspectorQuery, jobsFor, statusLine, toggleDay, untilChoices, upsertJob } from '../src/renderer/src/activity/logic'
import type { MemoryJob } from '@shared/activity'
import { ActivityManager, type PageAccess } from '../src/main/activity/manager'
import { appendNote, activityNotePath, notesPrompt } from '../src/main/activity/notes'
import { ActivityStore } from '../src/main/activity/store'
import { activityOffered, bindActivitySearch, formatResults, registerSearchActivity, searchActivityTool } from '../src/main/activity/tool'
import { workspaceSetup, type ToolSetup } from '../src/main/agent/tools/registry'

// Local-time maths runs in a fixed zone with DST, so the tests mean the same everywhere.
const previousTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/Amsterdam'
})
afterAll(() => {
  process.env.TZ = previousTz
})

const at = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime()
const settings = (patch: Partial<ActivitySettings> = {}): ActivitySettings => ({ ...DEFAULT_ACTIVITY_SETTINGS, enabled: true, ...patch })
const weekdays = { on: true, days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }

describe('set hours (ST-50)', () => {
  it('captures inside the window on chosen days only', () => {
    // 2026-10-28 is a Wednesday, 2026-10-31 a Saturday.
    expect(inActiveHours(weekdays, at(2026, 10, 28, 9))).toBe(true)
    expect(inActiveHours(weekdays, at(2026, 10, 28, 17, 59))).toBe(true)
    expect(inActiveHours(weekdays, at(2026, 10, 28, 18))).toBe(false)
    expect(inActiveHours(weekdays, at(2026, 10, 28, 8, 59))).toBe(false)
    expect(inActiveHours(weekdays, at(2026, 10, 31, 12))).toBe(false)
    expect(inActiveHours({ ...weekdays, on: false }, at(2026, 10, 31, 3))).toBe(true)
  })

  it('wraps past midnight into the next day', () => {
    const nights = { on: true, days: [5], startHour: 22, endHour: 6 } // Friday night
    expect(inActiveHours(nights, at(2026, 10, 30, 23))).toBe(true) // Friday 23:00
    expect(inActiveHours(nights, at(2026, 10, 31, 5))).toBe(true) // Saturday 05:00
    expect(inActiveHours(nights, at(2026, 10, 31, 6))).toBe(false)
    expect(inActiveHours(nights, at(2026, 10, 30, 5))).toBe(false) // Friday 05:00 belongs to Thursday's night
    expect(inActiveHours(nights, at(2026, 10, 31, 23))).toBe(false)
  })

  it('treats start equal to end, or no days, as an empty window', () => {
    expect(scheduleIsEmpty({ ...weekdays, startHour: 9, endHour: 9 })).toBe(true)
    expect(scheduleIsEmpty({ ...weekdays, startHour: 0, endHour: 24 })).toBe(true)
    expect(scheduleIsEmpty({ ...weekdays, days: [] })).toBe(true)
    expect(inActiveHours({ ...weekdays, startHour: 9, endHour: 9 }, at(2026, 10, 28, 9))).toBe(false)
    expect(nextScheduleEdge({ ...weekdays, startHour: 9, endHour: 9 }, at(2026, 10, 28, 9))).toBeNull()
  })

  it('finds the next edge, across a weekend', () => {
    expect(nextScheduleEdge(weekdays, at(2026, 10, 28, 10, 30))).toBe(at(2026, 10, 28, 18))
    expect(nextScheduleEdge(weekdays, at(2026, 10, 28, 19))).toBe(at(2026, 10, 29, 9))
    expect(nextScheduleEdge(weekdays, at(2026, 10, 30, 18, 5))).toBe(at(2026, 11, 2, 9))
  })

  it('keeps local hours across DST changes', () => {
    // Clocks went back on Sunday 2026-10-25 and forward on Sunday 2026-03-29 in Amsterdam.
    const daily = { on: true, days: [0, 1, 2, 3, 4, 5, 6], startHour: 9, endHour: 18 }
    expect(nextScheduleEdge(daily, at(2026, 10, 24, 20))).toBe(at(2026, 10, 25, 9))
    expect(new Date(nextScheduleEdge(daily, at(2026, 10, 24, 20)) as number).getHours()).toBe(9)
    expect(nextScheduleEdge(daily, at(2026, 3, 28, 20))).toBe(at(2026, 3, 29, 9))
    expect(new Date(nextScheduleEdge(daily, at(2026, 3, 28, 20)) as number).getHours()).toBe(9)
    // A 25-hour day: midnight comes 25 hours after the previous one.
    expect(nextLocalMidnight(at(2026, 10, 25, 1)) - at(2026, 10, 25, 0)).toBe(25 * 3_600_000)
    const wrap = { on: true, days: [6], startHour: 22, endHour: 4 }
    expect(inActiveHours(wrap, at(2026, 10, 25, 3, 30))).toBe(true)
    expect(nextScheduleEdge(wrap, at(2026, 10, 25, 1))).toBe(at(2026, 10, 25, 4))
  })
})

describe('status (ST-49, OV-24)', () => {
  const wed10 = at(2026, 10, 28, 10)
  it('is off while disabled, whatever else is set', () => {
    expect(activityStatusAt({ ...settings(), enabled: false, pausedUntil: wed10 + 1000 }, wed10)).toEqual({ state: 'off', pausedUntil: null, overrideUntil: null, nextChange: null })
  })

  it('captures inside hours and waits outside them', () => {
    expect(activityStatusAt(settings(), wed10)).toMatchObject({ state: 'capturing', nextChange: at(2026, 10, 28, 18) })
    expect(activityStatusAt(settings(), at(2026, 10, 28, 20))).toMatchObject({ state: 'outside-hours', nextChange: at(2026, 10, 29, 9) })
    expect(activityStatusAt(settings({ schedule: { ...weekdays, on: false } }), at(2026, 10, 28, 20))).toMatchObject({ state: 'capturing', nextChange: null })
  })

  it('pauses until a time, and the pause expires by itself', () => {
    const until = pauseEnd(15, wed10)
    expect(until).toBe(wed10 + 15 * 60_000)
    expect(activityStatusAt(settings({ pausedUntil: until }), wed10)).toEqual({ state: 'paused', pausedUntil: until, overrideUntil: null, nextChange: until })
    expect(activityStatusAt(settings({ pausedUntil: until }), until + 1).state).toBe('capturing')
    expect(pauseEnd('today', wed10)).toBe(at(2026, 10, 29, 0))
  })

  it('applies overrides: on until a time outside hours, and off until tomorrow', () => {
    const evening = at(2026, 10, 28, 20)
    const onUntil = at(2026, 10, 28, 22)
    expect(activityStatusAt(settings({ override: { kind: 'on-until', until: onUntil } }), evening)).toEqual({ state: 'capturing', pausedUntil: null, overrideUntil: onUntil, nextChange: onUntil })
    expect(activityStatusAt(settings({ override: { kind: 'on-until', until: onUntil } }), onUntil + 1).state).toBe('outside-hours')
    const tomorrow = nextLocalMidnight(wed10)
    expect(activityStatusAt(settings({ override: { kind: 'off-until', until: tomorrow } }), wed10)).toMatchObject({ state: 'paused', pausedUntil: tomorrow, overrideUntil: tomorrow })
    // A pause beats "on until".
    expect(activityStatusAt(settings({ override: { kind: 'on-until', until: onUntil }, pausedUntil: evening + 60_000 }), evening).state).toBe('paused')
  })
})

describe('the capture gating matrix', () => {
  const capturing: ActivityStatus = { state: 'capturing', pausedUntil: null, overrideUntil: null, nextChange: null }
  const base = { status: capturing, url: 'https://example.com/a', privateWindow: false, agentControlled: false, excluded: { categories: [...SENSITIVE_CATEGORIES], sites: ['secret.example'] } }

  it.each([
    ['off', { status: { ...capturing, state: 'off' as const } }],
    ['paused', { status: { ...capturing, state: 'paused' as const } }],
    ['outside-hours', { status: { ...capturing, state: 'outside-hours' as const } }],
    ['private', { privateWindow: true }],
    ['agent', { agentControlled: true }],
    ['not-web', { url: 'atelier://settings' }],
    ['not-web', { url: 'atelier-app://abc/' }],
    ['not-web', { url: 'file:///tmp/a.html' }],
    ['excluded', { url: 'https://www.webmd.com/x' }],
    ['excluded', { url: 'https://a.secret.example/' }],
    ['guarded', { guarded: true }],
  ])('refuses: %s', (reason, patch) => {
    expect(captureGate({ ...base, ...patch })).toEqual({ ok: false, reason })
  })

  it('allows a normal page in a normal window while capturing', () => {
    expect(captureGate(base)).toEqual({ ok: true })
    expect(captureGate({ ...base, guarded: false })).toEqual({ ok: true })
  })
})

describe('retention and clearing (ST-51, ST-52)', () => {
  const now = at(2026, 10, 28, 15)
  it('computes cutoffs per kind; notes kept until deleted by default', () => {
    const c = retentionCutoffs(DEFAULT_ACTIVITY_SETTINGS.retention, now)
    expect(c.screenshot).toBe(now - 30 * 86_400_000)
    expect(c.capture).toBe(now - 90 * 86_400_000)
    expect(c.visit).toBe(c.capture)
    expect(c.note).toBeNull()
  })

  it('knows when a period got shorter', () => {
    const r = DEFAULT_ACTIVITY_SETTINGS.retention
    expect(retentionShortened(r, { ...r, screenshotsDays: 7 })).toBe(true)
    expect(retentionShortened(r, { ...r, notesDays: 365 })).toBe(true)
    expect(retentionShortened(r, { ...r, capturesDays: 180 })).toBe(false)
    expect(retentionShortened({ ...r, notesDays: 30 }, { ...r, notesDays: null })).toBe(false)
  })

  it('shows the clear ranges by local day', () => {
    expect(clearRange('today', now)).toEqual({ from: at(2026, 10, 28), to: now })
    expect(clearRange('week', now)).toEqual({ from: at(2026, 10, 22), to: now })
    expect(clearRange('all', now)).toEqual({ from: null, to: now })
  })

  it('reads settings field by field and drops bad values', () => {
    const s = normalizeActivitySettings({ enabled: true, schedule: { on: false, days: [1, 9, 1, 'x'], startHour: 30, endHour: 24 }, retention: { screenshotsDays: 0, capturesDays: 10, notesDays: 5 }, excluded: { categories: ['health', 'bogus'], sites: ['a.com', 4] }, override: { kind: 'on-until', until: -1 } })
    expect(s.enabled).toBe(true)
    expect(s.schedule).toEqual({ on: false, days: [1], startHour: 9, endHour: 24 })
    expect(s.retention).toEqual({ screenshotsDays: 30, capturesDays: 10, notesDays: 5 })
    expect(s.excluded).toEqual({ categories: ['health'], sites: ['a.com'] })
    expect(s.override).toEqual({ kind: 'none' })
    expect(normalizeActivitySettings(undefined)).toEqual(DEFAULT_ACTIVITY_SETTINGS)
  })
})

describe('ActivityStore', () => {
  let dir: string
  let store: ActivityStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-activity-'))
    store = new ActivityStore(dir)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps settings and reports clear counts by range', () => {
    expect(store.settings().enabled).toBe(false)
    store.saveSettings({ ...store.settings(), enabled: true })
    expect(new ActivityStore(dir).settings().enabled).toBe(true)
    const now = at(2026, 10, 28, 15)
    store.addVisit({ url: 'https://a.com', title: 'A', at: now - 60_000 })
    store.addCapture({ url: 'https://a.com', title: 'A', at: now - 30_000, text: 'alpha text' })
    store.addVisit({ url: 'https://b.com', title: 'B', at: at(2026, 10, 25, 10) })
    store.addNote({ at: at(2026, 10, 1, 10), title: 'Notes', text: 'old note' })
    const today = clearRange('today', now)
    expect(store.clear(today.from, today.to)).toBe(2)
    const week = clearRange('week', now)
    expect(store.clear(week.from, week.to)).toBe(1)
    expect(store.items().total).toBe(1)
    expect(store.clear(null, now)).toBe(1)
    expect(store.items().total).toBe(0)
  })

  it('applies retention per kind and searches every word', () => {
    const now = at(2026, 10, 28, 15)
    const day = 86_400_000
    store.addScreenshot({ url: 'https://a.com', title: 'A', at: now - 40 * day, jpeg: Buffer.from([1, 2, 3]) })
    store.addScreenshot({ url: 'https://a.com', title: 'A', at: now - 2 * day, jpeg: Buffer.from([1, 2, 3]) })
    store.addCapture({ url: 'https://a.com', title: 'Kyoto trip', at: now - 100 * day, text: 'temples' })
    store.addCapture({ url: 'https://a.com/50%_off', title: 'Kyoto hotels', at: now - day, text: 'ryokan prices' })
    store.addNote({ at: now - 400 * day, title: 'Notes', text: 'kept' })
    expect(store.cleanup(retentionCutoffs(DEFAULT_ACTIVITY_SETTINGS.retention, now))).toBe(2)
    expect(store.items({ kind: 'note' }).total).toBe(1)
    expect(store.items({ query: 'kyoto RYOKAN' }).items.map((i) => i.title)).toEqual(['Kyoto hotels'])
    expect(store.items({ query: '50%_' }).total).toBe(1)
    expect(store.items({ query: '%' }).total).toBe(1)
    const shot = store.items({ kind: 'screenshot' }).items[0]
    expect(shot?.media).toBe('data:image/jpeg;base64,AQID')
    expect(store.remove([shot?.id as string, 'missing'])).toBe(1)
  })
})

describe('ActivityManager capture', () => {
  let base: string
  let now: number
  let manager: ActivityManager
  const broadcasts: ActivityStatus[] = []
  const notes: Array<{ path: string; text: string; owner: string }> = []
  let completions = 0

  const page = (url: string, over: Partial<PageAccess> = {}): PageAccess => ({
    url: () => url,
    title: () => 'A page',
    text: async () => 'Hello from the page',
    guarded: async () => false,
    thumbnail: async () => Buffer.from([255, 216, 255]),
    ...over,
  })
  const visit = (url: string, patch: Partial<PageVisit> = {}): PageVisit => ({ tabId: 't1', url, title: '', at: now, agentControlled: false, privateWindow: false, profileId: 'default', ...patch })
  let flags: Record<string, string> = {}

  beforeEach(() => {
    vi.useFakeTimers()
    now = at(2026, 10, 28, 10)
    vi.setSystemTime(now)
    base = mkdtempSync(join(tmpdir(), 'atelier-am-'))
    broadcasts.length = 0
    notes.length = 0
    completions = 0
    flags = {}
    manager = new ActivityManager({
      dataDirFor: (id) => (id === 'default' ? base : join(base, 'profiles', id)),
      currentProfile: () => 'default',
      flags: () => flags,
      complete: async () => {
        completions++
        return '- You read about Kyoto.'
      },
      activeCompanion: () => 'pip',
      memory: {
        read: (path) => notes.find((n) => n.path === path)?.text ?? '',
        write: (path, text, owner) => {
          const existing = notes.find((n) => n.path === path)
          if (existing) existing.text = text
          else notes.push({ path, text, owner })
        },
      },
      broadcast: (s) => broadcasts.push(s),
      now: () => Date.now(),
    })
  })
  afterEach(() => {
    manager.dispose()
    vi.useRealTimers()
    rmSync(base, { recursive: true, force: true })
  })

  const enable = (patch: Partial<ActivitySettings> = {}): void => {
    manager.service().update({ enabled: true, ...patch })
  }

  it('records nothing while off (the default)', async () => {
    manager.onVisit(visit('https://example.com/a'), page('https://example.com/a'))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(manager.service().items({}).total).toBe(0)
    // The timeline's visits log still has it, like history.
    expect(manager.timeline().sites({ from: 0, to: now + 1e6 }).map((s) => s.origin)).toEqual(['https://example.com'])
  })

  it('records the visit, then the text after 20 s, and the time on the page', async () => {
    enable()
    manager.onVisit(visit('https://example.com/a'), page('https://example.com/a'))
    expect(manager.service().items({}).items.map((i) => i.kind)).toEqual(['visit'])
    await vi.advanceTimersByTimeAsync(19_000)
    expect(manager.service().items({ kind: 'capture' }).total).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    const capture = manager.service().items({ kind: 'capture' }).items[0]
    expect(capture).toMatchObject({ url: 'https://example.com/a', title: 'A page', text: 'Hello from the page' })
    // Thumbnails only behind the flag.
    expect(manager.service().items({ kind: 'screenshot' }).total).toBe(0)
    manager.onLeft({ tabId: 't1', url: 'https://example.com/a', dwellMs: 45_000 })
    expect(manager.timeline().sites({ from: 0, to: Date.now() })[0]).toMatchObject({ visits: 1, activeMs: 45_000 })
  })

  it('takes a thumbnail with the flag on', async () => {
    flags = { 'activity-screenshots': 'on' }
    enable()
    manager.onVisit(visit('https://example.com/a'), page('https://example.com/a'))
    await vi.advanceTimersByTimeAsync(21_000)
    expect(manager.service().items({ kind: 'screenshot' }).total).toBe(1)
  })

  it('records nothing paused, outside hours, private, agent-driven or excluded', async () => {
    enable()
    manager.service().pause('today')
    manager.onVisit(visit('https://example.com/p'), page('https://example.com/p'))
    manager.service().resume()
    manager.onVisit(visit('https://example.com/q', { tabId: 't2', privateWindow: true }), page('https://example.com/q'))
    manager.onVisit(visit('https://example.com/r', { tabId: 't3', agentControlled: true }), page('https://example.com/r'))
    manager.onVisit(visit('https://www.webmd.com/s', { tabId: 't4' }), page('https://www.webmd.com/s'))
    manager.service().update({ excluded: { categories: [], sites: ['https://Mine.example/'] } })
    manager.onVisit(visit('https://docs.mine.example/', { tabId: 't5' }), page('https://docs.mine.example/'))
    vi.setSystemTime(at(2026, 10, 28, 20))
    manager.onVisit(visit('https://example.com/t', { tabId: 't6', at: Date.now() }), page('https://example.com/t'))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(manager.service().items({}).total).toBe(0)
    expect(manager.service().settings().excluded.sites).toEqual(['mine.example'])
  })

  it('skips the text of a page with password or payment fields, and a page that navigated away', async () => {
    enable()
    manager.onVisit(visit('https://example.com/login'), page('https://example.com/login', { guarded: async () => true }))
    manager.onVisit(visit('https://example.com/moved', { tabId: 't2' }), page('https://example.com/elsewhere'))
    await vi.advanceTimersByTimeAsync(21_000)
    expect(manager.service().items({ kind: 'capture' }).total).toBe(0)
    expect(manager.service().items({ kind: 'visit' }).total).toBe(2)
  })

  it('keeps profiles apart', async () => {
    enable()
    manager.onVisit(visit('https://example.com/a', { profileId: 'work' }), page('https://example.com/a'))
    manager.profile('work').store.saveSettings({ ...manager.profile('work').store.settings(), enabled: true })
    manager.onVisit(visit('https://example.com/b', { profileId: 'work', tabId: 't2' }), page('https://example.com/b'))
    await vi.advanceTimersByTimeAsync(21_000)
    expect(manager.service().items({}).total).toBe(0)
    expect(manager.profile('work').store.items({}).total).toBe(2)
    expect(manager.timeline().sites({ from: 0, to: Date.now() })).toEqual([])
  })

  it('broadcasts status changes and wakes at the next edge', async () => {
    enable()
    expect(broadcasts.at(-1)?.state).toBe('capturing')
    manager.service().pause(Date.now() + 15 * 60_000)
    expect(broadcasts.at(-1)?.state).toBe('paused')
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000)
    expect(broadcasts.at(-1)?.state).toBe('capturing')
    expect(() => manager.service().pause(Date.now() - 1)).toThrow()
    expect(manager.service().override({ kind: 'off-until-tomorrow' }).state).toBe('paused')
    expect(manager.service().resume().state).toBe('capturing')
  })

  it('cleans up at once when a period gets shorter', () => {
    enable()
    const store = manager.profile('default').store
    store.addScreenshot({ url: 'https://a.com', title: 'A', at: Date.now() - 10 * 86_400_000, jpeg: Buffer.from([1]) })
    manager.service().update({ retention: { screenshotsDays: 30, capturesDays: 90, notesDays: null } })
    expect(store.items({ kind: 'screenshot' }).total).toBe(1)
    manager.service().update({ retention: { screenshotsDays: 7, capturesDays: 90, notesDays: null } })
    expect(store.items({ kind: 'screenshot' }).total).toBe(0)
  })

  it('clears a range and reports the dates and count', () => {
    enable()
    const store = manager.profile('default').store
    store.addVisit({ url: 'https://a.com', title: 'A', at: Date.now() - 1000 })
    store.addVisit({ url: 'https://a.com', title: 'A', at: at(2026, 10, 20, 10) })
    expect(manager.service().clear('today')).toEqual({ deleted: 1, from: at(2026, 10, 28), to: Date.now() })
    expect(manager.service().clear('all')).toMatchObject({ deleted: 1, from: null })
  })

  it('writes an hourly note into the active companion’s memory', async () => {
    enable()
    manager.onVisit(visit('https://example.com/kyoto'), page('https://example.com/kyoto'))
    await vi.advanceTimersByTimeAsync(21_000)
    expect(await manager.writeHourlyNotes()).toBe(0)
    vi.setSystemTime(Date.now() + 61 * 60_000)
    expect(await manager.writeHourlyNotes()).toBe(1)
    expect(completions).toBe(1)
    expect(notes[0]).toMatchObject({ path: '/memories/activity/2026-10-28.md', owner: 'pip' })
    expect(notes[0]?.text).toContain('- You read about Kyoto.')
    expect(manager.service().items({ kind: 'note' }).total).toBe(1)
    // Nothing new in the next hour: no model call.
    vi.setSystemTime(Date.now() + 61 * 60_000)
    expect(await manager.writeHourlyNotes()).toBe(0)
    expect(completions).toBe(1)
  })

  it('serves search_activity only when on, and per chat', async () => {
    const setup: ToolSetup = { companionId: 'pip', browser: true, memory: true, routine: false, private: false, flags: {}, workspace: { folders: false, tables: false, apps: false, calendar: false, activity: true } }
    expect(searchActivityTool.enabled(setup)).toBe(true)
    expect(searchActivityTool.enabled({ ...setup, private: true })).toBe(false)
    expect(searchActivityTool.enabled({ ...setup, workspace: { ...setup.workspace, activity: false } })).toBe(false)
    bindActivitySearch({ offeredTo: (id) => manager.offeredTo(id), search: (q) => manager.search(q), enabled: () => manager.service().settings().enabled })
    const chat = '00000000-0000-4000-8000-000000000001'
    expect(activityOffered(chat)).toBe(false)
    enable()
    expect(activityOffered(chat)).toBe(true)
    manager.service().includeInChat(chat, false)
    expect(activityOffered(chat)).toBe(false)
    expect(manager.service().chatIncluded(chat)).toBe(false)
    manager.onVisit(visit('https://example.com/kyoto'), page('https://example.com/kyoto', { text: async () => 'Ryokan near the station' }))
    await vi.advanceTimersByTimeAsync(21_000)
    const ctx = { chatId: chat, companionId: 'pip', isPrivate: false, isRoutine: false, signal: new AbortController().signal, emit: () => undefined, ask: async () => { throw new Error('no') } }
    expect((await searchActivityTool.run({ query: 'ryokan' }, ctx)).content).toMatch(/off for this chat/)
    manager.service().includeInChat(chat, true)
    expect(manager.service().chatIncluded(chat)).toBe(true)
    const result = await searchActivityTool.run({ query: 'ryokan' }, ctx)
    expect(JSON.parse(result.content).results[0]).toMatchObject({ kind: 'capture', url: 'https://example.com/kyoto' })
    expect((await searchActivityTool.run({ query: 'ryokan' }, { ...ctx, isPrivate: true })).isError).toBe(true)
    manager.service().update({ enabled: false })
    expect((await searchActivityTool.run({ query: 'ryokan' }, ctx)).content).toMatch(/off/)
    bindActivitySearch(null)
  })

  it('keeps a chat’s switch across restarts, and tells new chats when activity memory is on', () => {
    const chat = '00000000-0000-4000-8000-000000000002'
    manager.service().includeInChat(chat, false)
    const again = new ActivityManager({ dataDirFor: () => base, currentProfile: () => 'default', flags: () => ({}), complete: async () => '', activeCompanion: () => null, memory: null, broadcast: () => undefined })
    expect(again.service().chatIncluded(chat)).toBe(false)
    expect(again.service().chatIncluded('another')).toBe(true)
    again.dispose()
    registerSearchActivity()
    const base0 = { companionId: 'pip', browser: true, memory: true, routine: false, private: false, flags: {} }
    bindActivitySearch({ offeredTo: () => true, search: () => [], enabled: () => true })
    expect(workspaceSetup(base0, () => false).activity).toBe(true)
    expect(workspaceSetup({ ...base0, private: true }, () => false).activity).toBe(false)
    bindActivitySearch({ offeredTo: () => true, search: () => [], enabled: () => false })
    expect(workspaceSetup(base0, () => false).activity).toBe(false)
    bindActivitySearch(null)
  })
})

describe('hourly note text', () => {
  it('appends under a time heading and keeps the prompt within budget', () => {
    const from = at(2026, 10, 28, 9)
    const to = at(2026, 10, 28, 10)
    expect(activityNotePath(to)).toBe('/memories/activity/2026-10-28.md')
    const first = appendNote('', from, to, '- one')
    expect(first).toBe('# Activity on 2026-10-28\n\n## 09:00–10:00\n\n- one\n')
    expect(appendNote(first, to, to + 3_600_000, '- two')).toContain('## 10:00–11:00\n\n- two')
    const items = Array.from({ length: 100 }, (_, i) => ({ id: String(i), kind: 'capture' as const, at: from + i, url: `https://e.com/${i}`, title: 'T', text: 'x'.repeat(3000), media: null }))
    expect(notesPrompt(items).length).toBeLessThan(45_000)
  })

  it('caps tool results', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i), kind: 'capture' as const, at: i, url: 'https://e.com', title: 'T', text: 'y'.repeat(2000), media: null }))
    expect(formatResults(items).length).toBeLessThanOrEqual(50_000)
    expect(JSON.parse(formatResults(items)).truncated).toBe(true)
  })
})

describe('the chrome’s activity logic', () => {
  const t = (key: string, vars?: Record<string, string | number>): string => (vars ? `${key}(${Object.values(vars).join(',')})` : key)

  it('words the status, with the time a pause or override ends', () => {
    const now = at(2026, 10, 28, 10)
    expect(statusLine({ state: 'capturing', pausedUntil: null, overrideUntil: null, nextChange: null }, now, t as never)).toBe('memory.activity.state.capturing')
    expect(statusLine({ state: 'paused', pausedUntil: at(2026, 10, 28, 11, 30), overrideUntil: null, nextChange: null }, now, t as never)).toMatch(/^memory.activity.state.paused memory.activity.until\(11:30( AM)?\)$/)
    expect(statusLine({ state: 'off', pausedUntil: null, overrideUntil: null, nextChange: null }, now, t as never)).toBe('memory.activity.state.off')
  })

  it('toggles day chips in order and offers whole hours for “capture until”', () => {
    expect(toggleDay([1, 2, 3], 2)).toEqual([1, 3])
    expect(toggleDay([5, 1], 0)).toEqual([0, 1, 5])
    const now = at(2026, 10, 28, 10, 20)
    expect(untilChoices(now, 2)).toEqual([at(2026, 10, 28, 11), at(2026, 10, 28, 12)])
  })

  it('shows the + menu switch only while on and not private', () => {
    expect(activityRows(null, false, 'Activity memory')).toEqual([])
    expect(activityRows({ enabled: false, included: true }, false, 'Activity memory')).toEqual([])
    expect(activityRows({ enabled: true, included: true }, true, 'Activity memory')).toEqual([])
    const rows = activityRows({ enabled: true, included: false }, false, 'Activity memory')
    expect(rows.map((r) => r.kind)).toEqual(['separator', 'item'])
    expect(rows[1]).toMatchObject({ id: ACTIVITY_ROW_ID, checked: false })
  })

  it('asks the inspector for one local day, a kind and the words typed', () => {
    const q = inspectorQuery('2026-10-25', 'note', '  kyoto  ', 50)
    expect(q).toMatchObject({ kind: 'note', query: 'kyoto', offset: 0, limit: 50 })
    expect(q.to - q.from + 1).toBe(25 * 3_600_000)
    expect(inspectorQuery('2026-10-28', 'all', '', 10)).not.toHaveProperty('kind')
    expect(inspectorQuery('2026-10-28', 'all', ' ', 10)).not.toHaveProperty('query')
  })

  it('shows each clear range’s dates', () => {
    const now = at(2026, 10, 28, 10)
    expect(clearRangeText({ from: null, to: now }, now, t as never)).toBe('memory.activity.clearEverything')
    expect(clearRangeText(clearRange('today', now), now, t as never, 'en-GB')).toMatch(/28/)
    expect(clearRangeText(clearRange('week', now), now, t as never, 'en-GB')).toMatch(/^memory.activity.clearRange\(.*22.*,.*28.*\)$/)
  })

  it('keeps the job list current from memory-job events, running first', () => {
    const job = (id: string, state: MemoryJob['state'], owner = 'shared'): MemoryJob => ({ id, kind: 'build', owner, state, done: 1, total: 3, chatId: null })
    let jobs = upsertJob([], job('a', 'done'))
    jobs = upsertJob(jobs, job('b', 'running'))
    jobs = upsertJob(jobs, job('a', 'interrupted'))
    expect(jobs.map((j) => `${j.id}:${j.state}`)).toEqual(['b:running', 'a:interrupted'])
    expect(jobsFor([job('x', 'done'), job('y', 'running'), job('z', 'running', 'pip')], 'shared').map((j) => j.id)).toEqual(['y', 'x'])
    expect([canRetry(job('a', 'failed')), canRetry(job('a', 'interrupted')), canRetry(job('a', 'running')), canRetry(job('a', 'done'))]).toEqual([true, true, false, false])
  })
})
