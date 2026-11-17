/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryJob } from '@shared/activity'
import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS, SHARED_OWNER, type ChatSummary } from '@shared/chats'
import type { EngineId } from '@shared/engine'
import type { AgentEvent } from '@shared/ipc'
import type { MemoryFile } from '@shared/services'
import { MemoryJobs, chatTranscript, eligibleChats, planBatches, type MemoryJobsDeps } from '../src/main/memoryJobs'
import { FakeHost } from './helpers/fakeHost'

const chat = (id: string, companionId: string, patch: Partial<ChatSummary> = {}): ChatSummary => ({
  id,
  title: `Chat ${id}`,
  createdAt: Number(id.replace(/\D/g, '')) || 1,
  updatedAt: 1,
  lastActiveAt: 1,
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

const log = (text: string, reply = 'Sure.'): AgentEvent[] => [
  { type: 'user-message', id: 'u', text },
  { type: 'text-delta', turnId: 't', text: reply.slice(0, 3) },
  { type: 'text-delta', turnId: 't', text: reply.slice(3) },
  { type: 'tool', id: 'x', name: 'memory', label: 'Saved a note', state: 'done' } as unknown as AgentEvent,
]

describe('transcripts and batches', () => {
  it('turns a chat into dialogue, joining streamed text and leaving tools out', () => {
    const t = chatTranscript(chat('c1', 'pip'), log('I like tea', 'Noted, tea it is.'), 'Pip')
    expect(t.text).toContain('You: I like tea')
    expect(t.text).toContain('Pip: Noted, tea it is.')
    expect(t.text).not.toContain('Saved a note')
    expect(t.messages).toBe(2)
  })

  it('packs whole chats into batches and cuts a chat that is too long', () => {
    const t = (id: string, n: number) => ({ id, text: 'x'.repeat(n), messages: 1 })
    expect(planBatches([t('a', 40), t('b', 40), t('c', 40)], 100).map((b) => b.map((x) => x.id))).toEqual([['a', 'b'], ['c']])
    const cut = planBatches([t('long', 500)], 100)[0]?.[0]
    expect(cut?.text.length).toBeLessThanOrEqual(100)
    expect(planBatches([])).toEqual([])
  })

  it('never reads private chats, routine runs, children or Apex’s own upkeep chats; imported ones count', () => {
    const chats = [
      chat('c1', 'pip'),
      chat('c2', 'pip', { private: true }),
      chat('c3', 'pip', { routineId: 'r' }),
      chat('c4', 'pip', { parentChatId: 'c1' }),
      chat('c5', 'pip'),
      chat('c6', 'bo', { imported: { source: 'chatgpt', originalTitle: 'x', originalCreatedAt: null, importedAt: 1 } }),
    ]
    expect(eligibleChats(chats, 'pip', new Set(['c5'])).map((c) => c.id)).toEqual(['c1'])
    expect(eligibleChats(chats, SHARED_OWNER, new Set()).map((c) => c.id)).toEqual(['c1', 'c5', 'c6'])
  })
})

describe('MemoryJobs', () => {
  let dir: string
  let host: FakeHost
  let chats: ChatSummary[]
  let notes: MemoryFile[]
  const events: MemoryJob[] = []
  const snapshots: string[] = []
  const stopped: string[] = []

  const deps = (): MemoryJobsDeps => ({
    file: join(dir, 'memory-jobs.json'),
    chats: { list: () => chats, load: (id) => ({ log: log(`message in ${id} `.repeat(800)) }) },
    memory: { list: () => notes, read: (path) => `text of ${path}` },
    host: Object.assign(host, { stop: (id: string) => stopped.push(id) }),
    activeCompanion: () => 'pip',
    companionName: () => 'Pip',
    engine: () => ({ engine: 'api-key', model: 'claude-sonnet-5' }),
    snapshot: (owner, path) => snapshots.push(`${owner}:${path}`),
    broadcast: (job) => events.push(job),
    ownChats: new Set(),
  })
  const settle = () => new Promise((r) => setTimeout(r, 0))

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apex-jobs-'))
    host = new FakeHost()
    chats = Array.from({ length: 6 }, (_, i) => chat(`c${i + 1}`, 'pip'))
    notes = [{ path: '/memories/a.md', size: 3, modifiedAt: 1, owner: 'pip', author: 'agent' }]
    events.length = 0
    snapshots.length = 0
    stopped.length = 0
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('estimates chats, messages, tokens and cost (API key only)', () => {
    const jobs = new MemoryJobs(deps())
    const estimate = jobs.estimateBuild('pip')
    expect(estimate).toMatchObject({ chats: 6, messages: 12 })
    expect(estimate.approxInputTokens).toBeGreaterThan(6 * 3000)
    expect(estimate.approxCostUsd).toBeGreaterThan(0)
    const viaOther = new MemoryJobs({ ...deps(), engine: () => ({ engine: 'another-engine' as EngineId, model: 'x' }) })
    expect(viaOther.estimateBuild('pip').approxCostUsd).toBeNull()
    expect(jobs.estimateBuild('bo')).toMatchObject({ chats: 0, messages: 0 })
  })

  it('runs batches into one background chat and reports progress', async () => {
    const jobs = new MemoryJobs(deps())
    const job = jobs.startJob('build', 'pip')
    expect(job).toMatchObject({ state: 'running', done: 0, kind: 'build', owner: 'pip' })
    expect(job.total).toBeGreaterThan(1)
    await settle()
    await settle()
    const final = jobs.jobs()[0] as MemoryJob
    expect(final.state).toBe('done')
    expect(final.done).toBe(final.total)
    expect(host.backgroundRuns).toHaveLength(final.total)
    expect(host.backgroundRuns.every((r) => r.kind === 'tidy' && r.companionId === 'pip' && r.capabilities?.memory === true && r.capabilities.webTools === false)).toBe(true)
    // Later batches append to the first batch's chat.
    expect(host.backgroundRuns[1]?.appendTo).toBe(host.backgroundRuns[0]?.chatId)
    expect(final.chatId).toBe(host.backgroundRuns[0]?.chatId)
    expect(events.map((e) => e.done)).toContain(1)
    expect(() => jobs.startJob('build', 'bo')).toThrow(/no saved chats/)
  })

  it('builds shared notes as the active companion, into /memories/shared/', async () => {
    const jobs = new MemoryJobs(deps())
    jobs.startJob('build', SHARED_OWNER, { chatIds: ['c1'] })
    await settle()
    expect(host.backgroundRuns[0]?.companionId).toBe('pip')
    expect(host.backgroundRuns[0]?.prompt).toContain('/memories/shared/')
    expect(host.backgroundRuns[0]?.prompt).toContain('message in c1')
    expect(host.backgroundRuns[0]?.prompt).not.toContain('message in c2')
  })

  it('cancels, refuses a second job for the same notes, and retries from where it stopped', async () => {
    const jobs = new MemoryJobs(deps())
    let release: () => void = () => undefined
    const original = host.runBackground.bind(host)
    host.runBackground = (input) => new Promise((resolve) => (release = () => void original(input).then(resolve)))
    const job = jobs.startJob('build', 'pip')
    expect(() => jobs.startJob('reorganize', 'pip')).toThrow(/already running/)
    release()
    await settle()
    await settle()
    jobs.cancelJob(job.id)
    expect(jobs.jobs()[0]).toMatchObject({ state: 'cancelled', done: 1 })
    expect(stopped).toEqual([host.backgroundRuns[0]?.chatId])
    release()
    await settle()
    expect(jobs.jobs()[0]?.state).toBe('cancelled')
    host.runBackground = original
    const before = host.backgroundRuns.length
    jobs.retryJob(job.id)
    await settle()
    await settle()
    const final = jobs.jobs()[0] as MemoryJob
    expect(final.state).toBe('done')
    expect(host.backgroundRuns.length - before).toBe(final.total - 1)
  })

  it('marks a job running at quit as interrupted', () => {
    const jobs = new MemoryJobs(deps())
    host.runBackground = () => new Promise(() => undefined)
    const job = jobs.startJob('build', 'pip')
    const reopened = new MemoryJobs(deps())
    expect(reopened.jobs()[0]).toMatchObject({ id: job.id, state: 'interrupted' })
  })

  it('fails with the chat to open when a batch fails', async () => {
    const jobs = new MemoryJobs(deps())
    host.backgroundResult = { ok: false, status: 'error' }
    jobs.startJob('build', 'pip')
    await settle()
    expect(jobs.jobs()[0]).toMatchObject({ state: 'failed', done: 0 })
    expect(jobs.jobs()[0]?.chatId).toBe(host.backgroundRuns[0]?.chatId)
  })

  it('reorganizes after keeping a version of every note', async () => {
    const jobs = new MemoryJobs(deps())
    jobs.startJob('reorganize', 'pip')
    await settle()
    expect(snapshots).toEqual(['pip:/memories/a.md'])
    expect(host.backgroundRuns[0]?.prompt).toContain('/memories/a.md')
    expect(jobs.jobs()[0]?.state).toBe('done')
    notes = []
    expect(() => jobs.startJob('reorganize', 'bo')).toThrow(/no notes/)
  })
})
