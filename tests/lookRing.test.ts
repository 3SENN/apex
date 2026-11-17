/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, FACE_IDS, PART_IDS, type CompatibilityConfig } from '@shared/companion'
import {
  BUBBLE_SIZE,
  isCurrent,
  isCurrentPalette,
  panelSections,
  partNote,
  RING_CATEGORIES,
  RING_RADIUS,
  ringKeyTarget,
  ringOffset,
  tintSwatches,
  withOption,
} from '../src/renderer/src/companion-card/logic/lookRing'

describe('look ring (DS-118)', () => {
  it('has eight categories, four on each arc, in the Apex mapping', () => {
    expect(RING_CATEGORIES.map((c) => c.id)).toEqual(['colours', 'shape', 'eyes', 'mouth', 'brows', 'hat', 'hair', 'accessories'])
    expect(RING_CATEGORIES.filter((c) => c.side === 'left')).toHaveLength(4)
    expect(BUBBLE_SIZE).toBe(46)
  })

  it('places the inner pairs at (±168, ±120) and the outer pairs at (±198, ±42), near the ring', () => {
    const at = RING_CATEGORIES.map(ringOffset)
    expect(at[0]).toEqual({ x: -168, y: -120 })
    expect(at[1]).toEqual({ x: -198, y: -42 })
    expect(at[2]).toEqual({ x: -198, y: 42 })
    expect(at[3]).toEqual({ x: -168, y: 120 })
    expect(at[4]).toEqual({ x: 168, y: -120 })
    expect(at[7]).toEqual({ x: 168, y: 120 })
    for (const { x, y } of at) expect(Math.abs(Math.hypot(x, y) - RING_RADIUS)).toBeLessThan(10)
  })

  it('moves with the arrow keys as the ring looks', () => {
    expect(ringKeyTarget(0, 'ArrowDown')).toBe(1)
    expect(ringKeyTarget(3, 'ArrowDown')).toBe(0)
    expect(ringKeyTarget(0, 'ArrowUp')).toBe(3)
    expect(ringKeyTarget(4, 'ArrowUp')).toBe(7)
    expect(ringKeyTarget(1, 'ArrowRight')).toBe(5)
    expect(ringKeyTarget(6, 'ArrowLeft')).toBe(2)
    expect(ringKeyTarget(5, 'Home')).toBe(0)
    expect(ringKeyTarget(2, 'End')).toBe(7)
    expect(ringKeyTarget(2, 'Enter')).toBeNull()
  })
})

describe('look ring option panels (DS-119)', () => {
  it('splits shape and accessories into headed sub-groups', () => {
    expect(panelSections('shape').map((s) => s.title)).toEqual(['Body', 'Head', 'Ears'])
    expect(panelSections('accessories').map((s) => s.title)).toEqual(['Glasses', 'Earwear', 'Prop'])
    expect(panelSections('eyes')).toHaveLength(1)
  })

  it('offers None for every slot but the head', () => {
    const [, headSection, ears] = panelSections('shape')
    expect(headSection?.kind === 'part' && headSection.options).toEqual([...PART_IDS.head])
    expect(ears?.kind === 'part' && ears.options[0]).toBeNull()
    const [eyes] = panelSections('eyes')
    expect(eyes?.kind === 'face' && eyes.options).toEqual(FACE_IDS.eyes)
  })

  it('marks the current tile and applies picks', () => {
    const [hair] = panelSections('hair')
    if (!hair) throw new Error('no hair section')
    expect(isCurrent(DEFAULT_LOOK, hair, DEFAULT_LOOK.parts.hair)).toBe(true)
    expect(isCurrent(DEFAULT_LOOK, hair, null)).toBe(false)
    const bald = withOption(DEFAULT_LOOK, hair, null, null)
    expect(bald.parts.hair).toBeNull()
    expect(isCurrent(bald, hair, null)).toBe(true)
    const body = panelSections('shape')[0]
    if (!body) throw new Error('no body section')
    expect(withOption(DEFAULT_LOOK, body, 'B', null).rig).toBe('B')
    expect(withOption(DEFAULT_LOOK, body, 'Z', null)).toBe(DEFAULT_LOOK)
  })

  it('takes the hat off when a new part does not go with it, and says why parts are off', () => {
    const compat: CompatibilityConfig = {
      'hat-wizard': { ears: [], hair: ['hair-tuft'], hat: 'all', eyeAccessory: 'all', earAccessory: 'all' },
      'head-round': { ears: 'all', hair: 'all', hat: 'all', eyeAccessory: 'all', earAccessory: 'all' },
    }
    // The head and hair these rules name, on whatever the branding's default look is.
    const base = { ...DEFAULT_LOOK, parts: { ...DEFAULT_LOOK.parts, head: 'head-round', hair: 'hair-tuft' } }
    const wizard = { ...base, parts: { ...base.parts, hat: 'hat-wizard' } }
    const [hair] = panelSections('hair')
    if (!hair) throw new Error('no hair section')
    const picked = withOption(wizard, hair, 'hair-bob', compat)
    expect(picked.parts.hair).toBe('hair-bob')
    expect(picked.parts.hat).toBeNull()
    const note = partNote({ ...base, parts: { ...base.parts, ears: 'ears-cat' } }, 'hat', 'hat-wizard', compat, (id) => id)
    expect(note).toEqual({ allowed: true, note: 'Replaces the ears-cat' })
    expect(partNote(base, 'hair', 'hair-bob', null, (id) => id)).toEqual({ allowed: true, note: null })
  })

  it('builds the swatch grid from the palettes, without repeats', () => {
    const palettes = [
      { name: 'A', weight: 1, colors: { skin: '#AA0000', hair: '#111111', accent: '#222222', outfit: '#333333' } },
      { name: 'B', weight: 1, colors: { skin: '#aa0000', hair: '#444444', accent: '#555555', outfit: '#666666' } },
    ]
    expect(tintSwatches(palettes, 'skin')).toEqual(['#aa0000'])
    expect(tintSwatches(palettes, 'hair')).toEqual(['#111111', '#444444'])
    expect(isCurrentPalette({ ...DEFAULT_LOOK, colors: { ...palettes[0]!.colors, skin: '#aa0000' } }, palettes[0]!.colors)).toBe(true)
    expect(isCurrentPalette(DEFAULT_LOOK, palettes[0]!.colors)).toBe(false)
  })
})
