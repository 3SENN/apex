/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { effectiveReadAloudModifier, type ReadAloudModifier, type VoiceChord } from '@shared/voice'

// The hold-to-talk chord. Atelier sees the keys only through
// the input interceptor on its own webContents, never system-wide. A press
// that lasts HOLD_MS (auto-repeat ignored) starts a turn and its key-up ends
// it; a shorter tap types what the chord would have typed. The read-aloud
// modifier held at any point marks the turn spoken. Pure, so it is tested
// without Electron.

/** How long the chord must be held before a turn starts. */
export const HOLD_MS = 250

/** The fields of Electron's Input the tracker reads. */
export interface KeyInput {
  type: string
  key: string
  code: string
  alt: boolean
  control: boolean
  shift: boolean
  meta: boolean
  isAutoRepeat: boolean
}

type Mod = 'alt' | 'ctrl' | 'shift' | 'cmd'

function held(input: KeyInput): Record<Mod, boolean> {
  return { alt: input.alt, ctrl: input.control, shift: input.shift, cmd: input.meta }
}

function chordMods(chord: VoiceChord): Mod[] {
  return chord.split('+').filter((p): p is Mod => p === 'alt' || p === 'ctrl' || p === 'shift' || p === 'cmd')
}

const MOD_KEYS: Record<Mod, readonly string[]> = { alt: ['Alt', 'AltGraph'], ctrl: ['Control'], shift: ['Shift'], cmd: ['Meta'] }

function isSpace(input: KeyInput): boolean {
  return input.code === 'Space' || input.key === ' '
}

/** Whether a key-down is the chord: its modifiers all held, and no other but the read-aloud one. */
export function matchesChord(input: KeyInput, chord: VoiceChord, readAloud: ReadAloudModifier): boolean {
  if (!isSpace(input)) return false
  const mods = held(input)
  const need = chordMods(chord)
  const extra = effectiveReadAloudModifier(chord, readAloud)
  for (const mod of Object.keys(mods) as Mod[]) {
    if (need.includes(mod)) {
      if (!mods[mod]) return false
    } else if (mods[mod] && mod !== extra) return false
  }
  return true
}

/** Whether the read-aloud modifier is down in this event (as a flag, or as the key itself). */
export function readAloudHeld(input: KeyInput, chord: VoiceChord, readAloud: ReadAloudModifier): boolean {
  const mod = effectiveReadAloudModifier(chord, readAloud)
  return held(input)[mod] || (input.type === 'keyDown' && MOD_KEYS[mod].includes(input.key))
}

/** The character a tap of the chord would have typed: ⌥Space types a no-break space on a Mac. */
export function tapText(chord: VoiceChord, platform: string = process.platform): string {
  return chord === 'alt+space' && platform === 'darwin' ? ' ' : ''
}

export interface ChordTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface ChordCallbacks<C> {
  /** The hold began: start listening. */
  start(context: C, readAloud: boolean): void
  /** The read-aloud modifier went down during a hold. */
  readAloud(context: C): void
  /** The chord was released after a hold. */
  end(context: C, readAloud: boolean): void
  /** A short tap: type the chord's character into `context`. */
  tap(context: C): void
}

type Phase = 'idle' | 'pending' | 'holding' | 'draining'

/**
 * One chord press at a time. `input` answers 'handled' for every key it
 * swallows (the router then calls preventDefault), 'pass' otherwise.
 */
export class ChordTracker<C> {
  #phase: Phase = 'idle'
  #timer: unknown = null
  #context: C | null = null
  #readAloud = false
  readonly #callbacks: ChordCallbacks<C>
  readonly #timers: ChordTimers
  readonly #holdMs: number

  constructor(callbacks: ChordCallbacks<C>, timers: ChordTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) }, holdMs = HOLD_MS) {
    this.#callbacks = callbacks
    this.#timers = timers
    this.#holdMs = holdMs
  }

  get phase(): Phase {
    return this.#phase
  }

  input(input: KeyInput, chord: VoiceChord, readAloud: ReadAloudModifier, context: C): 'handled' | 'pass' {
    const down = input.type === 'keyDown' || input.type === 'rawKeyDown'
    const up = input.type === 'keyUp'
    if (this.#phase === 'idle') {
      if (!down || input.isAutoRepeat || !matchesChord(input, chord, readAloud)) return 'pass'
      this.#phase = 'pending'
      this.#context = context
      this.#readAloud = readAloudHeld(input, chord, readAloud)
      this.#timer = this.#timers.set(() => this.#begin(), this.#holdMs)
      return 'handled'
    }

    // A press is in progress.
    if (this.#phase !== 'draining' && readAloudHeld(input, chord, readAloud) && !this.#readAloud) {
      this.#readAloud = true
      if (this.#phase === 'holding' && this.#context !== null) this.#callbacks.readAloud(this.#context)
    }
    if (isSpace(input)) {
      if (down) return 'handled' // auto-repeat while held
      if (up) {
        this.#release(true)
        return 'handled'
      }
      return 'pass'
    }
    // Letting go of one of the chord's own modifiers ends the hold as well.
    if (up && chordMods(chord).some((m) => MOD_KEYS[m].includes(input.key))) this.#release(false)
    return 'pass'
  }

  /** The window lost focus mid-press: a hold ends (the text still goes), a pending tap is dropped. */
  blur(): void {
    if (this.#phase === 'holding') this.#finish()
    else this.#reset()
  }

  #begin(): void {
    this.#timer = null
    if (this.#phase !== 'pending' || this.#context === null) return
    this.#phase = 'holding'
    this.#callbacks.start(this.#context, this.#readAloud)
  }

  #release(spaceUp: boolean): void {
    if (this.#phase === 'holding') {
      this.#finish()
      if (!spaceUp) this.#phase = 'draining'
      return
    }
    if (this.#phase === 'pending') {
      const context = this.#context
      this.#reset()
      if (context !== null) this.#callbacks.tap(context)
      if (!spaceUp) this.#phase = 'draining'
      return
    }
    // Draining: the Space key-up after a modifier let go.
    if (spaceUp) this.#reset()
  }

  #finish(): void {
    const context = this.#context
    const readAloud = this.#readAloud
    this.#reset()
    if (context !== null) this.#callbacks.end(context, readAloud)
  }

  #reset(): void {
    if (this.#timer !== null) this.#timers.clear(this.#timer)
    this.#timer = null
    this.#phase = 'idle'
    this.#context = null
    this.#readAloud = false
  }
}
