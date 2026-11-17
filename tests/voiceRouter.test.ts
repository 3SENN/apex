/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { FieldAttributes } from '../src/shared/fields'
import { SpeechError } from '../src/shared/speech'
import { EngineUnavailableError } from '../src/main/agent/quick'
import { blockedKind, companionChat, focusGuard, hudTarget, isTextInput, joinTranscript, micFix, rewritePrompt, routeCommand, voiceErrorFor, voiceErrorForCode, type FocusInfo } from '../src/main/voice/router'

function attrs(over: Partial<FieldAttributes> = {}): FieldAttributes {
  return { tag: 'input', type: 'text', autocomplete: '', name: '', id: '', placeholder: '', label: '', inputMode: '', maxLength: null, ...over }
}
const field = (over: Partial<FieldAttributes> = {}): FocusInfo => ({ editable: true, rich: false, attrs: attrs(over) })
const rich: FocusInfo = { editable: true, rich: true, attrs: null }

describe('where a voice command goes', () => {
  it('auto types into the focused field, else asks the companion', () => {
    expect(routeCommand('auto', field())).toEqual({ kind: 'field' })
    expect(routeCommand('auto', rich)).toEqual({ kind: 'field' })
    expect(routeCommand('auto', null)).toEqual({ kind: 'companion' })
    expect(routeCommand('auto', { editable: false, rich: false, attrs: null })).toEqual({ kind: 'companion' })
  })

  it('field mode without a field is no-field; companion mode ignores the field', () => {
    expect(routeCommand('field', null)).toEqual({ kind: 'error', code: 'no-field' })
    expect(routeCommand('field', field())).toEqual({ kind: 'field' })
    expect(routeCommand('companion', field())).toEqual({ kind: 'companion' })
  })

  it('never types into guarded fields: passwords, cards, security and one-time codes', () => {
    expect(routeCommand('auto', field({ type: 'password' }))).toEqual({ kind: 'error', code: 'no-field' })
    expect(routeCommand('field', field({ autocomplete: 'cc-number' }))).toEqual({ kind: 'error', code: 'no-field' })
    expect(routeCommand('auto', field({ autocomplete: 'cc-csc' }))).toEqual({ kind: 'error', code: 'no-field' })
    expect(routeCommand('auto', field({ autocomplete: 'one-time-code' }))).toEqual({ kind: 'error', code: 'no-field' })
    expect(focusGuard(field({ type: 'password' }))).toBe('password')
    expect(focusGuard(field({ type: 'email' }))).toBeNull()
    expect(hudTarget({ kind: 'error', code: 'no-field' })).toBe('field')
    expect(hudTarget({ kind: 'companion' })).toBe('companion')
  })

  it('knows which inputs take text', () => {
    expect(isTextInput({ tag: 'textarea', type: '' })).toBe(true)
    expect(isTextInput({ tag: 'input', type: 'search' })).toBe(true)
    expect(isTextInput({ tag: 'input', type: 'checkbox' })).toBe(false)
    expect(isTextInput({ tag: 'select', type: '' })).toBe(false)
  })
})

describe('the companion chat a command joins', () => {
  const viewed = (ids: string[]) => (id: string) => ids.includes(id)
  it('prefers the chat page in front, then the chat the last command went to, then the chat at work in the tab', () => {
    expect(companionChat({ chatPage: 'page', lastVoiceChat: 'last', tabChat: 'tab', isViewed: viewed(['last']) })).toEqual({ chatId: 'page', openPanel: false })
    expect(companionChat({ chatPage: null, lastVoiceChat: 'last', tabChat: 'tab', isViewed: viewed(['last']) })).toEqual({ chatId: 'last', openPanel: true })
    expect(companionChat({ chatPage: null, lastVoiceChat: 'last', tabChat: 'tab', isViewed: viewed([]) })).toEqual({ chatId: 'tab', openPanel: true })
  })

  it('starts a new chat when none is in view', () => {
    expect(companionChat({ chatPage: null, lastVoiceChat: 'gone', tabChat: null, isViewed: viewed([]) })).toBeNull()
  })
})

describe('voice errors', () => {
  it('maps helper and broker codes to the HUD’s errors', () => {
    expect(voiceErrorFor(new SpeechError('mic-denied'))).toBe('mic-blocked')
    expect(voiceErrorFor(new SpeechError('speech-denied'))).toBe('mic-blocked')
    expect(voiceErrorFor(new SpeechError('mic-busy'))).toBe('mic-busy')
    expect(voiceErrorFor(new SpeechError('busy', 'held', 'meeting'))).toBe('another-recording')
    expect(voiceErrorFor(new SpeechError('busy', 'held', 'dictation'))).toBe('mic-busy')
    expect(voiceErrorFor(new SpeechError('no-speech'))).toBe('no-speech')
    expect(voiceErrorFor(new SpeechError('recording-failed'))).toBe('recording-failed')
    expect(voiceErrorFor(new SpeechError('device-missing'))).toBe('recording-failed')
    expect(voiceErrorFor(new SpeechError('helper-missing'))).toBe('failed')
    expect(voiceErrorForCode('locale-unsupported')).toBe('failed')
  })

  it('names a missing engine and treats anything else as a generic failure', () => {
    expect(voiceErrorFor(new EngineUnavailableError('no key'))).toBe('no-engine')
    expect(voiceErrorFor(new Error('boom'))).toBe('failed')
    expect(voiceErrorFor('nope')).toBe('failed')
  })
})

describe('turn text', () => {
  it('joins finals with the leftover partial', () => {
    expect(joinTranscript(['Open my', ' calendar '], '')).toBe('Open my calendar')
    expect(joinTranscript(['Open'], 'the door')).toBe('Open the door')
    expect(joinTranscript([], '  ')).toBe('')
  })

  it('puts the field and the spoken words in the rewrite prompt', () => {
    const { system, prompt } = rewritePrompt('Dear Sam, thanks', 'make it more formal')
    expect(system).toMatch(/complete new text of the field/)
    expect(prompt).toContain('Dear Sam, thanks')
    expect(prompt).toContain('make it more formal')
  })
})

describe('the mic-blocked fix', () => {
  it('names what is off now: the microphone first, then speech recognition, else what the error said', () => {
    expect(blockedKind({ microphone: 'denied', speech: 'denied' }, 'speech')).toBe('microphone')
    expect(blockedKind({ microphone: 'granted', speech: 'restricted' }, 'microphone')).toBe('speech')
    expect(blockedKind({ microphone: 'granted', speech: 'granted' }, 'speech')).toBe('speech')
    expect(blockedKind(null, 'speech')).toBe('speech')
  })

  it('asks when macOS never has (Atelier is not in the pane yet), opens the pane after a refusal, and retries once both are on', () => {
    expect(micFix({ microphone: 'not-determined', speech: 'not-determined' }, 'microphone')).toEqual({ kind: 'microphone', action: 'ask' })
    expect(micFix({ microphone: 'granted', speech: 'not-determined' }, 'microphone')).toEqual({ kind: 'speech', action: 'ask' })
    expect(micFix({ microphone: 'denied', speech: 'granted' }, 'speech')).toEqual({ kind: 'microphone', action: 'open' })
    expect(micFix({ microphone: 'granted', speech: 'granted' }, 'microphone')).toEqual({ kind: 'microphone', action: 'retry' })
    // No report (the helper is gone): the pane the error came from.
    expect(micFix(null, 'speech')).toEqual({ kind: 'speech', action: 'open' })
  })
})
