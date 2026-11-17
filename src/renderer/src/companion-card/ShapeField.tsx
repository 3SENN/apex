/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AmbientField, cx, type AmbientFieldHandle } from '../ui'
import { FLOOR_CORE, type FieldClearing, type FieldMask } from '../ui/logic/ambient'
import './shapeField.css'

// The companion surfaces' hero background: Atelier's shared ambient field
// (ui/AmbientField, the "tide weave") washed in a companion's colour, with
// the fades and densities the card, the sheets, the first-week banner and
// the new tab's ground use. The owner paints its own wash under it, except
// on the floor, which brings a faint one of its own.

export type FieldDensity = 'card' | 'banner' | 'floor'

/** Lattice pitch per density: the card's fine weave, a slightly coarser one for wide bands and the floor. */
export const FIELD_PITCH: Record<FieldDensity, number> = { card: 22, banner: 26, floor: 24 }

/** The floor is a little quieter than a card's hero: the composer and the ideas sit on it. */
const FIELD_INTENSITY: Record<FieldDensity, number> = { card: 1, banner: 1, floor: 0.85 }

export interface ShapeFieldProps {
  /** The companion colour the glyphs are washed in (#rrggbb). */
  tint: string
  className?: string
  density?: FieldDensity
  /** Where the swells roll out from, as fractions of the field's box (default: its centre). */
  origin?: { x: number; y: number }
  /** Floor only: boxes (px in the field's box) with text on them, which the glyphs keep mostly clear of. */
  clear?: readonly FieldClearing[]
  /** Increment to send one extra ripple outward (an arrival, a finished task). */
  pulse?: number
  /** The owner's own pause, e.g. a layer that isn't showing. */
  paused?: boolean
  /** One still frame only, e.g. a thumbnail. Reduce Motion always gives a still frame. */
  still?: boolean
}

/**
 * An absolutely positioned, pointer-transparent animated field of Atelier's own
 * small glyphs. It pauses off-screen and while the window is hidden,
 * re-tints live on a theme or colour change, is one still frame under
 * Reduce Motion, and gets a fresh arrangement on every mount, so switching
 * companions reshuffles it. Fades are CSS (--field-fade-top, --field-fade-bottom);
 * the floor density instead fades out toward a soft ellipse in the canvas.
 * Its ref sends a ripple from any point (a landing on the floor).
 */
export const ShapeField = forwardRef<AmbientFieldHandle, ShapeFieldProps>(function ShapeField({ tint, className, density = 'card', origin, clear, pulse = 0, paused = false, still = false }, ref) {
  const field = useRef<AmbientFieldHandle>(null)
  const [seed] = useState(() => 1 + Math.floor(Math.random() * 1_000_000))
  useImperativeHandle(ref, () => ({ ripple: (at) => field.current?.ripple(at) }), [])
  useEffect(() => {
    if (pulse > 0) field.current?.ripple()
  }, [pulse])
  const mask = useMemo<FieldMask | undefined>(() => (density === 'floor' ? { ellipse: FLOOR_CORE, clear } : undefined), [density, clear])
  return (
    <div className={cx('co-shape-field', `co-shape-field--${density}`, className)} style={{ '--field-tint': tint } as CSSProperties} aria-hidden="true">
      <AmbientField
        ref={field}
        tint={tint}
        origin={origin}
        pitch={FIELD_PITCH[density]}
        mask={mask}
        intensity={FIELD_INTENSITY[density]}
        paused={paused}
        still={still}
        wash={false}
        seed={seed}
      />
    </div>
  )
})
