/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeetingRecorder } from '@shared/meetingCapture'
import type { SpeechBroker } from '@shared/speech'
import type { CaptureMasker } from '../features/personalRuntime'

// What the voice turns and the launcher share. The slots are read lazily:
// a feature that fills its slot after voice starts (or a test fake) is picked
// up on the next turn.

export interface VoiceRuntime {
  broker(): SpeechBroker
  masker(): CaptureMasker
  recorder(): MeetingRecorder
  /** The meeting being recorded right now, if any (its live transcript page opens instead of the launcher). */
  recordingMeeting(): string | null
  /** Remembers which permission a mic-blocked error came from, so 'fix' opens that pane. */
  noteBlocked(code: 'mic-denied' | 'speech-denied'): void
  blockedPane(): 'microphone' | 'speech'
  /** Status changed: broadcast it. */
  changed(): void
}

/** Capture states during which a meeting is being recorded. */
export const RECORDING_STATES = new Set(['starting', 'recording', 'paused'])
