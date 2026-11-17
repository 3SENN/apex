/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LidAction, LidPausedBy, LidPolicyEvent, LidRecordingState } from '@shared/haptics'
import type { CaptureState, CaptureStatus } from '@shared/meetingCapture'
import type { HelperLine } from '@shared/speech'

// The lid pause: closing the lid (or sleeping) pauses a meeting
// recording through the recorder's pause('lid'); opening it (or waking)
// resumes only a pause Atelier made, so a pause the person made stays.

/** The pure policy. Resuming ignores `enabled`: a pause Atelier made is always undone. */
export function lidPolicy(event: LidPolicyEvent, recording: LidRecordingState, pausedBy: LidPausedBy, enabled: boolean): LidAction {
  if (event === 'lid-closed' || event === 'suspend') return enabled && recording === 'recording' ? 'pause' : 'none'
  return recording === 'paused' && pausedBy === 'lid' ? 'resume' : 'none'
}

/** Starting, stopping and processing are not something a lid can pause. */
export function lidRecordingState(state: CaptureState): LidRecordingState {
  return state === 'recording' ? 'recording' : state === 'paused' ? 'paused' : 'none'
}

/** A helper line as a lid event, or null for every other line. */
export function lidEventOf(line: HelperLine): LidPolicyEvent | null {
  if (line.type !== 'lid') return null
  return line.closed ? 'lid-closed' : 'lid-opened'
}

export interface LidPauseDeps {
  recorder: { status(): CaptureStatus; pause(by?: 'user' | 'lid'): void; resume(by?: 'user' | 'lid'): void }
  /** settings.pauseMeetingsOnLidClose. */
  enabled(): boolean
  /** Says "Paused while the lid is closed" (the recording widget reads status.pausedBy itself). */
  notifyPaused(): void
}

/**
 * Feeds lid lines and power events through lidPolicy. It remembers the lid:
 * waking with the lid still shut (clamshell mode, idle sleep) is not opening
 * it, so that `resume` waits for the lid's own open line.
 */
export class LidPause {
  readonly #deps: LidPauseDeps
  #lidClosed = false

  constructor(deps: LidPauseDeps) {
    this.#deps = deps
  }

  get lidClosed(): boolean {
    return this.#lidClosed
  }

  handle(event: LidPolicyEvent): LidAction {
    if (event === 'lid-closed') this.#lidClosed = true
    else if (event === 'lid-opened') this.#lidClosed = false
    else if (event === 'resume' && this.#lidClosed) return 'none'
    const status = this.#deps.recorder.status()
    const action = lidPolicy(event, lidRecordingState(status.state), status.pausedBy, this.#deps.enabled())
    if (action === 'pause') {
      this.#deps.recorder.pause('lid')
      this.#deps.notifyPaused()
    } else if (action === 'resume') {
      this.#deps.recorder.resume('lid')
    }
    return action
  }

  /** A raw helper line from broker.onLine; only {type:'lid'} matters. */
  line(line: HelperLine): LidAction {
    const event = lidEventOf(line)
    return event ? this.handle(event) : 'none'
  }
}
