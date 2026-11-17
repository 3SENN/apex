/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import { CHAT_ERROR_CODES, type ChatErrorCode } from '@shared/chatErrors'
import type { QueuedMessage } from '@shared/chats'
import { t } from '@shared/i18n/core'
import type { AgentEvent } from '@shared/ipc'
import { foldAgentLog, type LogItem } from '../src/renderer/src/agentLog'
import { anchorStep, hasMessage, keepPosition, messageAnchor, nearTop } from '../src/renderer/src/chat/logic/anchor'
import { createDraftSync } from '../src/renderer/src/chat/logic/drafts'
import { DEFAULT_RETRY_MS, MAX_AUTO_RETRY_MS, errorCard, retrySecondsLeft, shouldAutoRetry } from '../src/renderer/src/chat/logic/errors'
import { activityStatus, currentStep, foldConnectors, leftQueue, queueBadges, queueHeld, stepElapsed, toolKindOf } from '../src/renderer/src/chat/logic/status'
import { EMPTY_TRAY, allowAllTargets, pruneTray, trayEntries, trayReduce, trayView, type TrayEntry } from '../src/renderer/src/chat/logic/tray'
import type { ToolItem } from '../src/renderer/src/chat/logic/work'

// The chat behaviour in the chrome: error cards by type (SS-03), the
// plain-word status (CH-20), the queue's marks (CH-15), step timings (CH-19),
// the request tray (CH-38), message links and paging (CH-13) and drafts.

const tool = (id: string, label: string, state: ToolItem['state'], step?: ToolItem['step']): ToolItem => ({ kind: 'tool', id, label, state, ...(step ? { step } : {}) })

describe('error cards (SS-03)', () => {
  it('gives every code an icon, a tone, a title in the catalogue and an action', () => {
    for (const code of CHAT_ERROR_CODES) {
      const card = errorCard(code)
      expect(card.code).toBe(code)
      expect(['info', 'warning', 'error']).toContain(card.tone)
      expect(t(card.title, { name: 'Pip' })).not.toBe(card.title)
      if (card.body) expect(t(card.body)).not.toBe(card.body)
    }
  })

  it('picks the action each type needs, with no plan or billing screen of its own', () => {
    expect(errorCard('key-missing').action).toBe('settings')
    expect(errorCard('key-rejected')).toMatchObject({ action: 'settings', secondary: 'retry' })
    expect(errorCard('quota').action).toBe('console')
    expect(errorCard('too-long').action).toBe('new-chat')
    expect(errorCard('model-not-allowed').action).toBe('model')
    // A code from a build with more engines than this one is shown as an ordinary error.
    expect(errorCard('engine-code-this-build-lacks' as ChatErrorCode).code).toBe('other')
    expect(errorCard('refusal').action).toBe('none')
    expect(errorCard('disk-full').action).toBe('retry')
    for (const code of CHAT_ERROR_CODES) expect(t(errorCard(code).title, { name: 'Pip' })).not.toMatch(/plan|credit|billing|upgrade/i)
  })

  it('reads older notices without a code', () => {
    expect(errorCard(undefined, 'Add your API key in Settings').code).toBe('key-missing')
    expect(errorCard(undefined, 'Something odd').code).toBe('other')
  })

  it('counts down rate limits and overload, and retries once from the driving surface', () => {
    const card = errorCard('rate-limited')
    expect(card.autoRetry).toBe(true)
    expect(errorCard('overloaded').autoRetry).toBe(true)
    expect(errorCard('unavailable').autoRetry).toBe(false)
    expect(retrySecondsLeft(1000, 5000, 1000)).toBe(5)
    expect(retrySecondsLeft(1000, 5000, 4500)).toBe(2)
    expect(retrySecondsLeft(1000, 5000, 9000)).toBe(0)
    expect(retrySecondsLeft(0, undefined, 0)).toBe(DEFAULT_RETRY_MS / 1000)
    const base = { card, live: true, last: true, driving: true, retried: false, online: true }
    expect(shouldAutoRetry(base)).toBe(true)
    expect(shouldAutoRetry({ ...base, driving: false })).toBe(false)
    expect(shouldAutoRetry({ ...base, retried: true })).toBe(false)
    expect(shouldAutoRetry({ ...base, last: false })).toBe(false)
    expect(shouldAutoRetry({ ...base, online: false })).toBe(false)
    expect(shouldAutoRetry({ ...base, retryAfterMs: MAX_AUTO_RETRY_MS + 1 })).toBe(false)
    expect(shouldAutoRetry({ ...base, card: errorCard('key-rejected') })).toBe(false)
  })
})

describe('plain-word status (CH-20)', () => {
  const run = (events: AgentEvent[], status: 'idle' | 'running' | 'awaiting-approval' = 'running') => foldAgentLog([{ type: 'user-message', id: 'u1', text: 'go' }, ...events], status)
  const say = (s: ReturnType<typeof activityStatus>): string | null => (s ? t(s.key, s.vars) : null)

  it('says nothing while idle', () => {
    expect(activityStatus({ log: run([], 'idle'), name: 'Pip' })).toBeNull()
  })

  it('names the running step from its kind', () => {
    expect(say(activityStatus({ log: run([{ type: 'tool', id: 't', label: 'Read the page', state: 'running', kind: 'read-page' }]), name: 'Pip' }))).toBe('Reading the page')
    expect(say(activityStatus({ log: run([{ type: 'tool', id: 't', label: 'Search the web for "x"', state: 'running', kind: 'web-search' }]), name: 'Pip' }))).toBe('Searching the web')
    expect(say(activityStatus({ log: run([{ type: 'tool', id: 't', label: 'Check memory', state: 'running', kind: 'memory' }]), name: 'Pip' }))).toBe('Checking memory')
    expect(say(activityStatus({ log: run([{ type: 'tool', id: 't', label: 'List issues', state: 'running', kind: 'connector', connector: { id: 'gh', name: 'GitHub' } }]), name: 'Pip' }))).toBe('Using GitHub')
  })

  it('reads older steps from their labels', () => {
    expect(toolKindOf(tool('a', 'Search the web for "cats"', 'running'))).toBe('web-search')
    expect(toolKindOf(tool('a', 'Read the page', 'running'))).toBe('read-page')
    expect(toolKindOf(tool('a', 'Type "hi" into the field', 'running'))).toBe('type')
    expect(toolKindOf(tool('a', 'Check memory', 'running'))).toBe('memory')
    expect(toolKindOf(tool('a', 'Something else', 'running'))).toBe('other')
  })

  it('waits for approval, an answer, a hand-off; says interrupting and paused', () => {
    expect(say(activityStatus({ log: run([], 'awaiting-approval'), name: 'Pip' }))).toBe('Waiting for your approval')
    expect(activityStatus({ log: run([], 'awaiting-approval'), name: 'Pip' })?.tone).toBe('needs-input')
    expect(say(activityStatus({ log: { ...run([]), interrupting: true }, name: 'Pip' }))).toMatch(/^Interrupting/)
    expect(activityStatus({ log: run([]), name: 'Pip', paused: true })?.tone).toBe('paused')
    expect(activityStatus({ log: run([]), name: 'Pip', handoffs: 1 })?.key).toBe('chat.status.handoff')
  })

  it('says writing while text streams, and the fallback names the companion', () => {
    expect(say(activityStatus({ log: run([{ type: 'text-delta', turnId: 'a1', text: 'Hi' }]), name: 'Pip' }))).toBe('Writing')
    expect(say(activityStatus({ log: run([]), name: 'Pip' }))).toBe('Pip is on it')
  })
})

describe('queue marks (CH-15)', () => {
  const item = (extra: Partial<QueuedMessage> = {}): QueuedMessage => ({ id: 'q1', text: 'next', ...extra })
  it('marks failed, offline and where it came from', () => {
    expect(queueBadges(item())).toEqual([])
    expect(queueBadges(item({ failed: 'Network', source: 'routine' }))).toEqual(['failed', 'routine'])
    expect(queueBadges(item({ offline: true, source: 'voice' }))).toEqual(['offline', 'voice'])
  })
  it('knows when an edited item left the queue, and when the queue holds', () => {
    expect(leftQueue([item()], 'q1')).toBe(false)
    expect(leftQueue([], 'q1')).toBe(true)
    expect(leftQueue([], null)).toBe(false)
    expect(queueHeld([item(), item({ id: 'q2', failed: 'x' })])).toBe(true)
    expect(queueHeld([item()])).toBe(false)
  })
})

describe('step timings and connectors (CH-19)', () => {
  it('times the running step live and a finished one by its end', () => {
    expect(stepElapsed(tool('a', 'Read', 'running', { startedAt: 1000 }), 4000)).toBe(3000)
    expect(stepElapsed(tool('a', 'Read', 'done', { startedAt: 1000, endedAt: 1500 }), 9000)).toBe(500)
    expect(stepElapsed(tool('a', 'Read', 'done'), 9000)).toBeNull()
  })
  it('finds the current step and the fold’s connectors once each', () => {
    const gh = { id: 'gh', name: 'GitHub' }
    const steps = [tool('a', 'A', 'done', { connector: gh }), tool('b', 'B', 'running', { connector: gh }), tool('c', 'C', 'done')]
    expect(currentStep(steps)?.id).toBe('b')
    expect(currentStep([steps[0]!])).toBeNull()
    expect(foldConnectors(steps)).toEqual([gh])
  })
})

describe('request tray (CH-38)', () => {
  const items: LogItem[] = [
    { kind: 'approval', id: 'a1', description: 'Click Buy', origin: 'shop.test', resolved: null },
    { kind: 'approval', id: 'a2', description: 'Send form', origin: 'shop.test', resolved: null },
    { kind: 'approval', id: 'a3', description: 'Old', origin: '', resolved: true },
  ]
  const handoff = { tabId: 't1', title: 'Sign in', state: 'challenge' as const }

  it('lists hand-offs first, then approvals and registered requests, once each', () => {
    const sourced: TrayEntry[] = [{ id: 'q1', kind: 'question', data: null }, { id: 'a1', kind: 'approval', data: null }]
    const entries = trayEntries({ items, sourced, handoffs: [handoff], approvalCard: false })
    expect(entries.map((e) => e.id)).toEqual(['handoff:t1', 'a1', 'a2', 'q1'])
    // A registered approval card draws approvals itself.
    expect(trayEntries({ items, sourced: [], handoffs: [], approvalCard: true })).toEqual([])
  })

  it('shows one at a time with previous and next, wrapping', () => {
    const entries = trayEntries({ items, sourced: [], handoffs: [handoff], approvalCard: false })
    let state = EMPTY_TRAY
    expect(trayView(entries, state)).toMatchObject({ index: 0, total: 3 })
    state = trayReduce(entries, state, { type: 'next' })
    expect(trayView(entries, state).entry?.id).toBe('a1')
    state = trayReduce(entries, state, { type: 'previous' })
    state = trayReduce(entries, state, { type: 'previous' })
    expect(trayView(entries, state).entry?.id).toBe('a2')
  })

  it('dismisses to the next one, counts the hidden, and restores them', () => {
    const entries = trayEntries({ items, sourced: [], handoffs: [], approvalCard: false })
    let state = trayReduce(entries, EMPTY_TRAY, { type: 'dismiss', id: 'a1' })
    expect(trayView(entries, state)).toMatchObject({ total: 1, hidden: 1 })
    expect(trayView(entries, state).entry?.id).toBe('a2')
    expect(allowAllTargets(entries, state)).toEqual(['a2'])
    state = trayReduce(entries, state, { type: 'restore' })
    expect(allowAllTargets(entries, state)).toEqual(['a1', 'a2'])
  })

  it('keeps its place as answered requests leave, and forgets their dismissals', () => {
    const entries = trayEntries({ items, sourced: [], handoffs: [], approvalCard: false })
    const state = trayReduce(entries, trayReduce(entries, EMPTY_TRAY, { type: 'show', id: 'a2' }), { type: 'dismiss', id: 'a1' })
    const after = entries.filter((e) => e.id !== 'a1')
    const pruned = pruneTray(after, state)
    expect(pruned.dismissed.size).toBe(0)
    expect(trayView(after, pruned).entry?.id).toBe('a2')
    expect(pruneTray(after, pruned)).toBe(pruned)
  })
})

describe('message links and paging (CH-13)', () => {
  const items: LogItem[] = [
    { kind: 'user', id: 'u1', text: 'hi' },
    { kind: 'assistant', id: 'turn-1', text: 'hello', thinking: '' },
  ]
  it('reads the message from the fragment', () => {
    expect(messageAnchor('apex://chat/abc#u1')).toBe('u1')
    expect(messageAnchor('apex://chat/abc#turn%2D1')).toBe('turn-1')
    expect(messageAnchor('apex://chat/abc')).toBeNull()
    expect(messageAnchor('apex://chat/abc#')).toBeNull()
    expect(messageAnchor('apex://chat/abc#<script>')).toBeNull()
  })
  it('finds it, pages back for it, or gives up', () => {
    expect(hasMessage(items, 'turn-1')).toBe(true)
    expect(anchorStep({ items, id: 'u1', logStart: 0, loading: false, failed: false })).toBe('found')
    expect(anchorStep({ items, id: 'u0', logStart: 40, loading: false, failed: false })).toBe('load-older')
    expect(anchorStep({ items, id: 'u0', logStart: 40, loading: true, failed: false })).toBe('wait')
    expect(anchorStep({ items, id: 'u0', logStart: 0, loading: false, failed: false })).toBe('missing')
    expect(anchorStep({ items, id: 'u0', logStart: 40, loading: false, failed: true })).toBe('missing')
  })
  it('keeps the reading position when older content lands above', () => {
    expect(keepPosition({ scrollTop: 10, scrollHeight: 1000 }, 1600)).toBe(610)
    expect(nearTop(40)).toBe(true)
    expect(nearTop(500)).toBe(false)
  })
})

describe('drafts per chat', () => {
  it('debounces writes to main and flushes the rest on close', async () => {
    vi.useFakeTimers()
    try {
      const save = vi.fn()
      const drafts = createDraftSync({ save, load: async () => '' , delayMs: 300 })
      drafts.set('c1', 'h')
      drafts.set('c1', 'he')
      drafts.set('c1', 'hello')
      expect(save).not.toHaveBeenCalled()
      vi.advanceTimersByTime(300)
      expect(save).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenLastCalledWith('c1', 'hello')
      drafts.set('c2', 'later')
      drafts.flush()
      expect(save).toHaveBeenLastCalledWith('c2', 'later')
      expect(drafts.get('c1')).toBe('hello')
      drafts.set('c1', '')
      vi.advanceTimersByTime(300)
      expect(save).toHaveBeenLastCalledWith('c1', '')
      expect(drafts.get('c1')).toBe('')
    } finally {
      vi.useRealTimers()
    }
  })

  it('loads a saved draft once, and typing that started first wins', async () => {
    const load = vi.fn(async (id: string) => (id === 'c1' ? 'saved text' : ''))
    const drafts = createDraftSync({ save: () => undefined, load, setTimer: () => 0, clearTimer: () => undefined })
    expect(await drafts.hydrate('c1')).toBe('saved text')
    expect(await drafts.hydrate('c1')).toBe('saved text')
    expect(load).toHaveBeenCalledTimes(1)
    const pending = drafts.hydrate('c2')
    drafts.set('c2', 'typed')
    expect(await pending).toBe('typed')
    const failing = createDraftSync({ save: () => undefined, load: async () => Promise.reject(new Error('gone')), setTimer: () => 0, clearTimer: () => undefined })
    expect(await failing.hydrate('c3')).toBe('')
  })
})
