/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The UI sound cues (NS-03): Atelier's own short cues, synthesized with
// Web Audio at a modest gain (no sound files). The intro sounds use
// the same voices. Callers decide when a cue may play (ui/sounds.ts). The
// cue shapes are in chat/logic/cues.ts.
import { MASTER_GAIN, cueNotes, type CueSpec } from '../chat/logic/cues'

export { cueNotes, type CueSpec }

let context: AudioContext | null = null

function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  context ??= new AudioContext()
  // A context made before any gesture starts suspended; resuming is harmless when running.
  if (context.state === 'suspended') void context.resume().catch(() => undefined)
  return context
}

export function playCue(cue: CueSpec): void {
  const ctx = audio()
  if (!ctx) return
  const volume = Math.max(0, Math.min(1, cue.volume ?? 1))
  if (volume === 0) return
  const start = ctx.currentTime + 0.01
  const master = ctx.createGain()
  master.gain.value = MASTER_GAIN * volume
  master.connect(ctx.destination)
  let end = start
  for (const note of cueNotes(cue)) {
    const t0 = start + note.at
    const t1 = t0 + note.dur
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = note.wave ?? 'sine'
    osc.frequency.setValueAtTime(note.freq, t0)
    if (note.glideTo) osc.frequency.exponentialRampToValueAtTime(note.glideTo, t1)
    // A quick attack and an exponential tail: no clicks at either end.
    env.gain.setValueAtTime(0.0001, t0)
    env.gain.exponentialRampToValueAtTime(note.level ?? 1, t0 + 0.012)
    env.gain.exponentialRampToValueAtTime(0.0001, t1)
    osc.connect(env)
    env.connect(master)
    osc.start(t0)
    osc.stop(t1 + 0.02)
    end = Math.max(end, t1 + 0.05)
  }
  setTimeout(() => master.disconnect(), Math.ceil((end - ctx.currentTime) * 1000) + 50)
}
