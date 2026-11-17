/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'
import type { MeetingStatus } from '@shared/meetings'
import type { MessageAttachment } from '@shared/chats'
import { primaryButton, type PrimaryInput } from '../src/renderer/src/chat/logic/composer'
import { dictationErrorCopy, insertDictation, levelBars, micSlot, permissionStep, voiceInput } from '../src/renderer/src/chat/dictation/logic'
import { WaitingController, blockingMeetings } from '../src/renderer/src/chat/attachments/waiting'
import { attachToDraft, draftAttachments, removeFromDraft, restoreDraftAttachments, takeDraftAttachments } from '../src/renderer/src/chat/attachments/drafts'

// The composer's voice states (DS-59, MV-07), where dictated words land,
// the permission and error rules, and MV-14's held send.

const BASE: PrimaryInput = { hasText: false, canSend: true, running: false, sending: false, editingQueued: false, voice: 'idle' }

describe('composer voice state table (DS-59)', () => {
  const cases: Array<[string, Partial<PrimaryInput>, string, boolean, string, string]> = [
    // name, input, action, disabled, mic, slot
    ['empty and idle: voice is the primary', {}, 'voice', false, 'main', 'none'],
    ['text: send is the primary, the mic is secondary', { hasText: true }, 'send', false, 'secondary', 'mic'],
    ['recording: the primary sends what you said, the secondary stops', { voice: 'recording' }, 'send-transcript', false, 'secondary', 'stop'],
    ['recording with text: still send-transcript', { voice: 'recording', hasText: true }, 'send-transcript', false, 'secondary', 'stop'],
    ['transcribing: a disabled spinner, no mic', { voice: 'transcribing' }, 'busy', true, 'hidden', 'none'],
    ['creating a chat: a disabled spinner, no mic', { creating: true, hasText: true }, 'busy', true, 'hidden', 'none'],
    ['waiting for a transcript: a disabled spinner, no mic', { waiting: true, hasText: true }, 'busy', true, 'hidden', 'none'],
    ['no helper: the voice button keeps its place, disabled', { voice: 'off' }, 'voice', true, 'main', 'none'],
    ['no engine: the voice button is disabled', { canSend: false }, 'voice', true, 'main', 'none'],
    ['running and empty: stop', { running: true }, 'stop', false, 'secondary', 'mic'],
  ]
  it.each(cases)('%s', (_name, input, action, disabled, mic, slot) => {
    const state = primaryButton({ ...BASE, ...input })
    expect(state).toEqual({ action, disabled, mic })
    expect(micSlot(state)).toBe(slot)
  })

  it('maps dictation states onto the composer’s voice input', () => {
    expect(voiceInput('idle', false)).toBe('off')
    expect(voiceInput('listening', true)).toBe('recording')
    expect(voiceInput('starting', true)).toBe('transcribing')
    expect(voiceInput('transcribing', true)).toBe('transcribing')
    expect(voiceInput('error', true)).toBe('idle')
  })
})

describe('insertDictation', () => {
  it('inserts at the caret with spaces where the neighbours need them', () => {
    expect(insertDictation('', 0, 0, ' hello there ')).toEqual({ text: 'hello there', caret: 11 })
    expect(insertDictation('Call  tomorrow', 5, 5, 'Sam')).toEqual({ text: 'Call Sam tomorrow', caret: 8 })
    expect(insertDictation('Hi.', 2, 2, 'there')).toEqual({ text: 'Hi there.', caret: 8 })
    expect(insertDictation('Replace me', 8, 10, 'you')).toEqual({ text: 'Replace you', caret: 11 })
    expect(insertDictation('Keep', 4, 4, '   ')).toEqual({ text: 'Keep', caret: 4 })
    expect(insertDictation('ab', 99, 99, 'c').text).toBe('ab c')
  })
})

describe('permissions and errors', () => {
  it('asks for the microphone first, then speech, and explains a denial', () => {
    expect(permissionStep({ microphone: 'not-determined', speech: 'not-determined', screen: 'granted' })).toEqual({ kind: 'request', what: 'microphone' })
    expect(permissionStep({ microphone: 'granted', speech: 'not-determined', screen: 'granted' })).toEqual({ kind: 'request', what: 'speech' })
    expect(permissionStep({ microphone: 'denied', speech: 'granted', screen: 'granted' })).toEqual({ kind: 'denied', what: 'microphone' })
    expect(permissionStep({ microphone: 'granted', speech: 'restricted', screen: 'granted' })).toEqual({ kind: 'denied', what: 'speech' })
    expect(permissionStep({ microphone: 'granted', speech: 'granted', screen: 'denied' })).toEqual({ kind: 'ok' })
  })

  it('gives every failure a message, and a fix where there is one', () => {
    expect(dictationErrorCopy('mic-denied').action).toEqual({ kind: 'privacy', what: 'microphone' })
    expect(dictationErrorCopy('device-missing').action).toEqual({ kind: 'settings' })
    expect(dictationErrorCopy('no-speech').action).toEqual({ kind: 'retry' })
    expect(dictationErrorCopy('helper-missing').action).toBeNull()
  })

  it('draws a level meter that never collapses', () => {
    expect(levelBars(0)).toEqual([0.18, 0.18, 0.18, 0.18])
    const loud = levelBars(1, 5)
    expect(loud).toHaveLength(5)
    expect(Math.max(...loud)).toBe(loud[2])
    expect(loud.every((h) => h > 0 && h <= 1)).toBe(true)
  })
})

describe('waiting for a transcript (MV-14)', () => {
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'
  const meeting = (id: string): MessageAttachment => ({ kind: 'meeting', meetingId: id })

  it('only waits for meetings that are live or finishing', () => {
    const status: Record<string, MeetingStatus> = { [A]: 'finishing', [B]: 'transcribed' }
    expect(blockingMeetings([meeting(A), meeting(B), { kind: 'image', mediaType: 'image/png', data: 'AAAA' }], (id) => status[id] ?? null)).toEqual([A])
    expect(blockingMeetings([meeting('gone')], () => null)).toEqual([])
  })

  it('sends at once when nothing blocks, holds otherwise and sends when the meeting settles', () => {
    const send = vi.fn()
    const c = new WaitingController<string>(send)
    const status: Record<string, MeetingStatus> = { [A]: 'transcribed' }
    expect(c.offer('now', [meeting(A)], 'x', (id) => status[id] ?? null)).toEqual({ held: false, replaced: null })
    expect(send).toHaveBeenCalledTimes(1)

    status[A] = 'live'
    expect(c.offer('later', [meeting(A)], 'chips', (id) => status[id] ?? null, 10).held).toBe(true)
    expect(c.hold).toMatchObject({ text: 'later', waitingFor: [A], since: 10 })
    status[A] = 'finishing'
    expect(c.update((id) => status[id] ?? null)).toBe(false)
    status[A] = 'summarizing'
    expect(c.update((id) => status[id] ?? null)).toBe(true)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'later', extra: 'chips' }))
    expect(c.hold).toBeNull()
  })

  it('replaces an earlier hold, and cancel hands the message back unsent', () => {
    const send = vi.fn()
    const c = new WaitingController<null>(send)
    const live = (): MeetingStatus => 'live'
    c.offer('first', [meeting(A)], null, live)
    expect(c.offer('second', [meeting(A)], null, live).replaced?.text).toBe('first')
    expect(c.cancel()?.text).toBe('second')
    expect(c.update(() => 'transcribed')).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('draft attachments', () => {
  it('adds a meeting once, takes everything on send and restores ahead of newer chips', () => {
    const chat = 'chat-voice-test'
    expect(attachToDraft(chat, { attachment: { kind: 'meeting', meetingId: 'm1' }, label: 'Sync' })).toBe(true)
    attachToDraft(chat, { attachment: { kind: 'meeting', meetingId: 'm1' }, label: 'Sync' })
    expect(draftAttachments(chat)).toHaveLength(1)
    const taken = takeDraftAttachments(chat)
    expect(draftAttachments(chat)).toHaveLength(0)
    attachToDraft(chat, { attachment: { kind: 'meeting', meetingId: 'm2' }, label: 'Retro' })
    restoreDraftAttachments(chat, taken)
    expect(draftAttachments(chat).map((d) => d.label)).toEqual(['Sync', 'Retro'])
    removeFromDraft(chat, 0)
    removeFromDraft(chat, 0)
    expect(draftAttachments(chat)).toHaveLength(0)
  })
})
