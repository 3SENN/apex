/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { HudPayload } from '../src/shared/voice'
import { COUNTDOWN, MAX_CITATIONS, countdownFor, idleHud, reduceHud, type HudEvent } from '../src/main/voice/hud'

// The voice HUD's state machine (MV-04) and its closing countdown, plus the
// queue a command waits in while its chat is still working (CH-15).

const START: HudEvent = { type: 'start', target: 'companion', readAloud: false, sounds: true, chord: 'alt+space', voiceName: null }

function run(events: HudEvent[], from: HudPayload = idleHud(), hovered = false): HudPayload {
  return events.reduce((p, e) => reduceHud(p, e, hovered), from)
}

describe('the voice HUD', () => {
  it('listens, settles words, transcribes on release and thinks once sent', () => {
    let p = run([START, { type: 'partial', text: 'what is' }])
    expect(p).toMatchObject({ state: 'listening', live: 'what is', settled: '', turn: 1 })
    p = run([{ type: 'final', text: 'what is the time' }, { type: 'partial', text: 'in' }], p)
    expect(p).toMatchObject({ settled: 'what is the time', live: 'in' })
    p = reduceHud(p, { type: 'release' })
    expect(p.state).toBe('transcribing')
    p = reduceHud(p, { type: 'sent', chatId: 'c1', companionId: 'k1', queued: 0 })
    expect(p).toMatchObject({ state: 'thinking', chatId: 'c1', companionId: 'k1', live: '', waiting: false, countdownMs: null })
  })

  it('previews the reply with citations, deduplicated and capped, then counts down', () => {
    let p = run([START, { type: 'release' }, { type: 'sent', chatId: 'c1', companionId: '', queued: 0 }, { type: 'reply-started' }, { type: 'reply', markdown: 'Hello **there**' }])
    for (let i = 0; i < MAX_CITATIONS + 2; i++) p = reduceHud(p, { type: 'citation', title: `T${i}`, url: `https://example.com/${i % (MAX_CITATIONS + 1)}` })
    expect(p.answer?.citations).toHaveLength(MAX_CITATIONS)
    expect(new Set(p.answer?.citations.map((c) => c.url)).size).toBe(MAX_CITATIONS)
    p = reduceHud(p, { type: 'reply-done' })
    expect(p.state).toBe('answered')
    expect(p.countdownMs).toBe(COUNTDOWN.answered + 'Hello **there**'.length * COUNTDOWN.perChar)
  })

  it('caps the countdown for long answers and pauses it while hovered', () => {
    const p = run([START, { type: 'release' }, { type: 'sent', chatId: 'c1', companionId: '', queued: 0 }, { type: 'reply-started' }, { type: 'reply', markdown: 'x'.repeat(5000) }, { type: 'reply-done' }])
    expect(p.countdownMs).toBe(COUNTDOWN.answeredMax)
    const hovered = reduceHud(p, { type: 'hover', on: true })
    expect(hovered.countdownMs).toBeNull()
    expect(reduceHud(hovered, { type: 'hover', on: false }).countdownMs).toBe(COUNTDOWN.answeredMax)
    expect(countdownFor({ ...p, state: 'thinking' }, false)).toBeNull()
  })

  it('reads the answer aloud when asked at any point, then counts down when speech ends', () => {
    let p = run([START, { type: 'read-aloud-on' }, { type: 'release' }, { type: 'sent', chatId: 'c1', companionId: '', queued: 0 }, { type: 'reply-started' }, { type: 'reply', markdown: 'Sure.' }, { type: 'reply-done' }])
    expect(p).toMatchObject({ state: 'speaking', countdownMs: null })
    p = reduceHud(p, { type: 'speech-ended' })
    expect(p.state).toBe('answered')
    expect(p.countdownMs).not.toBeNull()
    // Read aloud from the HUD after the fact.
    expect(reduceHud(p, { type: 'speak' })).toMatchObject({ state: 'speaking', readAloud: true })
    // Nothing to read: speak does nothing.
    expect(reduceHud({ ...p, answer: { markdown: '  ', citations: [] } }, { type: 'speak' }).state).toBe('answered')
  })

  it('a typed field turn settles briefly, and a rewrite thinks first', () => {
    const base = run([{ ...START, target: 'field' }, { type: 'final', text: 'hello' }, { type: 'release' }])
    const typed = reduceHud(base, { type: 'inserted', how: 'typed', text: 'hello' })
    expect(typed).toMatchObject({ state: 'answered', target: 'field', inserted: 'typed', countdownMs: COUNTDOWN.typed })
    const thinking = reduceHud(base, { type: 'rewriting' })
    expect(thinking.state).toBe('thinking')
    expect(reduceHud(thinking, { type: 'inserted', how: 'rewritten', text: 'Hello.' })).toMatchObject({ settled: 'Hello.', inserted: 'rewritten' })
  })

  it('errors stay longer, keep their text for Copy, and a new hold starts clean', () => {
    const p = run([START, { type: 'final', text: 'note' }, { type: 'error', code: 'insert-failed', text: 'note' }])
    expect(p).toMatchObject({ state: 'error', error: { code: 'insert-failed', text: 'note' }, countdownMs: COUNTDOWN.error })
    const next = reduceHud(p, START)
    expect(next).toMatchObject({ state: 'listening', error: null, settled: '', turn: p.turn + 1, answer: null })
  })

  it('ignores late words and replies once the turn has moved on', () => {
    const answered = run([START, { type: 'release' }, { type: 'sent', chatId: 'c1', companionId: '', queued: 0 }, { type: 'reply-started' }, { type: 'reply-done' }])
    expect(reduceHud(answered, { type: 'partial', text: 'late' })).toBe(answered)
    expect(reduceHud(answered, { type: 'target', target: 'field' })).toBe(answered)
    expect(reduceHud(idleHud(), { type: 'reply', markdown: 'stray' }).answer).toBeNull()
  })
})

describe('the queue a voice command waits in', () => {
  it('shows the queued count while the chat is busy and starts the preview when its turn comes', () => {
    let p = run([START, { type: 'release' }, { type: 'sent', chatId: 'c1', companionId: '', queued: 2 }])
    expect(p).toMatchObject({ state: 'thinking', queued: 2, waiting: true })
    p = reduceHud(p, { type: 'queued', count: 1 })
    expect(p).toMatchObject({ queued: 1, waiting: true })
    p = reduceHud(p, { type: 'queued', count: 0 })
    expect(p).toMatchObject({ queued: 0, waiting: false })
    p = reduceHud(p, { type: 'reply-started' })
    expect(p.answer).toEqual({ markdown: '', citations: [] })
  })

  it('never shows a negative count', () => {
    expect(reduceHud(idleHud(), { type: 'queued', count: -3 }).queued).toBe(0)
  })
})
