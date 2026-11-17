/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import type { Tip } from '@shared/tips'
import { foldAgentLog } from '../src/renderer/src/agentLog'
import { cueNotes, type CueSpec } from '../src/renderer/src/chat/logic/cues'
import { SOUND_GAP_MS, SoundGate, createChatSounds } from '../src/renderer/src/chat/logic/sounds'
import { TIP_DELAY_MS, TIP_ROTATE_MS, errorShowing, pickTip, tipBlocked } from '../src/renderer/src/chat/logic/tips'

// Chat sounds (NS-03): which events sound, the done cue's three variants,
// at most one sound per 1.5 s per chat, and only with chatSounds on. Tips
// while working (CH-29): the 4 s delay, rotation and when they stay away.

function harness(enabled = true) {
  let now = 0
  let on = enabled
  const played: CueSpec[] = []
  const sounds = createChatSounds({ enabled: () => on, play: (cue) => void played.push(cue), now: () => now })
  return {
    played,
    send: (chatId: string, event: AgentEvent) => sounds.onEvent(chatId, event),
    advance: (ms: number) => void (now += ms),
    toggle: (value: boolean) => void (on = value),
  }
}

const running: AgentEvent = { type: 'status', status: 'running' }
const idle: AgentEvent = { type: 'status', status: 'idle' }

describe('chat sounds', () => {
  it('plays needs-you for requests, done when a run ends well, and task-completed for a finished sub-task', () => {
    const h = harness()
    expect(h.send('c', { type: 'approval', approvalId: 'a', description: 'x', origin: '' })).toBe('needs-you')
    h.advance(SOUND_GAP_MS)
    expect(h.send('c', { type: 'question', requestId: 'q', questions: [] })).toBe('needs-you')
    h.advance(SOUND_GAP_MS)
    h.send('c', running)
    expect(h.send('c', idle)).toBe('done')
    h.advance(SOUND_GAP_MS)
    expect(h.send('c', { type: 'delegation', id: 'd', childChatId: 'k', title: 't', status: 'working' })).toBeNull()
    expect(h.send('c', { type: 'delegation', id: 'd', childChatId: 'k', title: 't', status: 'done' })).toBe('task-completed')
    expect(h.played.map((c) => c.id)).toEqual(['needs-you', 'needs-you', 'done', 'task-completed'])
  })

  it('stays quiet when a run ends in an error or a stop, or never ran', () => {
    const h = harness()
    expect(h.send('c', idle)).toBeNull()
    h.send('c', running)
    h.send('c', { type: 'error', message: 'Overloaded' })
    expect(h.send('c', idle)).toBeNull()
    h.send('c', running)
    h.send('c', { type: 'stopped', turnId: null, reason: 'user' })
    expect(h.send('c', idle)).toBeNull()
    // The next good run sounds again.
    h.send('c', running)
    expect(h.send('c', idle)).toBe('done')
  })

  it('rotates the done cue through its three variants', () => {
    const h = harness()
    for (let i = 0; i < 4; i++) {
      h.send(`c${i}`, running)
      h.send(`c${i}`, idle)
    }
    expect(h.played.map((c) => c.variant)).toEqual([0, 1, 2, 0])
    const shapes = [0, 1, 2].map((variant) => JSON.stringify(cueNotes({ id: 'done', variant })))
    expect(new Set(shapes).size).toBe(3)
  })

  it('sounds at most once per 1.5 s per chat, other chats unaffected', () => {
    const h = harness()
    const ask: AgentEvent = { type: 'site-access', requestId: 's', origin: 'https://a.test', action: 'open' }
    expect(h.send('a', ask)).toBe('needs-you')
    h.advance(SOUND_GAP_MS - 1)
    expect(h.send('a', ask)).toBeNull()
    expect(h.send('b', ask)).toBe('needs-you')
    h.advance(1)
    expect(h.send('a', ask)).toBe('needs-you')
    const gate = new SoundGate(100)
    expect([gate.allow('x', 0), gate.allow('x', 50), gate.allow('x', 100)]).toEqual([true, false, true])
  })

  it('plays nothing while chat sounds are off', () => {
    const h = harness(false)
    h.send('c', { type: 'approval', approvalId: 'a', description: 'x', origin: '' })
    h.send('c', running)
    h.send('c', idle)
    expect(h.played).toEqual([])
    h.toggle(true)
    h.send('c', running)
    expect(h.send('c', idle)).toBe('done')
  })

  it('gives every cue Apex’s own short shape', () => {
    for (const id of ['sent', 'reply', 'needs-you', 'task-completed', 'error', 'intro'] as const) {
      const notes = cueNotes({ id })
      expect(notes.length).toBeGreaterThan(0)
      expect(Math.max(...notes.map((n) => n.at + n.dur))).toBeLessThan(1)
    }
  })
})

describe('tips while working', () => {
  const tips: Tip[] = [
    { id: 'a', context: 'chat-working', text: 'A' },
    { id: 'b', context: 'chat-working', text: 'B' },
    { id: 'c', context: 'chat-working', text: 'C' },
  ]
  const base = { runStartedAt: 0, now: 0, enabled: true, blocked: false, tips, dismissed: [] as string[] }

  it('waits about 4 s into a run, then rotates about every 10 s', () => {
    expect(pickTip({ ...base, now: TIP_DELAY_MS - 1 })).toEqual({ tip: null, changesIn: 1 })
    const first = pickTip({ ...base, now: TIP_DELAY_MS })
    const second = pickTip({ ...base, now: TIP_DELAY_MS + TIP_ROTATE_MS })
    const third = pickTip({ ...base, now: TIP_DELAY_MS + 2 * TIP_ROTATE_MS })
    const fourth = pickTip({ ...base, now: TIP_DELAY_MS + 3 * TIP_ROTATE_MS })
    expect([first.tip?.id, second.tip?.id, third.tip?.id]).toEqual(['a', 'b', 'c'])
    expect(fourth.tip?.id).toBe('a')
    expect(first.changesIn).toBe(TIP_ROTATE_MS)
    expect(pickTip({ ...base, now: TIP_DELAY_MS + 2500 }).changesIn).toBe(TIP_ROTATE_MS - 2500)
  })

  it('never shows when off, blocked, idle, dismissed or empty', () => {
    const at = TIP_DELAY_MS + 1
    expect(pickTip({ ...base, now: at, enabled: false }).tip).toBeNull()
    expect(pickTip({ ...base, now: at, blocked: true }).tip).toBeNull()
    expect(pickTip({ ...base, now: at, runStartedAt: null }).tip).toBeNull()
    expect(pickTip({ ...base, now: at, tips: [] }).tip).toBeNull()
    expect(pickTip({ ...base, now: at, dismissed: ['a', 'b', 'c'] }).tip).toBeNull()
    expect(pickTip({ ...base, now: at, dismissed: ['a'] }).tip?.id).toBe('b')
    // One tip left: it stays, with nothing to rotate to.
    expect(pickTip({ ...base, now: at, tips: [tips[0]!] }).changesIn).toBeNull()
  })

  it('stays away from request cards and this run’s errors, not older ones', () => {
    const errorThenMessage = foldAgentLog([{ type: 'error', message: 'Overloaded' }, { type: 'user-message', id: 'u', text: 'again' }]).items
    const messageThenError = foldAgentLog([{ type: 'user-message', id: 'u', text: 'go' }, { type: 'error', message: 'Overloaded' }]).items
    const asking = foldAgentLog([{ type: 'user-message', id: 'u', text: 'go' }, { type: 'site-access', requestId: 's', origin: 'https://a.test', action: 'open' }]).items
    expect(errorShowing(errorThenMessage)).toBe(false)
    expect(errorShowing(messageThenError)).toBe(true)
    expect(tipBlocked(errorThenMessage, 'running')).toBe(false)
    expect(tipBlocked(asking, 'running')).toBe(true)
    expect(tipBlocked(errorThenMessage, 'awaiting-approval')).toBe(true)
  })
})
