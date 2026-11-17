/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SHARED_OWNER } from '@shared/chats'
import { ROUTINE_RUNS_KEPT } from '@shared/routines'
import { CATCH_UP_AFTER_MS, RoutineRunner, dueRoutines, routinePrompt, runStatusOf } from '../src/main/routines'
import { RoutineRunStore } from '../src/main/routines/runs'
import { RoutineStore } from '../src/main/routines/store'
import { FakeHost } from './helpers/fakeHost'

let dir: string
let runs: RoutineRunStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apex-runs-'))
  runs = new RoutineRunStore(join(dir, 'routines.sqlite'))
})
afterEach(() => {
  runs.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the runs store', () => {
  it('records a run from start to finish, newest first', () => {
    const a = runs.start({ routineId: 'r1', scheduledFor: 100, trigger: 'schedule', startedAt: 100 })
    const b = runs.start({ routineId: 'r1', scheduledFor: 200, trigger: 'manual', startedAt: 200 })
    expect(a).toMatchObject({ status: 'running', chatId: null, finishedAt: null, read: false })
    runs.finish(a.id, { status: 'ok', chatId: 'chat-a', finishedAt: 150 })
    const listed = runs.list({ routineId: 'r1' })
    expect(listed.total).toBe(2)
    expect(listed.runs.map((r) => r.id)).toEqual([b.id, a.id])
    expect(listed.runs[1]).toMatchObject({ status: 'ok', chatId: 'chat-a', finishedAt: 150, trigger: 'schedule' })
  })

  it('pages, filters unread and marks everything read', () => {
    for (let i = 0; i < 5; i++) runs.start({ routineId: i % 2 ? 'r1' : 'r2', scheduledFor: i, trigger: 'schedule', startedAt: i })
    expect(runs.list({ limit: 2, offset: 2 }).runs.map((r) => r.startedAt)).toEqual([2, 1])
    expect(runs.list({ unreadOnly: true }).total).toBe(5)
    runs.markRead('r1')
    expect(runs.unreadCount()).toBe(3)
    runs.markRead()
    expect(runs.list({ unreadOnly: true }).total).toBe(0)
  })

  it('reads a finished run when its chat is opened, but not one still running', () => {
    const done = runs.start({ routineId: 'r1', scheduledFor: 1, trigger: 'schedule', startedAt: 1 })
    runs.finish(done.id, { status: 'ok', chatId: 'c1', finishedAt: 2 })
    runs.markChatsRead(['c1'])
    expect(runs.get(done.id)!.read).toBe(true)
  })

  it(`keeps the newest ${ROUTINE_RUNS_KEPT} runs per routine`, () => {
    for (let i = 0; i < ROUTINE_RUNS_KEPT + 3; i++) runs.start({ routineId: 'r1', scheduledFor: i, trigger: 'schedule', startedAt: i })
    runs.start({ routineId: 'other', scheduledFor: 0, trigger: 'schedule', startedAt: 0 })
    const kept = runs.list({ routineId: 'r1', limit: 1000 })
    expect(kept.total).toBe(ROUTINE_RUNS_KEPT)
    expect(Math.min(...kept.runs.map((r) => r.startedAt))).toBe(3)
    expect(runs.list({ routineId: 'other' }).total).toBe(1)
  })

  it('marks runs that were going when Apex quit as stopped', () => {
    const r = runs.start({ routineId: 'r1', scheduledFor: 1, trigger: 'schedule', startedAt: 1 })
    runs.close()
    runs = new RoutineRunStore(join(dir, 'routines.sqlite'))
    expect(runs.get(r.id)).toMatchObject({ status: 'stopped', finishedAt: 1 })
  })
})

describe('the runner', () => {
  const setup = (now: { t: number }): { store: RoutineStore; host: FakeHost; runner: RoutineRunner; notified: string[] } => {
    const store = new RoutineStore(dir)
    const host = new FakeHost()
    const notified: string[] = []
    const runner = new RoutineRunner({ store, run: () => Promise.reject(new Error('legacy path not used')), notify: (r) => void notified.push(r.id), now: () => now.t })
    runner.attach({ host, runs, activeCompanionId: () => 'ava', skillName: (id) => (id === 'sk' ? 'weekly-review' : null), canAppend: (id) => id !== 'private', patchChat: () => undefined })
    return { store, host, runner, notified }
  }

  it('runs a due routine through runBackground with its run record', async () => {
    const now = { t: Date.parse('2026-11-02T08:00:00Z') }
    const { store, host, runner, notified } = setup(now)
    const r = store.save({ name: 'Brief', prompt: 'Brief me', schedule: { kind: 'interval', minutes: 60 }, enabled: true }, now.t - 3_600_000)
    expect(r.nextRunAt).toBe(now.t)
    await runner.tick()
    expect(host.backgroundRuns).toHaveLength(1)
    const input = host.backgroundRuns[0]!
    expect(input).toMatchObject({ companionId: 'ava', prompt: 'Brief me', kind: 'routine', title: 'Brief' })
    const [record] = runs.list({ routineId: r.id }).runs
    expect(record).toMatchObject({ status: 'ok', trigger: 'schedule', chatId: input.chatId, scheduledFor: now.t })
    expect(input.routineRun).toEqual({ runId: record!.id, scheduledFor: now.t, trigger: 'schedule' })
    const after = store.get(r.id)!
    expect(after).toMatchObject({ lastRunAt: now.t, lastStatus: 'ok', lastChatId: input.chatId, nextRunAt: now.t + 3_600_000 })
    expect(notified).toEqual([r.id])
  })

  it('runs a missed run once, as a catch-up', async () => {
    const now = { t: Date.parse('2026-11-02T08:00:00Z') }
    const { store, host, runner } = setup(now)
    const r = store.save({ name: 'Brief', prompt: 'p', schedule: { kind: 'interval', minutes: 30 }, enabled: true }, now.t - 10 * 3_600_000)
    expect(now.t - r.nextRunAt!).toBeGreaterThan(CATCH_UP_AFTER_MS)
    await runner.tick()
    await runner.tick()
    expect(host.backgroundRuns).toHaveLength(1)
    expect(runs.list({ routineId: r.id }).runs.map((x) => x.trigger)).toEqual(['catch-up'])
    expect(store.get(r.id)!.nextRunAt).toBeGreaterThan(now.t)
  })

  it('records a manual run and moves a one-off task to Past', async () => {
    const now = { t: Date.parse('2026-11-02T08:00:00Z') }
    const { store, runner } = setup(now)
    const r = store.save({ name: 'Once', prompt: 'p', schedule: { kind: 'once', at: now.t + 86_400_000 }, enabled: true }, now.t)
    await runner.runNow(r.id)
    expect(runs.list({ routineId: r.id }).runs[0]).toMatchObject({ trigger: 'manual', status: 'ok' })
    expect(store.get(r.id)).toMatchObject({ nextRunAt: null, lastRunAt: now.t })
    expect(store.query({ status: 'past' }).map((x) => x.id)).toEqual([r.id])
  })

  it('never runs a routine waiting for a companion', async () => {
    const now = { t: Date.parse('2026-11-02T08:00:00Z') }
    const { store, host, runner } = setup(now)
    let alive = true
    store.bind({ companionExists: () => alive })
    const r = store.save({ name: 'B', prompt: 'p', schedule: { kind: 'interval', minutes: 30 }, enabled: true, companionId: 'bo' }, now.t - 3_600_000)
    alive = false
    await runner.tick()
    await runner.runNow(r.id)
    expect(host.backgroundRuns).toHaveLength(0)
    expect(runs.list({ routineId: r.id }).total).toBe(0)
  })

  it('records an error when the background run fails, and starts a new chat when appending is refused', async () => {
    const now = { t: Date.parse('2026-11-02T08:00:00Z') }
    const { store, host, runner } = setup(now)
    const r = store.save({ name: 'B', prompt: 'p', schedule: { kind: 'interval', minutes: 30 }, enabled: true, destination: { kind: 'append', chatId: 'private' } }, now.t)
    await runner.runNow(r.id)
    expect(host.backgroundRuns[0]!.appendTo).toBeUndefined()
    host.failWith = new Error('boom')
    await runner.runNow(r.id)
    expect(runs.list({ routineId: r.id }).runs[0]).toMatchObject({ status: 'error' })
    expect(store.get(r.id)!.lastStatus).toBe('error')
  })
})

describe('runner helpers', () => {
  it('maps chat end states to run statuses', () => {
    expect(runStatusOf({ ok: true, status: 'finished' })).toBe('ok')
    expect(runStatusOf({ ok: true, status: 'needs-approval' })).toBe('needs-input')
    expect(runStatusOf({ ok: false, status: 'finished' })).toBe('error')
    expect(runStatusOf({ ok: true, status: 'idle' })).toBe('stopped')
  })

  it('puts a skill’s /name before the instructions', () => {
    const name = (id: string): string | null => (id === 'sk' ? 'weekly-review' : null)
    expect(routinePrompt({ prompt: 'for work', skillId: 'sk' }, name)).toBe('/weekly-review for work')
    expect(routinePrompt({ prompt: '', skillId: 'sk' }, name)).toBe('/weekly-review')
    expect(routinePrompt({ prompt: 'plain', skillId: 'gone' }, name)).toBe('plain')
  })

  it('skips paused, running and companion-less routines', () => {
    const list = [
      { id: 'a', enabled: true, nextRunAt: 5 },
      { id: 'b', enabled: false, nextRunAt: 5 },
      { id: 'c', enabled: true, nextRunAt: 5, needsCompanion: true },
      { id: 'd', enabled: true, nextRunAt: 50 },
      { id: 'e', enabled: true, nextRunAt: 5 },
    ]
    expect(dueRoutines(list, 10, new Set(['e'])).map((r) => r.id)).toEqual(['a'])
    expect(SHARED_OWNER).toBe('shared')
  })
})
