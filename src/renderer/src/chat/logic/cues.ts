/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The cue shapes (NS-03): the notes of Atelier's own short UI sounds, pure
// so tests and the settings preview read them. ui/audio.ts plays them with
// Web Audio; ui/sounds.ts and logic/sounds.ts decide when.

/** One cue: which sound, which variant (done rotates through three), and how loud relative to the default. */
export interface CueSpec {
  id: 'sent' | 'reply' | 'needs-you' | 'done' | 'task-completed' | 'error' | 'intro'
  /** 0, 1 or 2 for the done cue's variants; ignored by the others. */
  variant?: number
  /** 0..1, multiplied with the default gain. */
  volume?: number
}

export interface Note {
  /** Hz */
  freq: number
  /** Seconds from the cue's start. */
  at: number
  dur: number
  wave?: OscillatorType
  /** Relative level of this note. */
  level?: number
  /** Slides to this pitch over the note. */
  glideTo?: number
}

/** Quiet by default: cues sit well under speech and music. */
export const MASTER_GAIN = 0.12

// Atelier's own cue shapes: soft sine and triangle voices, short envelopes.
const CUES: Record<Exclude<CueSpec['id'], 'done'>, Note[]> = {
  sent: [{ freq: 880, at: 0, dur: 0.06, wave: 'sine', level: 0.5, glideTo: 990 }],
  reply: [{ freq: 740, at: 0, dur: 0.09, wave: 'sine', level: 0.6 }],
  'needs-you': [
    { freq: 587.33, at: 0, dur: 0.14, wave: 'triangle' },
    { freq: 880, at: 0.12, dur: 0.22, wave: 'triangle' },
  ],
  'task-completed': [
    { freq: 523.25, at: 0, dur: 0.12, wave: 'sine' },
    { freq: 659.25, at: 0.09, dur: 0.12, wave: 'sine' },
    { freq: 783.99, at: 0.18, dur: 0.12, wave: 'sine' },
    { freq: 1046.5, at: 0.27, dur: 0.3, wave: 'sine', level: 0.8 },
  ],
  error: [
    { freq: 392, at: 0, dur: 0.14, wave: 'triangle', level: 0.8 },
    { freq: 311.13, at: 0.13, dur: 0.24, wave: 'triangle', level: 0.8 },
  ],
  intro: [
    { freq: 659.25, at: 0, dur: 0.1, wave: 'sine', level: 0.7 },
    { freq: 987.77, at: 0.08, dur: 0.18, wave: 'sine', level: 0.7, glideTo: 1046.5 },
  ],
}

const DONE_VARIANTS: Note[][] = [
  [
    { freq: 783.99, at: 0, dur: 0.12, wave: 'sine' },
    { freq: 1046.5, at: 0.1, dur: 0.28, wave: 'sine', level: 0.8 },
  ],
  [
    { freq: 698.46, at: 0, dur: 0.1, wave: 'triangle', level: 0.8 },
    { freq: 880, at: 0.08, dur: 0.1, wave: 'triangle', level: 0.8 },
    { freq: 1174.66, at: 0.16, dur: 0.26, wave: 'sine', level: 0.7 },
  ],
  [{ freq: 932.33, at: 0, dur: 0.34, wave: 'sine', level: 0.9, glideTo: 1046.5 }],
]

/** The notes a cue plays (exported for tests and the settings preview list). */
export function cueNotes(cue: CueSpec): readonly Note[] {
  if (cue.id === 'done') return DONE_VARIANTS[Math.abs(Math.floor(cue.variant ?? 0)) % DONE_VARIANTS.length] ?? []
  return CUES[cue.id]
}
