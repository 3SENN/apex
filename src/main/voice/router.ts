/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { classifyField, guardOf, type FieldAttributes, type GuardKind } from '@shared/fields'
import type { SpeechErrorCode, SpeechPermissions, SpeechPurpose } from '@shared/speech'
import type { VoiceErrorCode, VoiceTarget } from '@shared/voice'

// Where a voice command goes (MV-05) and what each failure is called (MV-06).
// Pure, so routing, the queue's companion choice and the error mapping are
// unit-tested without Electron.

/** What the focused element of the keyed webContents looked like when the hold began. */
export interface FocusInfo {
  editable: boolean
  attrs: FieldAttributes | null
  /** contenteditable or a text box drawn by script (role=textbox). */
  rich: boolean
}

const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password'])

/** The guard a focused field falls under; guarded fields never take dictation. */
export function focusGuard(focus: FocusInfo | null): GuardKind | null {
  if (!focus?.attrs) return null
  return guardOf(classifyField(focus.attrs))
}

/** Whether attributes read off an input describe something you can type text into. */
export function isTextInput(attrs: Pick<FieldAttributes, 'tag' | 'type'>): boolean {
  if (attrs.tag === 'textarea') return true
  if (attrs.tag !== 'input') return false
  return TEXT_TYPES.has(attrs.type.toLowerCase())
}

export type RouteDecision = { kind: 'field' } | { kind: 'companion' } | { kind: 'error'; code: 'no-field' }

/**
 * auto: the focused field when there is one, else the companion. field: the
 * focused field or no-field. A guarded field (password, card, security or
 * one-time code) is never typed into: no-field, in every mode but companion.
 */
export function routeCommand(target: VoiceTarget, focus: FocusInfo | null): RouteDecision {
  if (target === 'companion') return { kind: 'companion' }
  const editable = Boolean(focus?.editable)
  if (editable && focusGuard(focus) !== null) return { kind: 'error', code: 'no-field' }
  if (editable) return { kind: 'field' }
  return target === 'field' ? { kind: 'error', code: 'no-field' } : { kind: 'companion' }
}

/** The HUD's starting target for the route (an error still shows the field it refused). */
export function hudTarget(decision: RouteDecision): 'field' | 'companion' {
  return decision.kind === 'companion' ? 'companion' : 'field'
}

/** A failure from the broker, the quick model or an insert, as one of the HUD's errors. */
export function voiceErrorFor(err: unknown): VoiceErrorCode {
  if (err && typeof err === 'object') {
    const name = (err as { name?: unknown }).name
    if (name === 'EngineUnavailableError') return 'no-engine'
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string') return voiceErrorForCode(code as SpeechErrorCode, (err as { holder?: SpeechPurpose }).holder)
  }
  return 'failed'
}

export function voiceErrorForCode(code: SpeechErrorCode, holder?: SpeechPurpose): VoiceErrorCode {
  switch (code) {
    case 'mic-denied':
    case 'speech-denied':
      return 'mic-blocked'
    case 'mic-busy':
      return 'mic-busy'
    case 'busy':
      return holder === 'meeting' ? 'another-recording' : 'mic-busy'
    case 'no-speech':
      return 'no-speech'
    case 'recording-failed':
    case 'device-missing':
      return 'recording-failed'
    default:
      return 'failed'
  }
}

/** Which privacy pane a mic-blocked error opens. */
export function privacyPaneFor(code: SpeechErrorCode): 'microphone' | 'speech' {
  return code === 'speech-denied' ? 'speech' : 'microphone'
}

/** What mic-blocked is about now: the microphone, then speech recognition, whichever isn't allowed; else the error's own kind. */
export function blockedKind(p: Pick<SpeechPermissions, 'microphone' | 'speech'> | null, fallback: 'microphone' | 'speech'): 'microphone' | 'speech' {
  if (p?.microphone && p.microphone !== 'granted') return 'microphone'
  if (p?.speech && p.speech !== 'granted') return 'speech'
  return fallback
}

/**
 * Mic-blocked's fix: 'ask' when macOS never asked (Atelier isn't in that pane
 * yet, so the prompt comes first), 'retry' when both are allowed again,
 * else 'open' the pane for the one that's off.
 */
export function micFix(p: Pick<SpeechPermissions, 'microphone' | 'speech'> | null, fallback: 'microphone' | 'speech'): { kind: 'microphone' | 'speech'; action: 'ask' | 'open' | 'retry' } {
  if (p?.microphone === 'granted' && p.speech === 'granted') return { kind: fallback, action: 'retry' }
  const kind = blockedKind(p, fallback)
  return { kind, action: p?.[kind] === 'not-determined' ? 'ask' : 'open' }
}

export interface CompanionContext {
  /** The active tab shows atelier://chat/<id>. */
  chatPage: string | null
  /** The chat the last voice command went to. */
  lastVoiceChat: string | null
  /** The chat that controls the active tab. */
  tabChat: string | null
  /** Whether a surface (the side panel or a chat page) shows that chat right now. */
  isViewed(chatId: string): boolean
}

/**
 * The chat a companion command goes to: the chat page in front of you, the
 * chat the panel shows from the last command, or the chat at work in this
 * tab. Null starts a new chat for the active companion in the panel.
 */
export function companionChat(c: CompanionContext): { chatId: string; openPanel: boolean } | null {
  if (c.chatPage) return { chatId: c.chatPage, openPanel: false }
  if (c.lastVoiceChat && c.isViewed(c.lastVoiceChat)) return { chatId: c.lastVoiceChat, openPanel: true }
  if (c.tabChat) return { chatId: c.tabChat, openPanel: true }
  return null
}

/** Joins final pieces and the leftover partial into the turn's text. */
export function joinTranscript(finals: readonly string[], partial: string): string {
  return [...finals, partial]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The field-rewrite prompt for the quick model. */
export function rewritePrompt(current: string, spoken: string): { system: string; prompt: string } {
  return {
    system:
      `You edit the text of one form field for the person using ${BRAND_NAME}. They spoke a request out loud. If it asks for a change to the field (rewrite, shorten, translate, fix, add to it), make that change. Otherwise treat it as text to put in the field, cleaned up with sensible punctuation. Reply with the complete new text of the field and nothing else: no quotes, no notes.`,
    prompt: `Current text of the field:\n<field>\n${current.slice(0, 8000)}\n</field>\n\nWhat they said:\n<spoken>\n${spoken.slice(0, 2000)}\n</spoken>`,
  }
}
