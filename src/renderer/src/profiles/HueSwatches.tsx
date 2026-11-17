/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import type { ProfileHue } from '@shared/profile'
import { hueSwatches, nextHue } from './logic'
import './profiles.css'

// The profile colour picker (ST-37, ST-39, DS-03): a radio group of round
// swatches, one per hue, each drawn in the hue the chrome capsule uses in
// the current mode. Arrow keys move and choose, like any radio group.

export function HueSwatches({ value, onChange, label, disabled = false, id }: { value: ProfileHue; onChange(hue: ProfileHue): void; label: string; disabled?: boolean; id?: string }): ReactElement {
  const group = useRef<HTMLDivElement>(null)
  const swatches = hueSwatches()
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const next = nextHue(value, e.key)
    if (!next || disabled) return
    e.preventDefault()
    onChange(next)
    group.current?.querySelector<HTMLButtonElement>(`[data-hue="${next}"]`)?.focus()
  }
  return (
    <div ref={group} id={id} className="pf-hues" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} onKeyDown={onKey}>
      {swatches.map((s) => {
        const checked = s.id === value
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={s.label}
            title={s.label}
            data-hue={s.id}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            className={checked ? 'pf-hue pf-hue--on' : 'pf-hue'}
            style={{ '--pf-hue-light': s.light, '--pf-hue-dark': s.dark } as CSSProperties}
            onClick={() => onChange(s.id)}
          />
        )
      })}
    </div>
  )
}

/** A profile's round initial on its hue, for lists and headers (never a companion head). */
export function ProfileBadge({ name, hue, size = 32 }: { name: string; hue: ProfileHue; size?: number }): ReactElement {
  const s = hueSwatches().find((h) => h.id === hue) ?? hueSwatches()[0]!
  const initial = (name.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toLocaleUpperCase()
  return (
    <span className="pf-badge" aria-hidden="true" style={{ '--pf-hue-light': s.light, '--pf-hue-dark': s.dark, '--pf-size': `${size}px` } as CSSProperties}>
      {initial}
    </span>
  )
}
