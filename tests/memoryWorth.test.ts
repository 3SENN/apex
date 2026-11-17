/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryJob, TidyPass } from '@shared/activity'
import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS, type ChatSummary } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { MemoryFile, Owner } from '@shared/services'
import { RULES_ONLY, setDecider, type Decider } from '../src/main/decisions/service'
import { MemoryJobs, type MemoryJobsDeps } from '../src/main/memoryJobs'
import { TidyMemory } from '../src/main/tidy'
import { FakeHost } from './helpers/fakeHost'

// DC-17: "worth remembering?" before the memory jobs. With the decision model
// on for memory, chats it is sure hold nothing lasting are left out of the
// nightly tidy and of "Build from past chats"; off, nothing is asked.

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 11, 4)

const chat = (id: string, companionId: string, lastActiveAt: number): ChatSummary => ({
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
})

const dialogue = (text: string): AgentEvent[] => [
  { type: 'user-message', id: 'u', text },
  { type: 'text-delta', turnId: 't', text: 'Sure.' },
]

/** What each chat says: "lasting" chats tell something about the person, "small talk" ones don't, "maybe" ones leave the model unsure. */
const SAYS: Record<string, string> = {
  c1: 'lasting: I moved to Utrecht and work at the library',
  c2: 'small talk: what is the weather today',
  c3: 'small talk: convert 5 miles to km',
  c4: 'maybe: hmm',
  b1: 'lasting: my daughter is called Mila',
}

/** A decider whose model answers the memory question by what the chat says. */
function fakeDecider(active = true, delayMs = 0): Decider & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    active: (use) => active && use === 'memory',
    ready: () => active,
    paused: () => false,
    decide: async (call) => {
      if (!active || call.use !== 'memory') return call.rule
      const request = call.request()
      const state = String(request.state)
      asked.push(state)
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      const noul = state.includes('small talk') ? 0.05 : state.includes('maybe') ? 0.5 : 0.95
      const rule = await call.rule
      return call.read({ answers: { lasting: { type: 'noul', noul } }, model: 'kev-latest', source: 'model', ms: 1, inputTokens: 1 }, rule) ?? rule
    },
    ask: () => Promise.reject(new Error('not used')),
    model: () => Promise.reject(new Error('not used')),
  }
}

const idle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0))
}

class FakeMemory extends EventEmitter<{ changed: [Owner, string] }> {
  list(owner: Owner): MemoryFile[] {
    return [{ path: '/memories/home.md', size: 1, modifiedAt: 1, owner, author: 'agent' }]
  }
  read(): string {
    return 'Lives in Amsterdam'
  }
}

let dir: string
let host: FakeHost
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apex-worth-'))
  host = new FakeHost()
})
afterEach(() => {
  setDecider(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('the nightly tidy (DC-17)', () => {
  let chats: ChatSummary[]
  let passes: TidyPass[]
  let now: number

  const make = (): TidyMemory =>
    new TidyMemory({
      file: join(dir, 'tidy.json'),
      host,
      chats: { list: () => chats, load: (id) => ({ log: dialogue(SAYS[id] ?? '') }) },
      memory: new FakeMemory(),
      companions: () => [{ id: 'pip', name: 'Pip' }, { id: 'bo', name: 'Bo' }],
      engineReady: () => true,
      snapshot: () => undefined,
      broadcast: (p) => passes.push(p),
      ownChats: new Set(),
      now: () => now,
    })

  beforeEach(() => {
    now = NOW
    passes = []
    chats = [chat('c1', 'pip', NOW - 5 * HOUR), chat('c2', 'pip', NOW - 4 * HOUR), chat('c4', 'pip', NOW - 3 * HOUR)]
  })

  it('asks nothing and reads every chat with the model off or the memory use off', async () => {
    const off = fakeDecider(false)
    for (const d of [RULES_ONLY, off]) {
      setDecider(d)
      host = new FakeHost()
      passes = []
      rmSync(join(dir, 'tidy.json'), { force: true })
      await make().run()
      expect(host.backgroundRuns).toHaveLength(1)
      expect(host.backgroundRuns[0]?.prompt).toContain('weather')
      expect(passes[0]).toMatchObject({ status: 'ok' })
      expect(passes[0]?.skippedChats).toBeUndefined()
    }
    expect(off.asked).toEqual([])
  })

  it('leaves out the chats the model is sure about, keeps the unsure ones, and counts them', async () => {
    const d = fakeDecider()
    setDecider(d)
    await make().run()
    expect(d.asked).toHaveLength(3)
    // The same text Claude reads is judged.
    expect(d.asked[0]).toContain('### Chat c1')
    expect(host.backgroundRuns).toHaveLength(1)
    const prompt = host.backgroundRuns[0]?.prompt ?? ''
    expect(prompt).toContain('Utrecht')
    expect(prompt).toContain('maybe: hmm')
    expect(prompt).not.toContain('weather')
    expect(passes[0]).toMatchObject({ companionId: 'pip', status: 'ok', skippedChats: 1 })
  })

  it('records a skipped pass without a background chat when nothing is worth remembering, and moves on', async () => {
    chats = [chat('c2', 'pip', NOW - 4 * HOUR), chat('c3', 'pip', NOW - 3 * HOUR), chat('b1', 'bo', NOW - 2 * HOUR)]
    const d = fakeDecider()
    setDecider(d)
    const tidy = make()
    await tidy.run()
    expect(passes.map((p) => [p.companionId, p.status])).toEqual([
      ['pip', 'skipped'],
      ['bo', 'ok'],
    ])
    expect(passes[0]?.reason).toMatch(/Nothing new worth remembering/)
    expect(passes[0]).toMatchObject({ skippedChats: 2, chatId: null, notesChanged: 0 })
    // Not taken for a rate limit: Bo's pass still ran.
    expect(host.backgroundRuns.map((r) => r.companionId)).toEqual(['bo'])
    // The chats were judged, so the next night doesn't read them again.
    now = NOW + 24 * HOUR
    const asked = d.asked.length
    await tidy.run()
    expect(d.asked).toHaveLength(asked)
    expect(passes).toHaveLength(2)
  })

  it('still tidies the notes on “Tidy now” for one companion when every chat is skipped', async () => {
    chats = [chat('c2', 'pip', NOW - 4 * HOUR)]
    setDecider(fakeDecider())
    await make().run('pip')
    expect(host.backgroundRuns).toHaveLength(1)
    expect(host.backgroundRuns[0]?.prompt).not.toContain('weather')
    expect(passes[0]).toMatchObject({ status: 'ok', skippedChats: 1 })
  })
})

describe('Build from past chats (DC-17)', () => {
  let chats: ChatSummary[]
  let events: MemoryJob[]

  const deps = (): MemoryJobsDeps => ({
    file: join(dir, 'memory-jobs.json'),
    chats: { list: () => chats, load: (id) => ({ log: dialogue(`${SAYS[id]} `.repeat(400)) }) },
    memory: { list: () => [], read: () => '' },
    host,
    activeCompanion: () => 'pip',
    companionName: () => 'Pip',
    engine: () => ({ engine: 'api-key', model: 'claude-sonnet-5' }),
    snapshot: () => undefined,
    broadcast: (job) => events.push(job),
    ownChats: new Set(),
  })

  beforeEach(() => {
    events = []
    chats = ['c1', 'c2', 'c3', 'c4'].map((id, i) => chat(id, 'pip', i + 1))
  })

  it('asks nothing and builds from every chat with the model off', async () => {
    setDecider(RULES_ONLY)
    const jobs = new MemoryJobs(deps())
    jobs.startJob('build', 'pip')
    await idle()
    const job = jobs.jobs()[0] as MemoryJob
    expect(job.state).toBe('done')
    expect(job.skippedChats).toBeUndefined()
    expect(host.backgroundRuns.map((r) => r.prompt).join('\n')).toContain('weather')
  })

  it('leaves out the skipped chats once, and a retry plans the same batches without asking again', async () => {
    const d = fakeDecider()
    setDecider(d)
    host.backgroundResult = { ok: false, status: 'error' }
    const jobs = new MemoryJobs(deps())
    const started = jobs.startJob('build', 'pip')
    await idle()
    expect(d.asked).toHaveLength(4)
    expect(jobs.jobs()[0]).toMatchObject({ state: 'failed', skippedChats: 2 })
    host.backgroundResult = { ok: true, status: 'finished' }
    // Reopened, as after a restart: the kept chats were stored with the job.
    const reopened = new MemoryJobs(deps())
    reopened.retryJob(started.id)
    await idle()
    expect(d.asked).toHaveLength(4)
    const final = reopened.jobs()[0] as MemoryJob
    expect(final).toMatchObject({ state: 'done', skippedChats: 2 })
    const prompts = host.backgroundRuns.map((r) => r.prompt).join('\n')
    expect(prompts).toContain('Utrecht')
    expect(prompts).toContain('maybe: hmm')
    expect(prompts).not.toContain('weather')
    expect(prompts).not.toContain('miles')
  })

  it('finishes without a background chat when every chat is skipped', async () => {
    chats = ['c2', 'c3'].map((id, i) => chat(id, 'pip', i + 1))
    setDecider(fakeDecider())
    const jobs = new MemoryJobs(deps())
    jobs.startJob('build', 'pip')
    await idle()
    expect(jobs.jobs()[0]).toMatchObject({ state: 'done', total: 0, done: 0, skippedChats: 2 })
    expect(host.backgroundRuns).toHaveLength(0)
  })

  it('judges again on retry when the job was cancelled while judging', async () => {
    const d = fakeDecider(true, 20)
    setDecider(d)
    const jobs = new MemoryJobs(deps())
    const job = jobs.startJob('build', 'pip')
    jobs.cancelJob(job.id)
    await new Promise((r) => setTimeout(r, 60))
    expect(jobs.jobs()[0]?.state).toBe('cancelled')
    expect(host.backgroundRuns).toHaveLength(0)
    jobs.retryJob(job.id)
    await new Promise((r) => setTimeout(r, 120))
    expect(jobs.jobs()[0]).toMatchObject({ state: 'done', skippedChats: 2 })
    expect(host.backgroundRuns.map((r) => r.prompt).join('\n')).not.toContain('weather')
  })

  it('runs a job once when it is cancelled and retried while the first run is still judging', async () => {
    chats = Array.from({ length: 10 }, (_, i) => chat(`x${i}`, 'pip', i + 1))
    const d = fakeDecider(true, 40)
    setDecider(d)
    const jobs = new MemoryJobs(deps())
    const job = jobs.startJob('build', 'pip')
    jobs.cancelJob(job.id)
    jobs.retryJob(job.id)
    await new Promise((r) => setTimeout(r, 400))
    expect(jobs.jobs()[0]).toMatchObject({ state: 'done' })
    // The run from before the Retry stops after the chats it had already sent (four at a time), instead of judging all ten again beside the new run.
    expect(d.asked.length).toBe(4 + 10)
    expect(host.backgroundRuns).toHaveLength(jobs.jobs()[0]!.total)
  })
})
