/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CSSProperties, ReactElement, ReactNode } from 'react'
import './companion.css'

export interface BubbleProps {
  /** Words fade in one by one after a short beat. */
  text?: string
  /** Inline glyphs (lucide icons, favicons, small faces) that arrive staggered after the text. */
  icons?: ReactNode[]
  /** The side the companion is on: the tail and the rise start there. */
  side?: 'left' | 'right' | 'center'
  /** The companion's colour, for the tail and glyph accents. */
  tint?: string
  /** Re-keys the reveal: a new value plays it again. */
  revealKey?: string | number
  className?: string
  style?: CSSProperties
  /** Polite live region for lines the companion "says"; off for ambient floor chatter. */
  announce?: boolean
}

const WORD_STEP_MS = 45
const BEAT_MS = 140

/**
 * One speech bubble for the floor, picker mode and welcome (DS-80): a
 * rounded rectangle with a two-dot thought tail. It rises from below on the
 * companion's side and scales up from its tail; the text follows word by
 * word after a beat, then the icons one after another. Reduce Motion shows
 * it at once (companion.css).
 */
export function Bubble({ text, icons = [], side = 'left', tint, revealKey, className, style, announce = false }: BubbleProps): ReactElement {
  const words = text ? text.split(/\s+/).filter(Boolean) : []
  return (
    <span
      key={revealKey}
      className={['companion-bubble', `companion-bubble--${side}`, className].filter(Boolean).join(' ')}
      style={{ ...(tint ? { ['--bubble-tint' as string]: tint } : {}), ...style }}
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
    >
      <span className="companion-bubble__body">
        {words.map((word, i) => (
          <span key={i} className="companion-bubble__word" style={{ animationDelay: `${BEAT_MS + i * WORD_STEP_MS}ms` }}>
            {word}
            {i < words.length - 1 ? ' ' : ''}
          </span>
        ))}
        {icons.map((icon, i) => (
          <span key={`i${i}`} className="companion-bubble__icon" style={{ animationDelay: `${BEAT_MS + words.length * WORD_STEP_MS + i * 90}ms` }} aria-hidden="true">
            {icon}
          </span>
        ))}
      </span>
      <span className="companion-bubble__tail" aria-hidden="true">
        <i />
        <i />
      </span>
    </span>
  )
}
