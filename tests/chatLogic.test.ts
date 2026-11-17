/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS } from '@shared/chats'
import { describe, expect, it } from 'vitest'
import type { ChatSummary, MessageDetails } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { Skill } from '@shared/services'
import { EMPTY_LOG, foldAgentLog } from '../src/renderer/src/agentLog'
import { composerHint, composerState, matchSkills, modelLabel, skillQuery } from '../src/renderer/src/chat/logic/composer'
import { DEFAULT_FILTERS, chatBadge, groupChats, hasFilters, rangeBetween, toListFilter, pruneSelection } from '../src/renderer/src/chat/logic/list'
import { chatBlocks, cutDiscards, latestUserMessage, replyDetails, replyFeedback } from '../src/renderer/src/chat/logic/replies'
import { LOADING_LOG, applyView, beginLoad, receiveEvent } from '../src/renderer/src/chat/logic/sync'
import { CELEBRATE_MS, TALK_HOLD_MS, chatMood, formatTokens, isNearBottom } from '../src/renderer/src/chat/logic/view'

const user = (id: string, text: string): AgentEvent => ({ type: 'user-message', id, text })
const say = (turnId: string, text: string): AgentEvent => ({ type: 'text-delta', turnId, text })

describe('chat sync', () => {
  it('buffers live events while the view loads and applies only newer ones', () => {
    let state = LOADING_LOG
    state = receiveEvent(state, user('u1', 'hi'), 4)
    state = receiveEvent(state, say('t1', 'Hel'), 5)
    state = receiveEvent(state, say('t1', 'lo'), 6)
    // The view already holds events up to seq 5.
    state = applyView(state, { log: [user('u1', 'hi'), say('t1', 'Hel')], seq: 5, agentStatus: 'running' })
    expect(state.pending).toBeNull()
    expect(state.seq).toBe(6)
    expect(state.log.status).toBe('running')
    expect(state.log.items).toEqual([
      { kind: 'user', id: 'u1', text: 'hi' },
      { kind: 'assistant', id: 't1', text: 'Hello', thinking: '' },
    ])
  })

  it('skips live events the view already covered and folds newer ones', () => {
    let state = applyView(LOADING_LOG, { log: [user('u1', 'hi')], seq: 10, agentStatus: 'idle' })
    state = receiveEvent(state, user('u1', 'hi'), 9)
    expect(state.log.items).toHaveLength(1)
    state = receiveEvent(state, { type: 'status', status: 'running' }, 11)
    expect(state.log.status).toBe('running')
    expect(state.seq).toBe(11)
  })

  it('a reset followed by a replay rebuilds the log', () => {
    let state = applyView(LOADING_LOG, { log: [user('u1', 'a'), say('t1', 'x'), user('u2', 'b')], seq: 3, agentStatus: 'idle' })
    state = receiveEvent(state, { type: 'reset' }, 4)
    state = receiveEvent(state, user('u1', 'a'), 5)
    state = receiveEvent(state, say('t1', 'x'), 6)
    expect(state.log.items.map((i) => i.id)).toEqual(['u1', 't1'])
  })

  it('beginLoad keeps an existing buffer', () => {
    const loading = receiveEvent(LOADING_LOG, user('u', 'x'), 1)
    expect(beginLoad(loading).pending).toHaveLength(1)
    const ready = applyView(LOADING_LOG, { log: [], seq: 0, agentStatus: 'idle' })
    expect(beginLoad(ready).pending).toEqual([])
  })

  it('foldAgentLog starts from the live status', () => {
    expect(foldAgentLog([], 'awaiting-approval')).toEqual({ ...EMPTY_LOG, status: 'awaiting-approval' })
  })
})

describe('chat blocks', () => {
  const log = foldAgentLog([
    user('u1', 'Find flights'),
    { type: 'thinking-delta', turnId: 't1', text: 'plan' },
    { type: 'tool', id: 'c1', label: 'Searched the web', state: 'done' },
    say('t2', 'Here are three.'),
    say('t3', 'Want more?'),
    user('u2', 'No thanks'),
    { type: 'error', message: 'Stopped.' },
  ])

  it('groups everything after a message into one reply', () => {
    const blocks = chatBlocks(log.items)
    expect(blocks.map((b) => b.kind)).toEqual(['user', 'reply', 'user', 'reply'])
    const reply = blocks[1]
    if (reply?.kind !== 'reply') throw new Error('expected a reply')
    expect(reply.turnIds).toEqual(['t1', 't2', 't3'])
    expect(reply.anchorTurnId).toBe('t3')
    expect(reply.userId).toBe('u1')
    expect(reply.markdown).toBe('Here are three.\n\nWant more?')
    expect(reply.last).toBe(false)
    const tail = blocks[3]
    expect(tail?.kind === 'reply' && tail.last).toBe(true)
    expect(blocks.filter((b) => b.kind === 'user' && b.latest).map((b) => (b.kind === 'user' ? b.item.id : ''))).toEqual(['u2'])
  })

  it('finds the latest message and whether a cut discards anything', () => {
    expect(latestUserMessage(log.items)?.id).toBe('u2')
    expect(cutDiscards(log.items, 'u1')).toBe(true)
    expect(cutDiscards(foldAgentLog([user('u9', 'only')]).items, 'u9')).toBe(false)
    expect(cutDiscards(log.items, 'missing')).toBe(false)
  })

  it('anchors a thinking-only reply on its last turn', () => {
    const blocks = chatBlocks(foldAgentLog([user('u', 'x'), { type: 'thinking-delta', turnId: 'tA', text: 'hm' }]).items)
    expect(blocks[1]?.kind === 'reply' && blocks[1].anchorTurnId).toBe('tA')
  })

  it('sums reply details across turns', () => {
    const d = (turnId: string, at: number, model: string, memoryPaths: string[] = []): MessageDetails => ({
      turnId, at, model, stopReason: 'end_turn', memoryPaths,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 },
    })
    const summed = replyDetails(['t1', 't2', 't3'], { t1: d('t1', 1, 'claude-opus-5-5', ['/memories/a.md']), t3: d('t3', 3, 'claude-sonnet-5-5', ['/memories/a.md', '/memories/shared/b.md']) })
    expect(summed).toEqual({
      at: 3,
      model: 'claude-sonnet-5-5',
      models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
      usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 2 },
      memoryPaths: ['/memories/a.md', '/memories/shared/b.md'],
      missing: 1,
    })
    expect(replyDetails(['x'], {})).toBeNull()
  })

  it('reads a rating from the anchor turn first', () => {
    const fb = { rating: 'helpful' as const, note: '', at: 1 }
    expect(replyFeedback(['a', 'b'], 'b', { b: fb })).toBe(fb)
    expect(replyFeedback(['a', 'b'], 'b', { a: fb })).toBe(fb)
    expect(replyFeedback(['a'], 'a', {})).toBeNull()
  })
})

describe('composer', () => {
  it('picks the hint for each state', () => {
    const base = { hasApiKey: true, empty: true, running: false, editingQueued: false }
    expect(composerState({ ...base, hasApiKey: false, running: true })).toBe('no-key')
    expect(composerState({ ...base, running: true, editingQueued: true })).toBe('editing-queued')
    expect(composerState({ ...base, running: true })).toBe('running')
    expect(composerState({ ...base, meeting: true })).toBe('meeting')
    expect(composerState(base)).toBe('new')
    expect(composerState({ ...base, empty: false })).toBe('follow-up')
    for (const state of ['no-key', 'new', 'follow-up', 'running', 'meeting'] as const) {
      expect(composerHint(state, 'Juniper')).toContain('Juniper')
    }
  })

  it('lists the companion’s own skills before shared ones and hides other companions’', () => {
    const skill = (name: string, owner: string): Skill => ({ id: `${owner}:${name}`, name, owner, description: '', instructions: '', updatedAt: 0, lastUsedAt: null })
    const skills = [skill('summarize', 'shared'), skill('sort', 'c1'), skill('summarize', 'c1'), skill('scan', 'c2'), skill('plan', 'shared')]
    const matches = matchSkills(skills, 's', 'c1')
    expect(matches.all.map((s) => s.id)).toEqual(['c1:sort', 'c1:summarize'])
    expect(matches.shared).toEqual([])
    expect(matchSkills(skills, '', 'c1').all.map((s) => s.id)).toEqual(['c1:sort', 'c1:summarize', 'shared:plan'])
  })

  it('only treats a lone /prefix as a skill query', () => {
    expect(skillQuery('/')).toBe('')
    expect(skillQuery('/sum')).toBe('sum')
    expect(skillQuery('/sum now')).toBeNull()
    expect(skillQuery('hello')).toBeNull()
  })

  it('labels models', () => {
    expect(modelLabel('claude-haiku-5-5')).toBe('Haiku 5.5')
    expect(modelLabel('')).toBe('Unknown model')
    expect(modelLabel('claude-future-9')).toBe('claude-future-9')
  })
})

describe('chat lists', () => {
  const day = 86_400_000
  const now = new Date(2026, 9, 28, 12).getTime()
  const chat = (id: string, lastActiveAt: number, extra: Partial<ChatSummary> = {}): ChatSummary => ({
    id, title: id, createdAt: 0, updatedAt: lastActiveAt, lastActiveAt, routineId: null, companionId: 'c1', model: '', status: 'finished',
    unread: false, pinned: false, archived: false, needsInput: false, draft: false, ...CHAT_SUMMARY_FLAG_DEFAULTS, ...CHAT_SUMMARY_LINK_DEFAULTS, ...extra,
  })

  it('puts pinned chats first and groups the rest by date', () => {
    const groups = groupChats([chat('a', now - 1000), chat('p', now - 40 * day, { pinned: true }), chat('b', now - day), chat('c', now - 3 * day), chat('d', now - 20 * day), chat('e', now - 90 * day)], 'recent', now)
    expect(groups.map((g) => [g.id, g.items.map((c) => c.id)])).toEqual([
      ['pinned', ['p']], ['today', ['a']], ['yesterday', ['b']], ['week', ['c']], ['month', ['d']], ['older', ['e']],
    ])
    expect(groups.map((g) => g.label)).toEqual(['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older'])
  })

  it('keeps best-match order under one heading', () => {
    const groups = groupChats([chat('x', now - 90 * day), chat('y', now)], 'best-match', now)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.items.map((c) => c.id)).toEqual(['x', 'y'])
  })

  it('builds service filters', () => {
    expect(hasFilters(DEFAULT_FILTERS)).toBe(false)
    expect(toListFilter(DEFAULT_FILTERS, 50)).toEqual({ sort: 'recent', limit: 50 })
    expect(toListFilter({ ...DEFAULT_FILTERS, sort: 'best-match' }, 50).sort).toBe('recent')
    expect(toListFilter({ query: '  trip   plans ', companionId: 'c2', routine: 'only', status: 'unread', sort: 'best-match' }, 20)).toEqual({
      query: 'trip plans', companionId: 'c2', routine: 'only', status: 'unread', sort: 'best-match', limit: 20,
    })
    expect(hasFilters({ ...DEFAULT_FILTERS, status: 'archived' })).toBe(true)
  })

  it('shows the most urgent badge', () => {
    expect(chatBadge({ status: 'finished', unread: true, needsInput: true })?.status).toBe('needs-input')
    expect(chatBadge({ status: 'error', unread: true, needsInput: false })?.status).toBe('error')
    expect(chatBadge({ status: 'finished', unread: true, needsInput: false })?.status).toBe('unread')
    expect(chatBadge({ status: 'finished', unread: false, needsInput: false })).toBeNull()
    expect(chatBadge({ status: 'idle', unread: false, needsInput: false }, 'awaiting-approval')?.label).toBe('Needs your approval')
    expect(chatBadge({ status: 'idle', unread: false, needsInput: false }, 'running')?.status).toBe('working')
  })

  it('selects ranges and prunes gone rows', () => {
    expect(rangeBetween(['a', 'b', 'c', 'd'], 'c', 'a')).toEqual(['a', 'b', 'c'])
    expect(rangeBetween(['a', 'b'], 'zz', 'b')).toEqual(['b'])
    expect([...pruneSelection(new Set(['a', 'gone']), [chat('a', 0)])]).toEqual(['a'])
  })
})

describe('chat view rules', () => {
  it('sticks to the bottom only near it', () => {
    expect(isNearBottom({ scrollTop: 952, clientHeight: 400, scrollHeight: 1400 })).toBe(true)
    expect(isNearBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1400 })).toBe(false)
  })

  it('derives a per-chat mood with timed changes', () => {
    const base = { status: 'idle' as const, activity: null, activityAt: 0, outcome: null, outcomeAt: 0, listening: false, now: 10_000 }
    expect(chatMood(base)).toEqual({ mood: 'idle', changesIn: null })
    expect(chatMood({ ...base, listening: true }).mood).toBe('listening')
    expect(chatMood({ ...base, status: 'awaiting-approval' }).mood).toBe('approval')
    expect(chatMood({ ...base, status: 'running', activity: 'tool', activityAt: 9_999 }).mood).toBe('working')
    expect(chatMood({ ...base, status: 'running', activity: 'text', activityAt: 9_900 })).toEqual({ mood: 'talking', changesIn: TALK_HOLD_MS - 100 })
    expect(chatMood({ ...base, status: 'running', activity: 'text', activityAt: 1_000 }).mood).toBe('thinking')
    expect(chatMood({ ...base, outcome: 'ok', outcomeAt: 9_000 })).toEqual({ mood: 'happy', changesIn: CELEBRATE_MS - 1_000 })
    expect(chatMood({ ...base, outcome: 'error', outcomeAt: 9_000 }).mood).toBe('sad')
    expect(chatMood({ ...base, outcome: 'ok', outcomeAt: 1_000 }).mood).toBe('idle')
  })

  it('formats token counts', () => {
    expect([formatTokens(950), formatTokens(1234), formatTokens(45_600), formatTokens(2_300_000)]).toEqual(['950', '1.2k', '46k', '2.3M'])
  })
})
