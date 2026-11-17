/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type KeyboardEvent, type ReactElement } from 'react'
import { Check } from 'lucide-react'
import { accentTokens } from '@shared/accent'
import { cx } from '../ui'
import { rovingIndex } from '../ui/logic/keys'

// A colour choice as a radio group (TWK-03): a text pill for "none" first,
// then round swatches. Arrows move and choose, like any radio group; each
// swatch shows its colour as it reads on light and on dark.

export interface SwatchOption {
  id: string
  label: string
  /** #rrggbb; absent for the text pill. */
  color?: string
}

function swatchStyle(color: string): Record<string, string> {
  const light = accentTokens(color, 'light')
  const dark = accentTokens(color, 'dark')
  return { '--twk-swatch-light': light.accent, '--twk-swatch-dark': dark.accent, '--twk-on-light': light.text, '--twk-on-dark': dark.text }
}

export function Swatches({ label, value, options, onChange }: { label: string; value: string; options: readonly SwatchOption[]; onChange(id: string): void }): ReactElement {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const selected = Math.max(0, options.findIndex((o) => o.id === value))
  const onKeyDown = (e: KeyboardEvent, index: number): void => {
    const next = rovingIndex(e.key, index, options.length, { orientation: 'both' })
    const target = next === null ? undefined : options[next]
    if (next === null || !target) return
    e.preventDefault()
    refs.current[next]?.focus()
    onChange(target.id)
  }
  return (
    <div className="twk-swatches" role="radiogroup" aria-label={label}>
      {options.map((o, i) => (
        <button
          key={o.id}
          ref={(node) => {
            refs.current[i] = node
          }}
          type="button"
          role="radio"
          aria-checked={i === selected}
          aria-label={o.label}
          title={o.label}
          tabIndex={i === selected ? 0 : -1}
          className={cx('twk-swatch', !o.color && 'twk-swatch--text')}
          style={o.color ? swatchStyle(o.color) : undefined}
          onClick={() => onChange(o.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.color ? i === selected && <Check aria-hidden /> : o.label}
        </button>
      ))}
    </div>
  )
}
