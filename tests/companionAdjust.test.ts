/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, LOOK_ADJUST_KEYS, type CompanionLook } from '@shared/companion'
import { lookKey, modelKey, normalizeAdjust, normalizeLook } from '@shared/companionLogic'
import { sanitizeLook } from '../src/main/stores'
import { lookSchema } from '../src/main/companion'
import { faceTweaks, planFace, type FaceDefs } from '../src/renderer/src/companion/layout'
import { withAdjust, withoutAdjust } from '../src/renderer/src/companion-card/logic/adjust'

const defs: FaceDefs = {
  eyes: { 'eyes-round': { variants: { neutral: 'eyes.svg' }, pupils: undefined } },
  brows: { 'brows-soft': { variants: { neutral: 'brows.svg' } } },
  mouth: { 'mouth-smile': { variants: { neutral: 'mouth.svg' } } },
} as unknown as FaceDefs
const state = { eyes: 'neutral', brows: 'neutral', mouth: 'neutral' } as never
/** The face the fixture's defs draw. */
const FACE = { eyes: 'eyes-round', brows: 'brows-soft', mouth: 'mouth-smile' }

describe('part adjustments (DS-120)', () => {
  it('clamps to ±1 on the slider step and drops unknown keys, non-numbers and zeros', () => {
    expect(normalizeAdjust({ headSize: 3, eyeSize: -7, mouthSize: 0.333, browTilt: 0, nose: 1, eyeHeight: 'up', earHeight: Number.NaN })).toEqual({
      headSize: 1,
      eyeSize: -1,
      mouthSize: 0.35,
    })
    expect(normalizeAdjust({ browTilt: 0 })).toBeNull()
    expect(normalizeAdjust('big')).toBeNull()
    expect(normalizeAdjust(null)).toBeNull()
  })

  it('imports an old look or file unchanged: no adjust key appears', () => {
    const old = { rig: DEFAULT_LOOK.rig, parts: DEFAULT_LOOK.parts, face: DEFAULT_LOOK.face, colors: DEFAULT_LOOK.colors }
    const normal = normalizeLook(old, {})
    expect('adjust' in normal).toBe(false)
    expect(normal).toEqual(old)
    expect('adjust' in sanitizeLook(old)).toBe(false)
    expect(lookSchema.safeParse(old).success).toBe(true)
  })

  it('keeps clamped adjustments through normalisation, main and the schema', () => {
    const look = { ...DEFAULT_LOOK, adjust: { eyeSpacing: 0.4, headSize: 9 } }
    expect(normalizeLook(look, {}).adjust).toEqual({ eyeSpacing: 0.4, headSize: 1 })
    expect(sanitizeLook(look).adjust).toEqual({ eyeSpacing: 0.4, headSize: 1 })
    const parsed = lookSchema.safeParse({ ...DEFAULT_LOOK, adjust: { eyeSpacing: 0.4 } })
    expect(parsed.success && parsed.data.adjust).toEqual({ eyeSpacing: 0.4 })
    expect(lookSchema.safeParse({ ...DEFAULT_LOOK, adjust: { eyeSpacing: 4 } }).success).toBe(false)
  })

  it('leaves the keys of unadjusted looks alone and separates face from rig changes', () => {
    const plain: CompanionLook = DEFAULT_LOOK
    expect(lookKey({ ...plain, adjust: {} })).toBe(lookKey(plain))
    const eyes = { ...plain, adjust: { eyeSize: 0.5 } }
    expect(lookKey(eyes)).not.toBe(lookKey(plain))
    // A face adjustment only redraws the face texture; a rig one rebuilds the model.
    expect(modelKey(eyes)).toBe(modelKey(plain))
    expect(modelKey({ ...plain, adjust: { headSize: 0.5 } })).not.toBe(modelKey(plain))
  })

  it('moves the face layers per side and leaves an unadjusted plan as before', () => {
    const plain = planFace(defs, FACE, state, { x: 0, y: 0 }, {}, 0.5)
    expect(plain.draws.every((d) => d.dx === 0 && d.dy === 0 && d.scale === 1 && !d.clip)).toBe(true)
    const tuned = planFace(defs, FACE, state, { x: 0, y: 0 }, {}, 0.5, { eyeSpacing: 1, eyeHeight: 0.5, browTilt: 1, mouthSize: 1 })
    const eyes = tuned.draws.filter((d) => d.layer === 'eyes')
    expect(eyes.map((d) => d.clip)).toEqual(['left', 'right'])
    expect(eyes[0]!.dx).toBeLessThan(0)
    expect(eyes[1]!.dx).toBeGreaterThan(0)
    expect(eyes[0]!.dy).toBeLessThan(0)
    const brows = tuned.draws.filter((d) => d.layer === 'brows')
    expect(brows[0]!.rotate).toBeCloseTo(-brows[1]!.rotate!)
    expect(tuned.draws.find((d) => d.layer === 'mouth')!.scale).toBeCloseTo(1.3)
    expect(tuned.key).not.toBe(plain.key)
    expect(faceTweaks(undefined)).toEqual(faceTweaks({}))
  })

  it('sets and resets one slider at a time', () => {
    const one = withAdjust(DEFAULT_LOOK, 'mouthHeight', 0.52)
    expect(one.adjust).toEqual({ mouthHeight: 0.5 })
    expect('adjust' in withAdjust(one, 'mouthHeight', 0)).toBe(false)
    expect('adjust' in withoutAdjust(withAdjust(one, 'eyeSize', 1))).toBe(false)
    expect(LOOK_ADJUST_KEYS).toHaveLength(12)
  })
})
