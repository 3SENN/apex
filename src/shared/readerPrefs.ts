/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The reader's preferences (RD-05): typeface, text size, line width, page
// colours and the read-aloud voice and speed. Settings keys in the registry;
// the reader's controls, Settings › Appearance and main's ⌘+ / ⌘- share
// these choices.

export const READER_FONTS = ['serif', 'sans'] as const
export type ReaderFont = (typeof READER_FONTS)[number]

export const READER_WIDTHS = ['narrow', 'medium', 'wide'] as const
export type ReaderWidth = (typeof READER_WIDTHS)[number]

/** 'auto' follows Apex's light or dark mode. */
export const READER_THEMES = ['auto', 'light', 'sepia', 'dark'] as const
export type ReaderTheme = (typeof READER_THEMES)[number]

/** Body text size in CSS px. */
export const READER_TEXT_SIZE = { min: 14, max: 32, default: 20 } as const
/** The sizes A− and A+ step through. */
export const READER_TEXT_STEPS = [14, 16, 18, 20, 22, 24, 27, 30, 32] as const

/** Read-aloud speeds (1 is the voice's normal pace). */
export const READER_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const
export const READER_RATE = { min: 0.5, max: 2, default: 1 } as const

/** The next size up or down from `size` (a size between steps moves to the nearest step that way). */
export function nextTextSize(size: number, step: -1 | 1): number {
  if (step > 0) return READER_TEXT_STEPS.find((s) => s > size) ?? READER_TEXT_SIZE.max
  return [...READER_TEXT_STEPS].reverse().find((s) => s < size) ?? READER_TEXT_SIZE.min
}
