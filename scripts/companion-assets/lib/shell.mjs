/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Shapes in "frame space": each head's cranium frame maps the unit sphere
// onto the head, with +Z at the face and +Y up. Hair, hats, ears and ear
// accessories are modelled here.

import { surface } from './geometry.mjs'
import { clamp, smoothstep, TAU } from './math.mjs'

/** Unit direction for azimuth (0 = front, +π/2 = the character's left, +X) and elevation. */
export const dir = (az, el) => [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)]
export const at = (az, el, r) => dir(az, el).map((v) => v * r)

/** Wraps an angle to (-π, π]. */
export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a))

/**
 * A cap hugging the unit sphere, bounded below by `edge(az)` (an
 * elevation). Its rim rolls under into the head (to radius `tuck`) so the
 * edge reads as a thick, rounded hairline wherever the head really is.
 * `thick(az, el)` is the height above the sphere. Open underneath, which
 * stays hidden inside the head.
 */
export function shell({ edge, thick, nu = 72, nv = 22, tuck = 0.84, roll = 0.07, lip = 0.16, crown = Math.PI / 2 }) {
  return surface(nu, nv, (u, v) => {
    const az = -Math.PI + TAU * u
    const b = edge(az)
    let el, r
    if (v < lip) {
      const a = (v / lip) * (Math.PI / 2)
      const top = 1 + thick(az, b + roll)
      r = tuck + (top - tuck) * Math.sin(a)
      el = b + roll * (1 - Math.cos(a))
    } else {
      const s = (v - lip) / (1 - lip)
      el = b + roll + (crown - (b + roll)) * (1 - (1 - s) ** 1.4)
      r = 1 + thick(az, el)
    }
    return at(az, el, r)
  }, { closed: false })
}

/** Blend between front, side and back values of an edge or thickness by azimuth. */
export function around(front, side, back, { frontWidth = 0.8, backWidth = 2.3, soft = 0.35 } = {}) {
  return (az) => {
    const a = Math.abs(wrap(az))
    const toSide = smoothstep(frontWidth - soft, frontWidth + soft, a)
    const toBack = smoothstep(backWidth - soft, backWidth + soft, a)
    const f = typeof front === 'function' ? front(az) : front
    const s = typeof side === 'function' ? side(az) : side
    const k = typeof back === 'function' ? back(az) : back
    return f + (s - f) * toSide + (k - s) * toBack
  }
}

export { clamp }
