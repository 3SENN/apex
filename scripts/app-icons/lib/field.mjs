/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The glyph field behind Pip on the icons: Apex's "tide weave" (the
// ShapeField on the companion card), one still frame of it. The lattice, the
// hash and the tide are the same maths as src/renderer/src/ui/logic/ambient.ts
// (tests/appIconField.test.ts keeps them in step); the glyphs are drawn as
// filled outlines, as AmbientField.tsx strokes them on its canvas.

import { Path, strokeOutline } from './geometry.mjs'

export const GLYPHS = ['plus', 'ring', 'capsule', 'sparkle']
const CAPSULE_ANGLES = [Math.PI / 4, -Math.PI / 4, 0, Math.PI / 2]
/** The card's tide, in lattice pitches rather than CSS pixels (190 px at a 22 px pitch). */
export const TIDE = { wavelength: 190 / 22, period: 8000, low: 0.3, high: 0.82 }
/** The moment the card's still frame shows (AmbientField STILL_AT_MS). */
export const STILL_AT_MS = 2600
export const VANISH = 0.08
/** A glyph at full swell, as a share of the pitch (AmbientField maxSize). */
export const GLYPH_MAX = 0.62

export function hash32(a, b, seed) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

export function buildLattice(width, height, pitch, seed = 1) {
  if (width <= 0 || height <= 0 || pitch <= 0) return []
  const rowHeight = (pitch * Math.sqrt(3)) / 2
  const cells = []
  const rows = Math.ceil(height / rowHeight) + 1
  const cols = Math.ceil(width / pitch) + 1
  for (let r = -1; r <= rows; r++) {
    const offset = r % 2 === 0 ? 0 : pitch / 2
    for (let c = -1; c <= cols; c++) {
      const h = hash32(c, r, seed)
      cells.push({
        x: c * pitch + offset,
        y: r * rowHeight,
        glyph: GLYPHS[h % GLYPHS.length],
        jitter: ((h >>> 8) & 0xffff) / 0xffff,
        angle: CAPSULE_ANGLES[(h >>> 4) % CAPSULE_ANGLES.length]
      })
    }
  }
  return cells
}

export function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** The swell at `distance` (in pitches) from the origin at `timeMs`. */
export function tideAt(distance, timeMs, opts = TIDE) {
  const phase = distance / opts.wavelength - timeMs / opts.period
  const raw = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase)
  return smoothstep(opts.low, opts.high, raw)
}

export function glyphScale(tide, ripple, jitter) {
  const s = Math.min(1, tide + ripple * 0.75) * (0.82 + 0.18 * jitter)
  return s < VANISH ? 0 : Math.min(1, s)
}

const TAU = Math.PI * 2

/** One glyph as a filled outline, `size` across at full swell (AmbientField drawGlyph's proportions). */
export function glyphPath(cell, size) {
  const { x, y } = cell
  switch (cell.glyph) {
    case 'plus': {
      const arm = size * 0.42
      const half = size * 0.13
      return new Path()
        .add(strokeOutline([[x - arm, y], [x + arm, y]], half))
        .add(strokeOutline([[x, y - arm], [x, y + arm]], half))
    }
    case 'ring': {
      const r = size * 0.36
      const half = size * 0.1
      return new Path()
        .arc(x, y, r + half, 0, TAU, true)
        .close()
        .arc(x, y, r - half, 0, -TAU, true)
        .close()
    }
    case 'capsule': {
      const half = size * 0.32
      const dx = Math.cos(cell.angle) * half
      const dy = Math.sin(cell.angle) * half
      return strokeOutline([[x - dx, y - dy], [x + dx, y + dy]], size * 0.17)
    }
    default: {
      // The sparkle: four quadratic arcs through the tips, drawn as cubics.
      const r = size * 0.55
      const k = size * 0.1
      const tips = [[x, y - r], [x + r, y], [x, y + r], [x - r, y]]
      const ctrl = [[x + k, y - k], [x + k, y + k], [x - k, y + k], [x - k, y - k]]
      const p = new Path().moveTo(tips[0][0], tips[0][1])
      for (let i = 0; i < 4; i++) {
        const [x0, y0] = tips[i]
        const [x1, y1] = tips[(i + 1) % 4]
        const [qx, qy] = ctrl[i]
        p.cubicTo(x0 + ((qx - x0) * 2) / 3, y0 + ((qy - y0) * 2) / 3, x1 + ((qx - x1) * 2) / 3, y1 + ((qy - y1) * 2) / 3, x1, y1)
      }
      return p.close()
    }
  }
}

/**
 * The still field over a box as one path per glyph kind's size band:
 *   box     { x, y, w, h } in canvas pixels
 *   pitch   lattice pitch in px
 *   origin  [x, y] in canvas pixels, where the swells roll out from
 *   seed    the arrangement
 *   keep    optional (x, y) → 0..1, a mask (a fade, a clearing); glyphs
 *           below 0.05 are left out and the rest shrink with it
 * Returns one Path holding every visible glyph.
 */
export function fieldPath({ box, pitch, origin, seed = 7, timeMs = STILL_AT_MS, keep }) {
  const cells = buildLattice(box.w, box.h, pitch, seed)
  const maxSize = pitch * GLYPH_MAX
  const path = new Path()
  for (const c of cells) {
    const x = box.x + c.x
    const y = box.y + c.y
    const k = keep ? keep(x, y) : 1
    if (k < 0.05) continue
    const tide = tideAt(Math.hypot(x - origin[0], y - origin[1]) / pitch, timeMs)
    const s = glyphScale(tide, 0, c.jitter) * k
    if (s < VANISH) continue
    path.add(glyphPath({ ...c, x, y }, maxSize * s))
  }
  return path
}
