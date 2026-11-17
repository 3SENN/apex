/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS, SHARED_OWNER, type ChatSummary } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import { ROUTINE_CHANGED_ELSEWHERE, isPastRoutine, type RoutineSchedule } from '@shared/routines'
import type { ClientToolContext } from '../src/main/agent/tools/registry'
import { migrateSchedule, nextRunAfter, previewSchedule, validateSchedule } from '../src/main/routines/schedule'
import { RoutineStore } from '../src/main/routines/store'
import { RoutineSuggestions, STARTER_SUGGESTIONS, morningSites, repeatedPrompts } from '../src/main/routines/suggestions'
import { skillRoutineTools } from '../src/main/routines/tools'
import { wallTime } from '../src/main/routines/zone'
import { SkillStore } from '../src/main/skills/store'

const UTC = 'UTC'
const at = (iso: string): number => Date.parse(iso)
const iso = (ts: number | null): string | null => (ts === null ? null : new Date(ts).toISOString())

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-routines-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('daily schedules', () => {
  it('runs every day when no days are picked, and only on picked days otherwise', () => {
    const from = at('2026-10-30T10:00:00Z') // a Friday
    expect(iso(nextRunAfter({ kind: 'daily', time: '08:30', days: [] }, from, UTC))).toBe('2026-10-31T08:30:00.000Z')
    expect(iso(nextRunAfter({ kind: 'daily', time: '08:30', days: [1, 2, 3, 4, 5] }, from, UTC))).toBe('2026-11-02T08:30:00.000Z')
    expect(iso(nextRunAfter({ kind: 'daily', time: '11:00', days: [0, 6] }, from, UTC))).toBe('2026-10-31T11:00:00.000Z')
  })

  it('keeps 08:00 local through a DST change', () => {
    const zone = 'Europe/Amsterdam'
    const runs = previewSchedule({ kind: 'daily', time: '08:00', days: [] }, zone, 4, at('2026-10-23T12:00:00Z'))
    expect(runs.map((r) => wallTime(r, zone).hour)).toEqual([8, 8, 8, 8])
  })

  it('rejects a time that is not HH:MM', () => {
    expect(() => validateSchedule({ kind: 'daily', time: '8:30', days: [] })).toThrow(/24-hour time/)
    expect(() => validateSchedule({ kind: 'daily', time: '24:00', days: [] })).toThrow()
  })
})

describe('interval schedules', () => {
  it('repeats from the last run without a window', () => {
    const from = at('2026-11-02T10:07:00Z')
    expect(nextRunAfter({ kind: 'interval', minutes: 45 }, from, UTC)).toBe(from + 45 * 60_000)
  })

  it('lines runs up inside the window and jumps to the next day after it', () => {
    const s: RoutineSchedule = { kind: 'interval', minutes: 30, between: { start: 540, end: 1020 } }
    expect(iso(nextRunAfter(s, at('2026-11-02T06:00:00Z'), UTC))).toBe('2026-11-02T09:00:00.000Z')
    expect(iso(nextRunAfter(s, at('2026-11-02T09:10:00Z'), UTC))).toBe('2026-11-02T09:30:00.000Z')
    // 16:30 is the last run of the day; the end hour itself is not included.
    expect(iso(nextRunAfter(s, at('2026-11-02T16:30:00Z'), UTC))).toBe('2026-11-03T09:00:00.000Z')
  })

  it('honours days on an interval', () => {
    const s: RoutineSchedule = { kind: 'interval', minutes: 60, between: { start: 480, end: 600 }, days: [6] }
    expect(iso(nextRunAfter(s, at('2026-10-29T12:00:00Z'), UTC))).toBe('2026-10-31T08:00:00.000Z')
  })

  it('keeps intervals between 30 minutes and a day, and the window in order', () => {
    expect(() => validateSchedule({ kind: 'interval', minutes: 20 })).toThrow(/30 minutes/)
    expect(() => validateSchedule({ kind: 'interval', minutes: 1500 })).toThrow(/30 minutes/)
    expect(() => validateSchedule({ kind: 'interval', minutes: 60, between: { start: 1020, end: 540 } })).toThrow(/start before/)
    expect(() => validateSchedule({ kind: 'interval', minutes: 60, between: { start: 0, end: 1500 } })).toThrow(/minutes of the day/)
  })
})

describe('one-off tasks', () => {
  it('runs once at its time and then has no next run', () => {
    const s: RoutineSchedule = { kind: 'once', at: at('2026-11-05T10:00:00Z') }
    expect(nextRunAfter(s, at('2026-11-01T00:00:00Z'), UTC)).toBe(at('2026-11-05T10:00:00Z'))
    expect(nextRunAfter(s, at('2026-11-05T10:00:00Z'), UTC)).toBeNull()
    expect(() => validateSchedule(s, { now: at('2026-11-06T00:00:00Z'), requireFuture: true })).toThrow(/future/)
  })

  it('sits in Past once it ran', () => {
    expect(isPastRoutine({ schedule: { kind: 'once', at: 1 }, lastRunAt: 2, nextRunAt: null })).toBe(true)
    expect(isPastRoutine({ schedule: { kind: 'once', at: 1 }, lastRunAt: null, nextRunAt: null })).toBe(false)
    expect(isPastRoutine({ schedule: { kind: 'daily', time: '08:00', days: [] }, lastRunAt: 2, nextRunAt: null })).toBe(false)
  })
})

describe('legacy schedules', () => {
  it('turns hours into minutes, a week into cron, and clamps the rest with a notice', () => {
    expect(migrateSchedule({ kind: 'interval', hours: 6 })).toEqual({ schedule: { kind: 'interval', minutes: 360 }, notice: null })
    const week = migrateSchedule({ kind: 'interval', hours: 168 }, at('2026-11-02T09:15:00Z'), UTC)
    expect(week).toEqual({ schedule: { kind: 'cron', expr: '15 9 * * 1' }, notice: null })
    const clamped = migrateSchedule({ kind: 'interval', hours: 48 })
    expect(clamped.schedule).toEqual({ kind: 'interval', minutes: 1440 })
    expect(clamped.notice).toMatch(/48 hours/)
  })

  it('migrates the original routines.json on load', () => {
    writeFileSync(
      join(dir, 'routines.json'),
      JSON.stringify([{ id: 'r1', name: 'Old', prompt: 'Do it', schedule: { kind: 'interval', hours: 72 }, enabled: true, lastRunAt: null, nextRunAt: null, lastChatId: null, lastStatus: null, owner: SHARED_OWNER }]),
    )
    const r = new RoutineStore(dir).get('r1')!
    expect(r.schedule).toEqual({ kind: 'interval', minutes: 1440 })
    expect(r.notice).toMatch(/72 hours/)
    expect(r.revision).toBeGreaterThan(0)
    expect(r.destination).toEqual({ kind: 'new-chat' })
    expect(r.timeZone).toBeNull()
  })
})

describe('the routine store', () => {
  const base = { name: 'Morning brief', prompt: 'Sum up my morning', schedule: { kind: 'daily', time: '08:00', days: [] } as RoutineSchedule, enabled: true }

  it('refuses a save over a newer revision with changed-elsewhere', () => {
    const store = new RoutineStore(dir)
    const first = store.save(base)
    const second = store.save({ ...base, id: first.id, revision: first.revision, name: 'Brief' })
    expect(second.revision).toBe(first.revision + 1)
    expect(() => store.save({ ...base, id: first.id, revision: first.revision, name: 'Stale' })).toThrow(ROUTINE_CHANGED_ELSEWHERE)
    expect(store.get(first.id)!.name).toBe('Brief')
  })

  it('names each missing field', () => {
    const store = new RoutineStore(dir)
    expect(() => store.save({ ...base, name: ' ' })).toThrow(/name/)
    expect(() => store.save({ ...base, prompt: '' })).toThrow(/what to do/)
  })

  it('refuses private and deleted chats as the destination', () => {
    const store = new RoutineStore(dir)
    store.bind({ chatProblem: (id) => (id === 'secret' ? 'private' : id === 'gone' ? 'missing' : null) })
    expect(() => store.save({ ...base, destination: { kind: 'append', chatId: 'secret' } })).toThrow(/Private chats/)
    expect(() => store.save({ ...base, destination: { kind: 'append', chatId: 'gone' } })).toThrow(/deleted/)
    expect(store.save({ ...base, destination: { kind: 'append', chatId: 'ok' } }).destination).toEqual({ kind: 'append', chatId: 'ok' })
  })

  it('waits for a companion when its own was deleted', () => {
    const store = new RoutineStore(dir)
    let alive = true
    store.bind({ companionExists: () => alive })
    const r = store.save({ ...base, companionId: 'ava' })
    expect(r.needsCompanion).toBe(false)
    alive = false
    store.removeOwned('ava')
    expect(store.get(r.id)!.needsCompanion).toBe(true)
    expect(() => store.save({ ...base, id: r.id, companionId: 'ava' })).toThrow(/Pick a companion/)
    alive = true
    expect(store.save({ ...base, id: r.id, companionId: SHARED_OWNER }).needsCompanion).toBe(false)
  })

  it('filters by status, kind and words, and sorts by next run', () => {
    const store = new RoutineStore(dir)
    const now = Date.now()
    const a = store.save({ ...base, name: 'Zed', schedule: { kind: 'interval', minutes: 30 } })
    const b = store.save({ ...base, name: 'Alpha', schedule: { kind: 'once', at: now + 86_400_000 } })
    const c = store.save({ ...base, name: 'Paused one', enabled: false })
    expect(store.query({ status: 'paused' }).map((r) => r.id)).toEqual([c.id])
    expect(store.query({ kind: 'once' }).map((r) => r.id)).toEqual([b.id])
    expect(store.query({ query: 'zed' }).map((r) => r.id)).toEqual([a.id])
    expect(store.query({ sort: 'name' }).map((r) => r.name)).toEqual(['Alpha', 'Paused one', 'Zed'])
    expect(store.query({ status: 'active', sort: 'next-run' }).map((r) => r.id)).toEqual([a.id, b.id])
  })
})

function fakeCtx(overrides: Partial<ClientToolContext> = {}): ClientToolContext & { events: AgentEvent[] } {
  const events: AgentEvent[] = []
  return {
    chatId: 'chat-1',
    companionId: 'ava',
    isPrivate: false,
    isRoutine: false,
    signal: new AbortController().signal,
    emit: (e) => void events.push(e),
    ask: () => Promise.reject(new Error('not used')),
    events,
    ...overrides,
  }
}

describe('propose_routine and list_routines', () => {
  const tools = (): ReturnType<typeof skillRoutineTools> => skillRoutineTools({ routines: new RoutineStore(dir), skills: new SkillStore(dir, { builtins: [] }), now: () => at('2026-11-02T07:00:00Z') })

  it('shows a proposal card without saving anything', async () => {
    const [propose] = tools()
    const ctx = fakeCtx()
    const input = propose!.parse.parse({ name: 'Brief', prompt: 'Brief me', schedule: { kind: 'daily', time: '08:00', days: [] }, destination: 'this-chat', timeZone: UTC })
    const result = await propose!.run(input, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toMatch(/not saved yet/)
    expect(ctx.events).toHaveLength(1)
    const event = ctx.events[0] as Extract<AgentEvent, { type: 'routine-proposal' }>
    expect(event.type).toBe('routine-proposal')
    expect(event.draft).toMatchObject({ name: 'Brief', companionId: 'ava', destination: { kind: 'append', chatId: 'chat-1' } })
  })

  it('never appends to a private chat, and reports a bad schedule as an error', async () => {
    const [propose] = tools()
    const ctx = fakeCtx({ isPrivate: true })
    await propose!.run(propose!.parse.parse({ name: 'B', prompt: 'p', schedule: { kind: 'interval', minutes: 60 }, destination: 'this-chat' }), ctx)
    expect((ctx.events[0] as Extract<AgentEvent, { type: 'routine-proposal' }>).draft.destination).toEqual({ kind: 'new-chat' })
    const bad = await propose!.run(propose!.parse.parse({ name: 'B', prompt: 'p', schedule: { kind: 'once', at: at('2026-01-01T00:00:00Z') } }), fakeCtx())
    expect(bad.isError).toBe(true)
  })

  it('lists routines as cards and as text', async () => {
    const routines = new RoutineStore(dir)
    routines.save({ name: 'Brief', prompt: 'p', schedule: { kind: 'interval', minutes: 60 }, enabled: true })
    const [, list] = skillRoutineTools({ routines, skills: new SkillStore(dir, { builtins: [] }) })
    const ctx = fakeCtx()
    const result = await list!.run(list!.parse.parse({}), ctx)
    expect(JSON.parse(result.content)).toHaveLength(1)
    expect(ctx.events[0]).toMatchObject({ type: 'routine-list' })
  })
})

const chat = (id: string, title: string, createdAt: number, extra: Partial<ChatSummary> = {}): ChatSummary => ({
  ...CHAT_SUMMARY_FLAG_DEFAULTS,
  ...CHAT_SUMMARY_LINK_DEFAULTS,
  id,
  title,
  createdAt,
  updatedAt: createdAt,
  companionId: 'ava',
  ...extra,
}) as ChatSummary

describe('suggested routines', () => {
  const now = at('2026-11-02T12:00:00Z')
  const day = 86_400_000

  it('starts with the original starter set, and hides dismissed ones and names already saved', () => {
    const s = new RoutineSuggestions({ dataDir: dir, proactive: () => ({ routines: false, excluded: null }), chats: () => [], isExcluded: () => false, routineNames: () => [STARTER_SUGGESTIONS[1]!.draft.name], now: () => now })
    const ids = s.list().map((x) => x.id)
    expect(ids).toEqual(STARTER_SUGGESTIONS.filter((_, i) => i !== 1).map((x) => x.id))
    s.dismiss(ids[0]!)
    const again = new RoutineSuggestions({ dataDir: dir, proactive: () => ({ routines: false, excluded: null }), chats: () => [], isExcluded: () => false, routineNames: () => [], now: () => now })
    expect(again.list().map((x) => x.id)).not.toContain(ids[0])
  })

  it('suggests repeated prompts only when proactive.routines is on, skipping private chats', () => {
    const chats = [1, 2, 3].map((d) => chat(`c${d}`, 'Summarise the news for me', now - d * day))
    const hidden = [1, 2, 3].map((d) => chat(`p${d}`, 'My private question here', now - d * day, { private: true }))
    expect(repeatedPrompts([...chats, ...hidden], now).map((s) => s.title)).toEqual(['Summarise the news for me'])
    const off = new RoutineSuggestions({ dataDir: dir, proactive: () => ({ routines: false, excluded: null }), chats: () => chats, isExcluded: () => false, routineNames: () => [], now: () => now })
    expect(off.list().some((s) => s.id.startsWith('prompt-'))).toBe(false)
    const on = new RoutineSuggestions({ dataDir: dir, proactive: () => ({ routines: true, excluded: null }), chats: () => chats, isExcluded: () => false, routineNames: () => [], now: () => now })
    expect(on.list().some((s) => s.id.startsWith('prompt-'))).toBe(true)
  })

  it('suggests regular morning sites, respecting exclusions', () => {
    const sites = (): { origin: string; title: string; visits: number; activeMs: number; lastVisit: number }[] => [
      { origin: 'https://news.example', title: 'News', visits: 2, activeMs: 1, lastVisit: now },
      { origin: 'https://bank.example', title: 'Bank', visits: 2, activeMs: 1, lastVisit: now },
    ]
    const picked = morningSites(sites, now, (url) => url.includes('bank'))
    expect(picked.map((s) => s.title)).toEqual(['What’s new on news.example'])
  })
})

// ---- the editor's logic (renderer, settings/logic/routines.ts) ----
import * as R from '../src/renderer/src/settings/logic/routines'

describe('the routine editor form', () => {
  const now = at('2026-11-02T07:00:00Z')
  const ctx = { companionExists: (id: string) => id === 'ava', skillExists: (id: string) => id === 'sk', now }
  const form = (patch: Partial<R.RoutineEditorForm> = {}): R.RoutineEditorForm => ({ ...R.routineEditorForm({ fallbackCompanion: SHARED_OWNER, now }), name: 'Brief', prompt: 'Brief me', ...patch })

  it('names each missing field', () => {
    const errors = R.routineEditorErrors(form({ name: ' ', prompt: '', companionId: '', destination: 'append', chatId: '' }), ctx)
    expect(Object.keys(errors).sort()).toEqual(['companion', 'destination', 'name', 'task'])
    expect(R.routineEditorErrors(form({ task: 'skill', skillId: 'gone' }), ctx).task).toMatch(/no longer exists/)
    expect(R.routineEditorErrors(form({ companionId: 'bo' }), ctx).companion).toMatch(/Pick a companion/)
    expect(R.routineEditorErrors(form(), ctx)).toEqual({})
  })

  it('turns each timing kind into a schedule, or says what to fix', () => {
    const base = R.defaultTiming(now, UTC)
    expect(R.timingToSchedule({ ...base, kind: 'daily', time: '07:30', days: [0, 1, 2, 3, 4, 5, 6] }, UTC, now)).toEqual({ schedule: { kind: 'daily', time: '07:30', days: [] } })
    expect(R.timingToSchedule({ ...base, kind: 'interval', minutes: 30, windowOn: true, start: 9, end: 17, intervalDays: [5, 1] }, UTC, now)).toEqual({ schedule: { kind: 'interval', minutes: 30, between: { start: 540, end: 1020 }, days: [1, 5] } })
    expect(R.timingToSchedule({ ...base, kind: 'interval', windowOn: true, start: 17, end: 9 }, UTC, now)).toEqual({ error: expect.stringMatching(/start before/) })
    expect(R.timingToSchedule({ ...base, kind: 'cron', expr: ' 0  9 * * 1-5 ' }, UTC, now)).toEqual({ schedule: { kind: 'cron', expr: '0 9 * * 1-5' } })
    expect(R.timingToSchedule({ ...base, kind: 'cron', expr: '0 9 *' }, UTC, now)).toEqual({ error: expect.stringMatching(/five fields/) })
    expect(R.timingToSchedule({ ...base, kind: 'once', date: '2026-11-03', onceTime: '09:15' }, UTC, now)).toEqual({ schedule: { kind: 'once', at: at('2026-11-03T09:15:00Z') } })
    expect(R.timingToSchedule({ ...base, kind: 'once', date: '2026-11-01', onceTime: '09:15' }, UTC, now)).toEqual({ error: 'Pick a time in the future.' })
  })

  it('reads saved schedules back into the form, legacy hours and windows included', () => {
    expect(R.timingFromSchedule({ kind: 'interval', hours: 3 }, null, now)).toMatchObject({ kind: 'interval', minutes: 180 })
    expect(R.timingFromSchedule({ kind: 'interval', minutes: 60, between: { start: 540, end: 1020 } }, null, now)).toMatchObject({ windowOn: true, start: 9, end: 17 })
    expect(R.timingFromSchedule({ kind: 'once', at: at('2026-11-03T09:15:00Z') }, 'Asia/Tokyo', now)).toMatchObject({ kind: 'once', date: '2026-11-03', onceTime: '18:15' })
  })

  it('converts wall times in a zone both ways, across DST', () => {
    expect(R.wallToEpoch('2026-07-01', '08:00', 'Europe/Amsterdam')).toBe(at('2026-07-01T06:00:00Z'))
    expect(R.wallToEpoch('2026-12-01', '08:00', 'Europe/Amsterdam')).toBe(at('2026-12-01T07:00:00Z'))
    expect(R.epochToWall(at('2026-12-01T07:00:00Z'), 'Europe/Amsterdam')).toEqual(['2026-12-01', '08:00'])
    expect(R.wallToEpoch('2026-13-01', '08:00', UTC)).toBeNull()
  })

  it('builds the save input with the revision, and refuses an invalid form', () => {
    const input = R.routineEditorInput(form({ task: 'skill', skillId: 'sk', destination: 'append', chatId: 'c1', timeZone: UTC }), { id: 'r1', revision: 4, now })
    expect(input).toMatchObject({ id: 'r1', revision: 4, skillId: 'sk', destination: { kind: 'append', chatId: 'c1' }, timeZone: UTC, companionId: SHARED_OWNER })
    expect(R.routineEditorInput(form({ timing: { ...R.defaultTiming(now), kind: 'cron', expr: '' } }), { now })).toBeNull()
  })

  it('reads as one sentence', () => {
    expect(R.routineSentence({ when: 'Weekdays at 08:00', who: 'Ava', skillName: 'weekly-review', prompt: '' })).toBe('Weekdays at 08:00, Ava runs /weekly-review.')
    expect(R.routineSentence({ when: 'Every hour', who: 'the active companion', skillName: null, prompt: 'x' })).toBe('Every hour, the active companion does this.')
  })

  it('describes schedules and the zone when it isn’t local', () => {
    expect(R.describeTiming({ kind: 'interval', minutes: 30, between: { start: 540, end: 1020 }, days: [1, 2, 3, 4, 5] }, null, 'en-GB')).toBe('Every 30 minutes between 09:00 and 17:00, weekdays')
    expect(R.describeTiming({ kind: 'cron', expr: '0 9 * * 1' }, null)).toBe('Custom: 0 9 * * 1')
    const zone = R.localTimeZone() === 'Asia/Tokyo' ? 'Europe/Paris' : 'Asia/Tokyo'
    expect(R.describeTiming({ kind: 'daily', time: '08:00', days: [] }, zone, 'en-GB')).toMatch(/\(.+\)$/)
  })

  it('finds time zones by any part of their name, and labels them', () => {
    const zones = ['America/New_York', 'Europe/Amsterdam', 'Asia/Tokyo']
    expect(R.searchTimeZones(zones, 'new york')).toEqual(['America/New_York'])
    expect(R.searchTimeZones(zones, 'europe')).toEqual(['Europe/Amsterdam'])
    expect(R.timeZoneLabel('America/New_York')).toBe('New York (America)')
    expect(R.timeZoneList().length).toBeGreaterThan(100)
  })

  it('knows day presets, run dots and the Past group', () => {
    expect(R.dayPresetOf([5, 4, 3, 2, 1])).toBe('weekdays')
    expect(R.dayPresetOf([0, 6])).toBe('weekends')
    expect(R.dayPresetOf([])).toBe('every')
    expect(R.dayPresetOf([2])).toBe('custom')
    expect(R.runRecordDot({ status: 'ok', read: false })).toBe('unread')
    expect(R.runRecordDot({ status: 'ok', read: true })).toBe('success')
    expect(R.runRecordDot({ status: 'needs-input', read: true })).toBe('needs-input')
    const once = { schedule: { kind: 'once' as const, at: 1 }, lastRunAt: 5, nextRunAt: null }
    const daily = { schedule: { kind: 'daily' as const, time: '08:00', days: [] }, lastRunAt: 5, nextRunAt: 9 }
    expect(R.splitPast([once, daily])).toEqual({ current: [daily], past: [once] })
    expect(R.intervalLabel(1440)).toBe('Once a day')
    expect(R.intervalLabel(90)).toBe('Every 1.5 hours')
  })
})
