/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isTidyDue, nextTidyAt, tidyBoundary, type TidyPass } from '@shared/activity'
import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS, type ChatSummary } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { MemoryFile, Owner } from '@shared/services'
import { TidyMemory, isRateLimit } from '../src/main/tidy'
import { pastDayLabel, tidyEntries } from '../src/renderer/src/companion-card/logic/notes'
import { FakeHost } from './helpers/fakeHost'

const previousTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'Europe/Amsterdam'
})
afterAll(() => {
  process.env.TZ = previousTz
})

const at = (d: number, h: number, m = 0, month = 10): number => new Date(2026, month - 1, d, h, m).getTime()

describe('when the nightly tidy is due (ST-48)', () => {
  it('runs once a night after the set hour', () => {
    expect(tidyBoundary(at(28, 4), 3)).toBe(at(28, 3))
    expect(tidyBoundary(at(28, 2), 3)).toBe(at(27, 3))
    expect(isTidyDue(at(28, 4), 3, at(27, 3, 10))).toBe(true)
    expect(isTidyDue(at(28, 4), 3, at(28, 3, 5))).toBe(false)
    expect(isTidyDue(at(28, 2), 3, at(27, 3, 5))).toBe(false)
    expect(isTidyDue(at(28, 2), 3, null)).toBe(true)
  })

  it('catches up at the next start after a missed night', () => {
    // Closed all of Monday night; opened Tuesday afternoon.
    expect(isTidyDue(at(28, 15), 3, at(26, 3, 5))).toBe(true)
  })

  it('names the next run, on DST nights too', () => {
    expect(nextTidyAt(at(28, 10), 3, at(28, 3, 5))).toBe(at(29, 3))
    expect(nextTidyAt(at(28, 10), 3, at(27, 3, 5))).toBe(at(28, 10))
    // Clocks go back on 25 Oct: the next 3:00 is still 3:00 local.
    expect(new Date(nextTidyAt(at(24, 10), 3, at(24, 3, 5))).getHours()).toBe(3)
    expect(new Date(nextTidyAt(at(28, 10, 0, 3), 2, at(28, 2, 30, 3))).getDate()).toBe(29)
  })

  it('recognizes provider limits', () => {
    expect(isRateLimit('429 Too Many Requests: rate_limit_error')).toBe(true)
    expect(isRateLimit('You exceeded your usage limit')).toBe(true)
    expect(isRateLimit('Network down')).toBe(false)
  })
})

const chat = (id: string, companionId: string, lastActiveAt: number, patch: Partial<ChatSummary> = {}): ChatSummary => ({
  id,
  title: `Chat ${id}`,
  createdAt: lastActiveAt - 1000,
  updatedAt: lastActiveAt,
  lastActiveAt,
  routineId: null,
  companionId,
  model: '',
  status: 'idle',
  unread: false,
  pinned: false,
  archived: false,
  needsInput: false,
  draft: false,
  ...CHAT_SUMMARY_FLAG_DEFAULTS,
  ...CHAT_SUMMARY_LINK_DEFAULTS,
  ...patch,
})

class FakeMemory extends EventEmitter<{ changed: [Owner, string] }> {
  files = new Map<string, string>()
  list(owner: Owner): MemoryFile[] {
    return [...this.files.keys()].filter((k) => k.startsWith(`${owner}:`)).map((k) => ({ path: k.slice(owner.length + 1), size: 1, modifiedAt: 1, owner, author: 'agent' }))
  }
  read(path: string, owner: Owner): string {
    return this.files.get(`${owner}:${path}`) ?? ''
  }
}

describe('TidyMemory', () => {
  let dir: string
  let host: FakeHost
  let memory: FakeMemory
  let now: number
  let ready: boolean
  let chats: ChatSummary[]
  const snapshots: string[] = []
  const passes: TidyPass[] = []
  const log: AgentEvent[] = [{ type: 'user-message', id: 'u1', text: 'I moved to Utrecht' }, { type: 'text-delta', turnId: 't', text: 'Noted!' }]

  const make = (): TidyMemory =>
    new TidyMemory({
      file: join(dir, 'tidy.json'),
      host,
      chats: { list: () => chats, load: () => ({ log }) },
      memory,
      companions: () => [{ id: 'pip', name: 'Pip' }, { id: 'bo', name: 'Bo' }],
      engineReady: () => ready,
      snapshot: (owner, path) => snapshots.push(`${owner}:${path}`),
      broadcast: (p) => passes.push(p),
      ownChats: new Set(),
      now: () => now,
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-tidy-'))
    host = new FakeHost()
    memory = new FakeMemory()
    memory.files.set('pip:/memories/home.md', 'Lives in Amsterdam')
    now = at(28, 4)
    ready = true
    chats = [chat('c1', 'pip', at(27, 20)), chat('c2', 'pip', at(27, 21), { private: true }), chat('c3', 'bo', at(20, 10))]
    snapshots.length = 0
    passes.length = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('is off by default and waits for tonight after being switched on', async () => {
    const tidy = make()
    expect(tidy.settings()).toEqual({ enabled: false, afterHour: 3 })
    await tidy.check()
    expect(host.backgroundRuns).toHaveLength(0)
    tidy.update({ enabled: true })
    await tidy.check()
    expect(host.backgroundRuns).toHaveLength(0)
    expect(tidy.schedule().nextAt).toBe(at(29, 3))
  })

  it('runs one pass per companion with new chats, snapshots notes first, and links the chat', async () => {
    const tidy = make()
    // Pretend it was switched on yesterday.
    now = at(27, 12)
    tidy.update({ enabled: true })
    now = at(28, 4)
    memory.on('changed', () => undefined)
    host.backgroundResult = { ok: true, status: 'finished' }
    const original = host.runBackground.bind(host)
    host.runBackground = async (input) => {
      memory.emit('changed', 'pip', '/memories/home.md')
      memory.emit('changed', 'pip', '/memories/city.md')
      memory.emit('changed', 'bo', '/memories/other.md')
      return original(input)
    }
    await tidy.check()
    expect(host.backgroundRuns).toHaveLength(1) // Bo's only chat is older than the 7-day lookback.
    const run = host.backgroundRuns[0]
    expect(run).toMatchObject({ companionId: 'pip', kind: 'tidy', capabilities: { memory: true, webTools: false, connectors: false } })
    expect(run?.prompt).toContain('I moved to Utrecht')
    expect(run?.prompt).not.toContain('c2')
    expect(snapshots).toEqual(['pip:/memories/home.md'])
    expect(passes[0]).toMatchObject({ companionId: 'pip', status: 'ok', notesChanged: 2, chatId: run?.chatId })
    expect(tidy.passes()).toHaveLength(1)
    // Done for tonight.
    await tidy.check()
    expect(host.backgroundRuns).toHaveLength(1)
    // State survives a restart.
    expect(make().passes()[0]?.chatId).toBe(run?.chatId)
  })

  it('skips with no engine ready, and stops the night after a rate limit', async () => {
    chats.push(chat('c4', 'bo', at(27, 22)))
    const tidy = make()
    ready = false
    await tidy.run()
    expect(passes.map((p) => [p.companionId, p.status])).toEqual([['pip', 'skipped'], ['bo', 'skipped']])
    expect(host.backgroundRuns).toHaveLength(0)
    passes.length = 0
    ready = true
    host.failWith = new Error('429 rate_limit_error')
    await tidy.run()
    expect(passes.map((p) => p.status)).toEqual(['skipped', 'skipped'])
    expect(passes[0]?.reason).toMatch(/rate limit/)
    expect(passes[1]?.reason).toBe(passes[0]?.reason)
  })

  it('records an error and reads the same chats again next time', async () => {
    const tidy = make()
    host.backgroundResult = { ok: false, status: 'error' }
    await tidy.run('pip')
    expect(passes[0]).toMatchObject({ status: 'error' })
    host.backgroundResult = { ok: true, status: 'finished' }
    await tidy.run('pip')
    expect(host.backgroundRuns[1]?.prompt).toContain('I moved to Utrecht')
  })
})

describe('the card’s tidy timeline (CO-09)', () => {
  const labels = { tonight: 'Tonight', today: 'Today', yesterday: 'Yesterday', after: (hour: string) => `after ${hour}` }
  const pass = (id: string, companionId: string, time: number, status: TidyPass['status'] = 'ok'): TidyPass => ({ id, companionId, chatId: `chat-${id}`, at: time, status, notesChanged: 2 })

  it('puts the next pass on top, then this companion’s passes newest first', () => {
    const now = at(29, 14)
    const entries = tidyEntries([pass('a', 'pip', at(28, 3)), pass('b', 'pip', at(29, 3, 5)), pass('c', 'other', at(29, 3))], 'pip', { enabled: true, afterHour: 3, nextAt: at(30, 3) }, now, labels)
    expect(entries.map((e) => e.kind)).toEqual(['next', 'pass', 'pass'])
    expect(entries[0]).toMatchObject({ day: 'Tonight', time: 'after 03:00' })
    expect(entries[1]).toMatchObject({ key: 'b', day: 'Today', time: '03:05' })
    expect(entries[2]).toMatchObject({ key: 'a', day: 'Yesterday' })
  })

  it('shows an off row instead of the next pass while Tidy memory is off', () => {
    const entries = tidyEntries([], 'pip', { enabled: false, afterHour: 3, nextAt: null }, at(29, 14), labels)
    expect(entries).toEqual([{ key: 'off', kind: 'off', day: '', time: '', pass: null }])
  })

  it('dates passes older than yesterday', () => {
    expect(pastDayLabel(at(20, 3), at(29, 14), labels)).toMatch(/20 Oct/)
    expect(pastDayLabel(at(28, 23, 59), at(29, 0, 1), labels)).toBe('Yesterday')
  })
})
