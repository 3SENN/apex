/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Bilingual meetings (two languages at once). The helper listens to the same
// audio in both languages (PairRecognizer in native/speech/Engine.swift, or
// one file pass per language) and tags every line with its language; each
// final also says how sure its recognizer was (`confidence`) and how well its
// text reads as that language (`fit`, from Apple's language recognizer).
// Confidence carries most of the weight: a recognizer that forces the other
// language into its own words still writes fluent-looking text, but it is
// unsure of it. This keeps, for each stretch of speech, the language that
// fits: a final stays when it wins at least half of its own time against the
// other language's finals over the same time (the higher score wins a
// moment; a near tie goes to the first language). A final is
// decided once the other language has reported past it, or SETTLE_MS after
// it arrived (live only: a file's second language comes in a later pass);
// partials show in the language that won last.
import type { SpeechSessionEvent, SpeechSource } from '@shared/speech'

export interface Heard {
  source: SpeechSource
  locale: string
  text: string
  startMs: number
  endMs: number
  fit: number
  /** How sure its recognizer was, 0 to 1; absent when it didn't say. */
  confidence?: number
}

/** A final's weight: its recognizer's confidence, nudged by how well the text reads as its language; the fit alone without one. */
export function score(heard: Pick<Heard, 'fit' | 'confidence'>): number {
  return heard.confidence === undefined ? heard.fit : heard.confidence * (0.6 + 0.4 * heard.fit)
}

/** How long a final waits for the other language before it's decided without it. */
export const SETTLE_MS = 4_000
/** Fits closer than this count as a tie (the first language wins it). */
const TIE = 0.05
/** Decided finals kept to judge later ones against, in audio time. */
const CONTEXT_MS = 120_000

/** True when `heard` wins at least half of its own time against `rivals` (the other language's finals for the same source). */
export function wins(heard: Heard, rivals: readonly Heard[], primary: string): boolean {
  const overlapping = rivals.filter((r) => r.locale !== heard.locale && r.source === heard.source && r.startMs < heard.endMs && r.endMs > heard.startMs)
  if (overlapping.length === 0) return true
  const beats = (rival: Heard): boolean => score(heard) > score(rival) + TIE || (Math.abs(score(heard) - score(rival)) <= TIE && heard.locale === primary)
  const span = heard.endMs - heard.startMs
  // A final with no length is a moment: it wins when it beats every rival there.
  if (span <= 0) return overlapping.every(beats)
  const cuts = [...new Set([heard.startMs, heard.endMs, ...overlapping.flatMap((r) => [r.startMs, r.endMs])])].filter((t) => t >= heard.startMs && t <= heard.endMs).sort((a, b) => a - b)
  let won = 0
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = cuts[i]!
    const to = cuts[i + 1]!
    const there = overlapping.filter((r) => r.startMs < to && r.endMs > from)
    if (there.length === 0 || there.every(beats)) won += to - from
  }
  return won * 2 >= span
}

type LineEvent = Extract<SpeechSessionEvent, { type: 'partial' | 'final' }> & { locale?: string; fit?: number; confidence?: number }

export class BilingualMerger {
  readonly #primary: string
  readonly #pending: Array<Heard & { at: number }> = []
  #decided: Heard[] = []
  /** How far each language has reported, per source (`source|locale` → end). */
  readonly #reached = new Map<string, number>()
  readonly #leader = new Map<SpeechSource, string>()
  readonly #locales: [string, string]
  readonly #settleMs: number | null

  /** `settleMs: null` waits for the other language however long it takes (a file, heard once per language). */
  constructor(primary: string, secondary: string, options: { settleMs?: number | null } = {}) {
    this.#primary = primary
    this.#locales = [primary, secondary]
    this.#settleMs = options.settleMs === undefined ? SETTLE_MS : options.settleMs
  }

  /** One event from the helper in; what to show out. */
  push(event: SpeechSessionEvent, now: number): SpeechSessionEvent[] {
    if (event.type === 'partial') {
      const e = event as LineEvent
      const leader = this.#leader.get(e.source) ?? this.#primary
      return (e.locale ?? this.#primary) === leader ? [event] : []
    }
    if (event.type === 'final') {
      const e = event as LineEvent
      const locale = e.locale ?? this.#primary
      const text = e.text.trim()
      const key = `${e.source}|${locale}`
      this.#reached.set(key, Math.max(this.#reached.get(key) ?? 0, e.endMs))
      if (text) this.#pending.push({ source: e.source, locale, text, startMs: e.startMs, endMs: e.endMs, fit: typeof e.fit === 'number' ? e.fit : 0.5, ...(typeof e.confidence === 'number' ? { confidence: e.confidence } : {}), at: now })
      return this.settle(now)
    }
    // The session ends: everything still waiting is decided first.
    if (event.type === 'stopped' || (event.type === 'error' && event.fatal)) return [...this.settle(now, true), event]
    return [event]
  }

  /** Decides what has settled, in order (call it often); `all` decides everything. */
  settle(now: number, all = false): SpeechSessionEvent[] {
    const out: SpeechSessionEvent[] = []
    for (const source of [...new Set(this.#pending.map((p) => p.source))]) {
      const mine = this.#pending.filter((p) => p.source === source).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
      for (const heard of mine) {
        const other = this.#locales.find((l) => l !== heard.locale) ?? heard.locale
        const ready = all || (this.#reached.get(`${source}|${other}`) ?? -1) >= heard.endMs || (this.#settleMs !== null && now - heard.at >= this.#settleMs)
        // In order: a later final waits for an earlier one.
        if (!ready) break
        const rivals = [...this.#pending, ...this.#decided]
        const keep = wins(heard, rivals, this.#primary)
        this.#pending.splice(this.#pending.indexOf(heard), 1)
        const { at: _at, ...decided } = heard
        this.#decided.push(decided)
        if (keep) {
          this.#leader.set(source, heard.locale)
          out.push({ type: 'final', source, text: heard.text, startMs: heard.startMs, endMs: heard.endMs, locale: heard.locale } as SpeechSessionEvent)
        }
      }
    }
    const latest = Math.max(0, ...this.#decided.map((d) => d.endMs))
    this.#decided = this.#decided.filter((d) => d.endMs >= latest - CONTEXT_MS)
    return out
  }
}
