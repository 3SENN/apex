/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessageKey } from '@shared/i18n/core'
import type { PermissionKind, SpeechErrorCode, SpeechPermissions } from '@shared/speech'
import type { PrimaryInput, PrimaryState } from '../logic/composer'

// Pure rules behind dictation in the composer (MV-07, DS-59): what the mic
// slot shows in each state, where dictated text lands, which permission to
// ask for first, and what each failure says and offers.

export type DictationState = 'idle' | 'starting' | 'listening' | 'transcribing' | 'error'

/** The composer's voice input for primaryButton(): off without the helper, then idle, recording or transcribing. */
export function voiceInput(state: DictationState, available: boolean): NonNullable<PrimaryInput['voice']> {
  if (!available) return 'off'
  if (state === 'listening') return 'recording'
  if (state === 'starting' || state === 'transcribing') return 'transcribing'
  return 'idle'
}

/** What the mic slot holds beside the primary button: the mic, Stop while recording, or nothing. */
export type MicSlot = 'mic' | 'stop' | 'none'

export function micSlot(primary: PrimaryState): MicSlot {
  if (primary.mic === 'hidden' || primary.mic === 'main') return 'none'
  return primary.action === 'send-transcript' ? 'stop' : 'mic'
}

/**
 * Puts dictated words into the draft at the caret (or over the selection),
 * with a space on either side where the neighbouring text needs one.
 */
export function insertDictation(text: string, start: number, end: number, words: string): { text: string; caret: number } {
  const clean = words.trim()
  const from = Math.max(0, Math.min(start, text.length))
  const to = Math.max(from, Math.min(end, text.length))
  if (!clean) return { text, caret: to }
  const before = text.slice(0, from)
  const after = text.slice(to)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : ''
  const next = `${before}${lead}${clean}${trail}${after}`
  return { text: next, caret: before.length + lead.length + clean.length + trail.length }
}

/** The next permission step before listening: nothing to do, ask the system, or explain a denial. */
export type PermissionStep = { kind: 'ok' } | { kind: 'request'; what: PermissionKind } | { kind: 'denied'; what: PermissionKind }

export function permissionStep(p: SpeechPermissions): PermissionStep {
  for (const what of ['microphone', 'speech'] as const) {
    const perm = p[what]
    if (perm === 'not-determined') return { kind: 'request', what }
    if (perm === 'denied' || perm === 'restricted') return { kind: 'denied', what }
  }
  return { kind: 'ok' }
}

export type ErrorAction = { kind: 'privacy'; what: PermissionKind } | { kind: 'settings' } | { kind: 'retry' } | null

export interface ErrorCopy {
  message: MessageKey
  action: ErrorAction
}

/** Atelier's words for every dictation failure, each with the one thing that fixes it. */
export function dictationErrorCopy(code: SpeechErrorCode): ErrorCopy {
  switch (code) {
    case 'mic-denied':
      return { message: 'meetings.dictation.error.micDenied', action: { kind: 'privacy', what: 'microphone' } }
    case 'speech-denied':
      return { message: 'meetings.dictation.error.speechDenied', action: { kind: 'privacy', what: 'speech' } }
    case 'screen-denied':
      return { message: 'meetings.dictation.error.screenDenied', action: { kind: 'privacy', what: 'screen' } }
    case 'mic-busy':
      return { message: 'meetings.dictation.error.micBusy', action: { kind: 'retry' } }
    case 'busy':
      return { message: 'meetings.dictation.error.busy', action: null }
    case 'device-missing':
      return { message: 'meetings.dictation.error.deviceMissing', action: { kind: 'settings' } }
    case 'locale-unsupported':
      return { message: 'meetings.dictation.error.locale', action: { kind: 'settings' } }
    case 'no-speech':
      return { message: 'meetings.dictation.error.noSpeech', action: { kind: 'retry' } }
    case 'helper-missing':
    case 'unsupported-platform':
      return { message: 'meetings.dictation.error.unavailable', action: null }
    case 'helper-outdated':
      return { message: 'meetings.dictation.error.outdated', action: null }
    case 'recording-failed':
    case 'helper-failed':
    case 'invalid':
    case 'failed':
      return { message: 'meetings.dictation.error.failed', action: { kind: 'retry' } }
  }
}

/** Level bar heights (0..1) for a meter of `bars` bars, centre loudest, from one RMS reading. */
export function levelBars(level: number, bars = 4): number[] {
  const l = Math.max(0, Math.min(1, level))
  // Speech RMS sits low; a square root makes ordinary talking fill the meter.
  const shown = Math.sqrt(l)
  const mid = (bars - 1) / 2
  return Array.from({ length: bars }, (_, i) => {
    const weight = 1 - (Math.abs(i - mid) / (mid + 1)) * 0.45
    return Math.max(0.18, Math.min(1, shown * weight * 1.25))
  })
}
