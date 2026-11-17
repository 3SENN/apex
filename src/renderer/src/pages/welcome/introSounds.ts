/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The intro's sounds (NS-04): a few soft Web Audio notes timed to the dawn's
// beats, at a modest volume, on the same kind of voices as the app's sound cues. The
// caller mutes them when intro sounds are off or reduced motion is on.
import { playCue } from '../../ui/audio'

export type IntroBeat = 'mark' | 'rise' | 'welcome'

let ctx: AudioContext | null = null
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

const BEATS: Record<Exclude<IntroBeat, 'welcome'>, Array<{ freq: number; at: number; dur: number; glideTo?: number; wave: OscillatorType }>> = {
  // A low swell while the mark draws.
  mark: [
    { freq: 196, at: 0, dur: 0.9, wave: 'sine', glideTo: 261.63 },
    { freq: 392, at: 0.35, dur: 0.6, wave: 'triangle' },
  ],
  // Two rising notes as the companion pops up.
  rise: [
    { freq: 523.25, at: 0, dur: 0.16, wave: 'triangle' },
    { freq: 783.99, at: 0.12, dur: 0.28, wave: 'sine', glideTo: 880 },
  ],
}

const GAIN = 0.06

export function playIntroBeat(beat: IntroBeat): void {
  if (beat === 'welcome') {
    playCue({ id: 'intro', volume: 0.8 })
    return
  }
  const c = audio()
  if (!c) return
  const start = c.currentTime + 0.02
  const master = c.createGain()
  master.gain.value = GAIN
  master.connect(c.destination)
  for (const note of BEATS[beat]) {
    const t0 = start + note.at
    const t1 = t0 + note.dur
    const osc = c.createOscillator()
    const env = c.createGain()
    osc.type = note.wave
    osc.frequency.setValueAtTime(note.freq, t0)
    if (note.glideTo) osc.frequency.exponentialRampToValueAtTime(note.glideTo, t1)
    env.gain.setValueAtTime(0.0001, t0)
    env.gain.exponentialRampToValueAtTime(1, t0 + Math.min(0.08, note.dur / 3))
    env.gain.exponentialRampToValueAtTime(0.0001, t1)
    osc.connect(env).connect(master)
    osc.start(t0)
    osc.stop(t1 + 0.02)
  }
}
