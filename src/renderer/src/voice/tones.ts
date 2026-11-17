/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Voice tones (MV-04, NS-04): short cues made in code with Web Audio,
// never recorded files. Start rises, end falls, an error is two low notes.
// They follow the voice sounds switch, and play softer under reduced motion.

export type Tone = 'start' | 'end' | 'error'

interface Note {
  freq: number
  at: number
  length: number
  wave: OscillatorType
}

const TONES: Record<Tone, Note[]> = {
  start: [
    { freq: 587.33, at: 0, length: 0.07, wave: 'sine' },
    { freq: 880, at: 0.075, length: 0.09, wave: 'sine' },
  ],
  end: [
    { freq: 880, at: 0, length: 0.07, wave: 'sine' },
    { freq: 659.25, at: 0.075, length: 0.1, wave: 'sine' },
  ],
  error: [
    { freq: 311.13, at: 0, length: 0.11, wave: 'triangle' },
    { freq: 233.08, at: 0.13, length: 0.16, wave: 'triangle' },
  ],
}

const VOLUME = { normal: 0.08, quiet: 0.035 } as const

let audio: AudioContext | null = null

function context(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  audio ??= new AudioContext()
  if (audio.state === 'suspended') void audio.resume().catch(() => undefined)
  return audio
}

/** Plays one cue. `quiet` is for reduced motion. Silent when audio is unavailable. */
export function playTone(tone: Tone, quiet = false): void {
  const ac = context()
  if (!ac) return
  const start = ac.currentTime + 0.01
  const peak = quiet ? VOLUME.quiet : VOLUME.normal
  for (const note of TONES[tone]) {
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = note.wave
    osc.frequency.value = note.freq
    const t0 = start + note.at
    // A short attack and an exponential tail, so no note clicks.
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.length)
    osc.connect(gain).connect(ac.destination)
    osc.start(t0)
    osc.stop(t0 + note.length + 0.02)
  }
}

/** Which cue a HUD or launcher state change plays, if any. */
export function toneFor(previous: string | null, next: string): Tone | null {
  if (next === previous) return null
  if (next === 'listening') return 'start'
  if (next === 'error') return 'error'
  if (previous === 'listening' && (next === 'transcribing' || next === 'typing' || next === 'thinking')) return 'end'
  return null
}
