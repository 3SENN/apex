/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HudPayload, VoiceChord, VoiceErrorCode } from '@shared/voice'

// The voice HUD's state machine (MV-04): listening, transcribing, thinking,
// answered, speaking and error, plus the countdown that closes it. A pure
// reducer: main feeds it events and sends each new payload to the float.

export type HudEvent =
  | { type: 'start'; target: 'field' | 'companion'; readAloud: boolean; sounds: boolean; chord: VoiceChord; voiceName: string | null }
  | { type: 'target'; target: 'field' | 'companion' }
  | { type: 'read-aloud-on' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'release' }
  | { type: 'notice'; notice: HudPayload['notice'] }
  | { type: 'rewriting' }
  | { type: 'inserted'; how: 'typed' | 'rewritten'; text: string }
  | { type: 'sent'; chatId: string; companionId: string; queued: number }
  | { type: 'queued'; count: number }
  | { type: 'reply-started' }
  | { type: 'reply'; markdown: string }
  | { type: 'citation'; title: string; url: string }
  | { type: 'reply-done' }
  | { type: 'speak' }
  | { type: 'speech-ended' }
  | { type: 'error'; code: VoiceErrorCode; text?: string }
  | { type: 'hover'; on: boolean }

/** How long each settled state stays before the HUD closes by itself. */
export const COUNTDOWN = { typed: 2500, answered: 8000, perChar: 12, answeredMax: 16000, error: 12000 } as const

/** Citations shown under a preview. */
export const MAX_CITATIONS = 4

export function idleHud(turn = 0): HudPayload {
  return {
    state: 'idle',
    target: 'companion',
    settled: '',
    live: '',
    chatId: null,
    companionId: '',
    answer: null,
    error: null,
    queued: 0,
    countdownMs: null,
    readAloud: false,
    turn,
    sounds: true,
    chord: 'alt+space',
    voiceName: null,
    notice: null,
    inserted: null,
    waiting: false,
  }
}

/** How long a payload's countdown runs, or null while the HUD should stay (busy states, hover). */
export function countdownFor(p: HudPayload, hovered: boolean): number | null {
  if (hovered) return null
  if (p.state === 'error') return COUNTDOWN.error
  if (p.state !== 'answered') return null
  if (p.target === 'field' || !p.answer) return COUNTDOWN.typed
  return Math.min(COUNTDOWN.answeredMax, COUNTDOWN.answered + p.answer.markdown.length * COUNTDOWN.perChar)
}

function withCountdown(p: HudPayload, hovered: boolean): HudPayload {
  return { ...p, countdownMs: countdownFor(p, hovered) }
}

export function reduceHud(p: HudPayload, e: HudEvent, hovered = false): HudPayload {
  switch (e.type) {
    case 'start':
      // Each hold is a new turn: speech, text and errors from the last one go.
      return {
        ...idleHud(p.turn + 1),
        state: 'listening',
        target: e.target,
        readAloud: e.readAloud,
        sounds: e.sounds,
        chord: e.chord,
        voiceName: e.voiceName,
      }
    case 'target':
      if (p.state === 'listening' || p.state === 'transcribing') return { ...p, target: e.target }
      return p
    case 'read-aloud-on':
      return { ...p, readAloud: true }
    case 'partial':
      return p.state === 'listening' || p.state === 'transcribing' ? { ...p, live: e.text } : p
    case 'final': {
      if (p.state !== 'listening' && p.state !== 'transcribing') return p
      const settled = [p.settled, e.text.trim()].filter(Boolean).join(' ')
      return { ...p, settled, live: '' }
    }
    case 'release':
      return p.state === 'listening' ? { ...p, state: 'transcribing' } : p
    case 'notice':
      return { ...p, notice: e.notice }
    case 'rewriting':
      // The quick model rewrites the field's text; the HUD shows it thinking.
      return p.state === 'transcribing' ? { ...p, state: 'thinking', target: 'field' } : p
    case 'inserted':
      return withCountdown({ ...p, state: 'answered', target: 'field', settled: e.text, live: '', inserted: e.how, error: null }, hovered)
    case 'sent':
      return { ...p, state: 'thinking', target: 'companion', chatId: e.chatId, companionId: e.companionId, queued: e.queued, waiting: e.queued > 0, live: '', error: null }
    case 'queued':
      return { ...p, queued: Math.max(0, e.count), waiting: p.waiting && e.count > 0 }
    case 'reply-started':
      return p.state === 'thinking' ? { ...p, waiting: false, answer: { markdown: '', citations: [] } } : p
    case 'reply': {
      if (p.state !== 'thinking' && p.state !== 'answered') return p
      const answer = { markdown: e.markdown, citations: p.answer?.citations ?? [] }
      return { ...p, answer }
    }
    case 'citation': {
      const citations = p.answer?.citations ?? []
      if (citations.length >= MAX_CITATIONS || citations.some((c) => c.url === e.url)) return p
      return { ...p, answer: { markdown: p.answer?.markdown ?? '', citations: [...citations, { title: e.title, url: e.url }] } }
    }
    case 'reply-done':
      if (p.state !== 'thinking') return p
      if (p.readAloud && p.answer?.markdown.trim()) return { ...p, state: 'speaking', countdownMs: null }
      return withCountdown({ ...p, state: 'answered' }, hovered)
    case 'speak':
      return p.answer?.markdown.trim() && (p.state === 'answered' || p.state === 'speaking') ? { ...p, state: 'speaking', readAloud: true, countdownMs: null } : p
    case 'speech-ended':
      return p.state === 'speaking' ? withCountdown({ ...p, state: 'answered' }, hovered) : p
    case 'error':
      return withCountdown({ ...p, state: 'error', error: e.text ? { code: e.code, text: e.text } : { code: e.code }, live: '' }, hovered)
    case 'hover':
      return { ...p, countdownMs: countdownFor(p, e.on) }
  }
}
