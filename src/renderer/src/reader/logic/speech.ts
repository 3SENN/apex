/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Read aloud's rules (RD-06), pure for the tests: which voice reads an
// article, where the spoken word is in a block's text, and the queue of
// blocks with its play, pause and resume position. readAloud.ts drives
// speechSynthesis with these.

export interface VoiceLike {
  voiceURI: string
  name: string
  lang: string
  default: boolean
  localService: boolean
}

const base = (lang: string): string => lang.toLowerCase().split(/[-_]/)[0] ?? ''

/**
 * The voice for an article: the chosen one while it exists, else one for the
 * article's language (an exact region first, voices on this Mac before
 * network ones, the system default before the rest), else the default.
 */
export function pickVoice<V extends VoiceLike>(voices: readonly V[], chosen: string | null, lang: string | null, fallbackLang: string): V | null {
  if (voices.length === 0) return null
  if (chosen) {
    const exact = voices.find((v) => v.voiceURI === chosen)
    if (exact) return exact
  }
  const wanted = (lang || fallbackLang || '').replace('_', '-').toLowerCase()
  const score = (v: V): number => {
    const l = v.lang.replace('_', '-').toLowerCase()
    let s = 0
    if (wanted && l === wanted) s += 8
    else if (wanted && base(l) === base(wanted)) s += 4
    else return -1
    if (v.localService) s += 2
    if (v.default) s += 1
    return s
  }
  let best: V | null = null
  let bestScore = -1
  for (const v of voices) {
    const s = score(v)
    if (s > bestScore) {
      best = v
      bestScore = s
    }
  }
  return best ?? voices.find((v) => v.default) ?? voices[0] ?? null
}

/** Voices for the list: the article's language first, then the rest, each by name. */
export function sortVoices<V extends VoiceLike>(voices: readonly V[], lang: string | null): V[] {
  const wanted = base(lang ?? '')
  return [...voices].sort((a, b) => {
    const am = wanted && base(a.lang) === wanted ? 0 : 1
    const bm = wanted && base(b.lang) === wanted ? 0 : 1
    return am - bm || a.name.localeCompare(b.name)
  })
}

/** The word a boundary event points at: [start, end) in `text`, or null past the end. */
export function wordRange(text: string, index: number, length?: number): [number, number] | null {
  if (index < 0 || index >= text.length) return null
  let start = index
  // Some engines point at the space before the word.
  while (start < text.length && /\s/.test(text[start]!)) start++
  if (start >= text.length) return null
  let end = length && length > 0 ? Math.min(text.length, index + length) : start
  if (end <= start) {
    end = start
    while (end < text.length && !/\s/.test(text[end]!)) end++
  }
  return [start, end]
}

/** Where speaking stopped: a block, and an offset into its text. */
export interface SpeechPosition {
  block: number
  offset: number
}

/**
 * A resume point at the start of the word that was being read, so Resume and
 * a speed change pick up at a word, never mid-word.
 */
export function resumeOffset(text: string, offset: number): number {
  let at = Math.max(0, Math.min(offset, text.length))
  while (at > 0 && !/\s/.test(text[at - 1]!)) at--
  return at
}

export type SpeechStatus = 'idle' | 'playing' | 'paused'

export interface QueueState {
  status: SpeechStatus
  position: SpeechPosition
}

/** The queue's moves; each returns the next state. */
export const speechQueue = {
  initial(): QueueState {
    return { status: 'idle', position: { block: 0, offset: 0 } }
  },
  play(state: QueueState, from: number | null): QueueState {
    if (state.status === 'paused') return { status: 'playing', position: state.position }
    return { status: 'playing', position: { block: Math.max(0, from ?? 0), offset: 0 } }
  },
  /** A word started: remember it. */
  word(state: QueueState, block: number, offset: number): QueueState {
    return { ...state, position: { block, offset } }
  },
  pause(state: QueueState): QueueState {
    return state.status === 'playing' ? { ...state, status: 'paused' } : state
  },
  /** The block finished: the next one, or idle after the last. */
  finished(state: QueueState, blocks: number): QueueState {
    const next = state.position.block + 1
    return next >= blocks ? speechQueue.initial() : { status: 'playing', position: { block: next, offset: 0 } }
  },
  stop(): QueueState {
    return speechQueue.initial()
  },
}
