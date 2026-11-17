/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// An agent-built app's tile: a code-drawn monogram on one of the tab-group
// hues (light and dark come with the tokens), picked from the app's id so it
// stays the same everywhere. No image assets.
import type { CSSProperties, ReactElement } from 'react'
import { cx } from '../ui'

const HUES = ['iris', 'lagoon', 'fern', 'honey', 'coral', 'berry', 'sage', 'graphite'] as const

export function appHue(id: string): (typeof HUES)[number] {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length] as (typeof HUES)[number]
}

/** One or two letters from the name: "Habit tracker" → "HT", "dice" → "D". */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? [words[0], words[1]] : words.slice(0, 1)
  return letters.map((w) => [...(w ?? '')][0]?.toUpperCase() ?? '').join('') || '·'
}

export function AppGlyph({ id, name, size = 'md' }: { id: string; name: string; size?: 'sm' | 'md' | 'lg' }): ReactElement {
  const hue = appHue(id)
  const style = { '--pl-glyph-fill': `var(--group-${hue}-fill)`, '--pl-glyph-text': `var(--group-${hue}-text)`, '--pl-glyph-ring': `var(--group-${hue}-ring)` } as CSSProperties
  return (
    <span className={cx('pl-glyph', size !== 'md' && `pl-glyph--${size}`)} style={style} aria-hidden>
      {monogram(name)}
    </span>
  )
}
