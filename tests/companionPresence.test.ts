/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/shared/ipc'
import {
  chatIsLive,
  chatMood,
  chatTyping,
  companionMood,
  figureMood,
  HAPPY_MS,
  idleStage,
  initialPresence,
  LOOK_AROUND_MS,
  moodMark,
  NAP_MS,
  nextChange,
  reducePresence,
  SAD_MS,
  SENT_HOLD_MS,
  summaryMood,
  TALK_HOLD_MS,
  TYPING_HOLD_MS,
  type PresenceAction,
  type PresenceState,
} from '../src/renderer/src/companion/presenceCore'

const T0 = 1_000_000

function run(actions: PresenceAction[], state: PresenceState = initialPresence(T0)): PresenceState {
  return actions.reduce(reducePresence, state)
}

const agent = (chatId: string, event: AgentEvent, at: number): PresenceAction => ({ type: 'agent', chatId, event, at })
const owned = (at = T0): PresenceAction => ({ type: 'chats', items: [{ id: 'c1', companionId: 'pip', status: 'idle' }], at })

describe('presence: composers', () => {
  it('listens as soon as text appears and holds while it exists', () => {
    const state = run([{ type: 'signal', signal: 'typing', companionId: 'pip', chatId: null, at: T0 + 10 }])
    expect(companionMood(state, 'pip', T0 + 10).mood).toBe('listening')
    // A pause in typing with text still there keeps it listening.
    expect(companionMood(state, 'pip', T0 + 10 + 30_000).mood).toBe('listening')
    // Only a composer that vanished without a word lets it go, after the failsafe.
    expect(companionMood(state, 'pip', T0 + 10 + TYPING_HOLD_MS + 1).mood).toBe('idle')
    // Other companions are not affected.
    expect(companionMood(state, 'juniper', T0 + 10).mood).toBe('idle')
  })

  it('text present, then cleared: listening, then idle at once', () => {
    let state = run([{ type: 'signal', signal: 'typing', companionId: 'pip', chatId: 'c1', at: T0 }])
    expect(companionMood(state, 'pip', T0 + 1).mood).toBe('listening')
    state = reducePresence(state, { type: 'signal', signal: 'idle', companionId: 'pip', chatId: 'c1', at: T0 + 500 })
    expect(companionMood(state, 'pip', T0 + 501).mood).toBe('idle')
  })

  it('small faces of a chat never react to typing', () => {
    const state = run([owned(), { type: 'signal', signal: 'typing', companionId: 'pip', chatId: 'c1', at: T0 + 1 }])
    expect(companionMood(state, 'pip', T0 + 2).mood).toBe('listening')
    expect(chatMood(state, 'c1', T0 + 2).mood).toBe('idle')
  })

  it('a live figure in an empty chat listens to its own composer even while the companion works elsewhere', () => {
    const busy = run([
      { type: 'chats', items: [{ id: 'other', companionId: 'pip', status: 'running' }], at: T0 },
      agent('other', { type: 'tool_start', id: 't1', name: 'read_page', input: {} } as unknown as AgentEvent, T0 + 1),
      { type: 'signal', signal: 'typing', companionId: 'pip', chatId: 'draft', at: T0 + 2 },
    ])
    expect(chatTyping(busy, 'draft', T0 + 3)).toBe(true)
    expect(chatTyping(busy, 'other', T0 + 3)).toBe(false)
    expect(chatMood(busy, 'draft', T0 + 3).mood).toBe('idle')
    expect(figureMood(chatMood(busy, 'draft', T0 + 3).mood, chatTyping(busy, 'draft', T0 + 3), companionMood(busy, 'pip', T0 + 3).mood)).toBe('listening')
    const cleared = reducePresence(busy, { type: 'signal', signal: 'idle', companionId: 'pip', chatId: 'draft', at: T0 + 4 })
    expect(chatTyping(cleared, 'draft', T0 + 5)).toBe(false)
    expect(figureMood('idle', false, companionMood(cleared, 'pip', T0 + 5).mood)).toBe('idle')
  })

  it('a live figure follows its chat first, then listening, then naps', () => {
    expect(figureMood('working', true, 'listening')).toBe('working')
    expect(figureMood('idle', false, 'listening')).toBe('listening')
    expect(figureMood('idle', false, 'sleeping')).toBe('sleeping')
    expect(figureMood('idle', false, 'working')).toBe('idle')
  })

  it('returns to idle at once when the field loses focus', () => {
    const state = run([
      { type: 'signal', signal: 'typing', companionId: 'pip', chatId: null, at: T0 },
      { type: 'signal', signal: 'idle', companionId: 'pip', chatId: null, at: T0 + 100 },
    ])
    expect(companionMood(state, 'pip', T0 + 101).mood).toBe('idle')
  })

  it('thinks as soon as you send, before the agent reports', () => {
    const state = run([
      { type: 'signal', signal: 'typing', companionId: 'pip', chatId: null, at: T0 },
      { type: 'signal', signal: 'sent', companionId: 'pip', chatId: null, at: T0 + 50 },
    ])
    expect(companionMood(state, 'pip', T0 + 51).mood).toBe('thinking')
    expect(companionMood(state, 'pip', T0 + 50 + SENT_HOLD_MS + 1).mood).toBe('idle')
  })

  it('records the latest signal for usePresenceSignal', () => {
    const state = run([{ type: 'signal', signal: 'sent', companionId: 'pip', chatId: 'c1', at: T0 + 5 }])
    expect(state.last).toEqual({ signal: 'sent', companionId: 'pip', at: T0 + 5 })
  })
})

describe('presence: agent events', () => {
  it('follows a run: thinking, talking, working, asking, then a happy one-shot', () => {
    let s = run([owned()])
    s = reducePresence(s, agent('c1', { type: 'status', status: 'running' }, T0 + 1))
    expect(companionMood(s, 'pip', T0 + 2).mood).toBe('thinking')
    s = reducePresence(s, agent('c1', { type: 'text-delta', turnId: 't', text: 'Hi' }, T0 + 10))
    expect(companionMood(s, 'pip', T0 + 11).mood).toBe('talking')
    expect(companionMood(s, 'pip', T0 + 10 + TALK_HOLD_MS + 1).mood).toBe('thinking')
    s = reducePresence(s, agent('c1', { type: 'tool', id: 'x', label: 'Reading', state: 'running' }, T0 + 20))
    expect(companionMood(s, 'pip', T0 + 21).mood).toBe('working')
    s = reducePresence(s, agent('c1', { type: 'approval', approvalId: 'a', description: 'Buy', origin: 'shop.test' }, T0 + 30))
    expect(companionMood(s, 'pip', T0 + 31).mood).toBe('approval')
    s = reducePresence(s, agent('c1', { type: 'approval-resolved', approvalId: 'a', allowed: true }, T0 + 40))
    expect(companionMood(s, 'pip', T0 + 41).mood).toBe('thinking')
    s = reducePresence(s, agent('c1', { type: 'status', status: 'idle' }, T0 + 50))
    expect(companionMood(s, 'pip', T0 + 51).mood).toBe('happy')
    expect(companionMood(s, 'pip', T0 + 50 + HAPPY_MS + 1).mood).toBe('idle')
  })

  it('is briefly sad after an error, and says nothing after a stop', () => {
    let s = run([owned(), agent('c1', { type: 'status', status: 'running' }, T0 + 1), agent('c1', { type: 'error', message: 'Network down' }, T0 + 2), agent('c1', { type: 'status', status: 'idle' }, T0 + 3)])
    expect(companionMood(s, 'pip', T0 + 4).mood).toBe('sad')
    expect(companionMood(s, 'pip', T0 + 3 + SAD_MS + 1).mood).toBe('idle')
    s = run([agent('c1', { type: 'status', status: 'running' }, T0 + 10_000), agent('c1', { type: 'error', message: 'Stopped.' }, T0 + 10_001), agent('c1', { type: 'status', status: 'idle' }, T0 + 10_002)], s)
    expect(companionMood(s, 'pip', T0 + 10_003).mood).toBe('idle')
  })

  it('the agent reporting clears the pending send', () => {
    const s = run([owned(), { type: 'signal', signal: 'sent', companionId: 'pip', chatId: null, at: T0 }, agent('c1', { type: 'status', status: 'running' }, T0 + 5), agent('c1', { type: 'status', status: 'idle' }, T0 + 6)])
    expect(s.companions.pip?.sentAt).toBe(0)
    expect(companionMood(s, 'pip', T0 + 6 + HAPPY_MS + 1).mood).toBe('idle')
  })

  it('stays busy while any of its chats runs', () => {
    let s = run([{ type: 'chats', items: [{ id: 'a', companionId: 'pip', status: 'idle' }, { id: 'b', companionId: 'pip', status: 'idle' }], at: T0 }])
    s = run([agent('a', { type: 'status', status: 'running' }, T0 + 1), agent('b', { type: 'status', status: 'running' }, T0 + 2), agent('b', { type: 'status', status: 'idle' }, T0 + 3)], s)
    expect(companionMood(s, 'pip', T0 + 4).mood).toBe('thinking')
    expect(chatMood(s, 'b', T0 + 4).mood).toBe('happy')
    expect(chatMood(s, 'a', T0 + 4).mood).toBe('thinking')
  })

  it('gives a chat it has not seen to whoever just sent', () => {
    const s = run([{ type: 'signal', signal: 'sent', companionId: 'juniper', chatId: null, at: T0 }, agent('new', { type: 'status', status: 'running' }, T0 + 200)])
    expect(s.chats.new?.companionId).toBe('juniper')
    expect(companionMood(s, 'juniper', T0 + 201).mood).toBe('thinking')
    expect(companionMood(s, 'pip', T0 + 201).mood).toBe('idle')
  })

  it('seeds running and waiting chats from the list, and trusts live events over it', () => {
    let s = run([{ type: 'chats', items: [{ id: 'r', companionId: 'pip', status: 'running' }, { id: 'w', companionId: 'sage', status: 'needs-approval' }], at: T0 }])
    expect(companionMood(s, 'pip', T0 + 1).mood).toBe('thinking')
    expect(companionMood(s, 'sage', T0 + 1).mood).toBe('approval')
    s = run([agent('r', { type: 'status', status: 'idle' }, T0 + 2), { type: 'chats', items: [{ id: 'r', companionId: 'pip', status: 'running' }], at: T0 + 3 }], s)
    expect(s.chats.r?.run).toBe('idle')
  })

  it('counts talk pulses per chat and per companion', () => {
    const s = run([owned(), agent('c1', { type: 'status', status: 'running' }, T0), agent('c1', { type: 'text-delta', turnId: 't', text: 'a' }, T0 + 1), agent('c1', { type: 'text-delta', turnId: 't', text: 'b' }, T0 + 2)])
    expect(s.chats.c1?.talk).toBe(2)
    expect(s.companions.pip?.talk).toBe(2)
  })
})

describe('presence: idle, naps and celebrations', () => {
  it('looks around after a while and naps after longer; any input wakes it', () => {
    const s = initialPresence(T0)
    expect(idleStage(s, T0 + LOOK_AROUND_MS - 1)).toBe('awake')
    expect(idleStage(s, T0 + LOOK_AROUND_MS)).toBe('looking')
    expect(companionMood(s, 'pip', T0 + NAP_MS).mood).toBe('sleeping')
    const woken = reducePresence(s, { type: 'input', at: T0 + NAP_MS + 5 })
    expect(companionMood(woken, 'pip', T0 + NAP_MS + 6).mood).toBe('idle')
  })

  it('never naps through a run', () => {
    const s = run([owned(), agent('c1', { type: 'status', status: 'running' }, T0)])
    expect(companionMood(s, 'pip', T0 + NAP_MS * 2).mood).toBe('thinking')
  })

  it('celebrates when cheered, and the latest of a cheer or a finished run shows', () => {
    const s = run([{ type: 'cheer', companionId: 'mochi', at: T0 }])
    expect(companionMood(s, 'mochi', T0 + 1).mood).toBe('happy')
    expect(s.companions.mochi?.cheer).toBe(1)
    expect(companionMood(s, 'mochi', T0 + HAPPY_MS + 1).mood).toBe('idle')
  })

  it('reports when the next derived change is due', () => {
    const s = run([{ type: 'signal', signal: 'sent', companionId: 'pip', chatId: null, at: T0 }])
    expect(nextChange(s, T0 + 100)).toBe(SENT_HOLD_MS - 100)
    const quiet = initialPresence(T0)
    expect(nextChange(quiet, T0 + 1000)).toBe(LOOK_AROUND_MS - 1000)
    expect(nextChange(quiet, T0 + NAP_MS + 1)).toBeNull()
  })

  it('tells live chats from ones its summary should speak for', () => {
    const s = run([owned(), agent('c1', { type: 'status', status: 'running' }, T0)])
    expect(chatIsLive(s, 'c1', T0 + 1)).toBe(true)
    expect(chatIsLive(s, 'other', T0 + 1)).toBe(false)
  })
})

describe('small faces: moods and marks', () => {
  it('maps a saved chat to a mood', () => {
    expect(summaryMood({ status: 'running', unread: false, needsInput: false })).toBe('working')
    expect(summaryMood({ status: 'needs-approval', unread: false, needsInput: false })).toBe('approval')
    expect(summaryMood({ status: 'error', unread: true, needsInput: false })).toBe('sad')
    expect(summaryMood({ status: 'finished', unread: true, needsInput: false })).toBe('happy')
    expect(summaryMood({ status: 'finished', unread: false, needsInput: false })).toBe('idle')
    expect(summaryMood({ status: 'idle', unread: false, needsInput: true })).toBe('approval')
  })

  it('maps a mood to the corner mark', () => {
    expect(moodMark('working')).toBe('working')
    expect(moodMark('thinking')).toBe('working')
    expect(moodMark('talking')).toBe('working')
    expect(moodMark('approval')).toBe('approval')
    expect(moodMark('happy')).toBe('done')
    expect(moodMark('sad')).toBe('error')
    expect(moodMark('idle')).toBeNull()
    expect(moodMark('idle', true)).toBe('unread')
    expect(moodMark('listening', true)).toBe('unread')
    expect(moodMark(undefined)).toBeNull()
  })
})
