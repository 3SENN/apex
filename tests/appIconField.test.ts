/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import * as ambient from '../src/renderer/src/ui/logic/ambient'
import * as icon from '../scripts/app-icons/lib/field.mjs'

// The app icon's glyph field (scripts/app-icons/lib/field.mjs) is a still of
// the companion card's ShapeField. The generator runs in plain Node, so it
// carries its own copy of the lattice and tide maths; this keeps the copy
// exactly in step with ui/logic/ambient.ts.

describe('the icon glyph field matches the ShapeField', () => {
  it('uses the same glyphs, hash and lattice', () => {
    expect([...icon.GLYPHS]).toEqual([...ambient.GLYPHS])
    for (const [a, b, s] of [[0, 0, 1], [3, -2, 7], [-11, 40, 123456]] as const) expect(icon.hash32(a, b, s)).toBe(ambient.hash32(a, b, s))
    for (const seed of [1, 5, 7, 11]) {
      expect(icon.buildLattice(300, 180, 24, seed)).toEqual(ambient.buildLattice(300, 180, 24, seed))
    }
    expect(icon.buildLattice(0, 10, 24)).toEqual([])
  })

  it('swells with the same tide, measured in pitches', () => {
    const pitch = 22
    for (const d of [0, 40, 95, 190, 333]) {
      for (const t of [0, icon.STILL_AT_MS, 5000]) expect(icon.tideAt(d / pitch, t)).toBeCloseTo(ambient.tideAt(d, t), 12)
    }
    expect(icon.TIDE.wavelength * pitch).toBeCloseTo(ambient.TIDE.wavelength, 12)
    expect(icon.TIDE.period).toBe(ambient.TIDE.period)
    for (const [tide, jitter] of [[0, 0], [0.05, 1], [0.5, 0.3], [1, 1]] as const) expect(icon.glyphScale(tide, 0, jitter)).toBe(ambient.glyphScale(tide, 0, jitter))
    expect(icon.VANISH).toBe(ambient.VANISH)
    expect(icon.smoothstep(0.3, 0.82, 0.6)).toBe(ambient.smoothstep(0.3, 0.82, 0.6))
  })
})
