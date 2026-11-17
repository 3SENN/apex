/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReaderFont, ReaderTheme, ReaderWidth } from '@shared/readerPrefs'
import { READER_RATES, READER_TEXT_SIZE, READER_TEXT_STEPS } from '@shared/readerPrefs'

// The reader view's state (RD-02, RD-05), kept pure for the tests: the page
// colours a choice resolves to, the line length for a width, the text size
// steps and where each article was scrolled to.

export type ReaderSurface = 'light' | 'sepia' | 'dark'

export interface ReaderPrefs {
  font: ReaderFont
  size: number
  width: ReaderWidth
  theme: ReaderTheme
}

export interface ReaderLook {
  surface: ReaderSurface
  font: ReaderFont
  /** Body text in px, within the allowed range. */
  size: number
  /** The column's line length in em of body text. */
  measure: number
  /** Unitless line height: looser for small text and narrow columns, tighter for large text. */
  leading: number
}

const MEASURE: Record<ReaderWidth, number> = { narrow: 30, medium: 36, wide: 44 }

/** 'auto' takes Atelier's own mode; the others are fixed. */
export function readerSurface(theme: ReaderTheme, app: 'light' | 'dark'): ReaderSurface {
  return theme === 'auto' ? app : theme
}

export function clampTextSize(size: number): number {
  if (!Number.isFinite(size)) return READER_TEXT_SIZE.default
  return Math.round(Math.min(READER_TEXT_SIZE.max, Math.max(READER_TEXT_SIZE.min, size)))
}

export function readerLook(prefs: ReaderPrefs, app: 'light' | 'dark'): ReaderLook {
  const size = clampTextSize(prefs.size)
  const measure = MEASURE[prefs.width] ?? MEASURE.medium
  // Longer lines need a little more space between them to find the next one.
  const leading = (size <= 16 ? 1.7 : size >= 27 ? 1.5 : 1.6) + (prefs.width === 'wide' ? 0.05 : 0)
  return { surface: readerSurface(prefs.theme, app), font: prefs.font, size, measure, leading }
}

/** Whether A− or A+ can still move. */
export function sizeBounds(size: number): { smaller: boolean; larger: boolean } {
  return { smaller: size > READER_TEXT_STEPS[0], larger: size < READER_TEXT_STEPS[READER_TEXT_STEPS.length - 1]! }
}

/** The nearest offered speed, for the speed list. */
export function nearestRate(rate: number): number {
  let best: number = READER_RATES[1]
  for (const r of READER_RATES) if (Math.abs(r - rate) < Math.abs(best - rate)) best = r
  return best
}

/** Where each article was scrolled to, so switching tabs and back keeps the place (per tab and address). */
export class ScrollMemory {
  readonly #spots = new Map<string, number>()
  readonly #limit: number

  constructor(limit = 40) {
    this.#limit = limit
  }

  static key(tabId: string, url: string): string {
    return `${tabId} ${url}`
  }

  remember(key: string, top: number): void {
    this.#spots.delete(key)
    if (top > 0) this.#spots.set(key, Math.round(top))
    while (this.#spots.size > this.#limit) this.#spots.delete(this.#spots.keys().next().value!)
  }

  recall(key: string): number {
    return this.#spots.get(key) ?? 0
  }
}
