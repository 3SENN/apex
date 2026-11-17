/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { FACE_CANVAS, type FacePartDef, type FaceState } from '../src/shared/companion'
import {
  faceFiles,
  fallbackLayout,
  frameBounds,
  framePortrait,
  outlinePixels,
  planFace,
  pupilOffset,
  worldPerPixel,
  type FaceDefs,
} from '../src/renderer/src/companion/layout'

const variants = (id: string, names: string[]): Record<string, string> =>
  Object.fromEntries(names.map((n) => [n, `face/${id}/${n}.svg`]))

const eyes: FacePartDef = {
  label: 'Round',
  variants: variants('eyes-round', ['neutral', 'blink', 'happy', 'focused', 'wide', 'sad', 'sleepy']),
  pupils: 'face/eyes-round/pupils.svg',
  pupilVariants: ['neutral', 'focused', 'wide', 'sad'],
}
const defs: FaceDefs = {
  eyes: { 'eyes-round': eyes, 'eyes-dot': { label: 'Dot', variants: variants('eyes-dot', ['neutral', 'blink']) } },
  brows: { 'brows-soft': { label: 'Soft', variants: variants('brows-soft', ['neutral', 'raised', 'furrowed', 'sad']) } },
  mouth: { 'mouth-smile': { label: 'Smile', variants: variants('mouth-smile', ['neutral', 'happy', 'talk-small', 'talk-wide', 'o', 'sad', 'flat']) } },
}
const ids = { eyes: 'eyes-round', brows: 'brows-soft', mouth: 'mouth-smile' }
const neutral: FaceState = { eyes: 'neutral', brows: 'neutral', mouth: 'neutral' }
const pupils = { 'eyes-round': { rangeX: 0.03, rangeY: 0.04, scale: 1.1 } }

describe('companion framing', () => {
  it('fits the taller of height and width, centred on the character axis', () => {
    const framing = frameBounds({ min: [-0.5, 0, -0.4], max: [0.9, 2, 0.4] }, 1)
    expect(framing.targetY).toBeCloseTo(1)
    expect(framing.span).toBeCloseTo(2)
    const wide = frameBounds({ min: [-0.5, 0, -0.4], max: [1.5, 1, 0.4] }, 1)
    expect(wide.span).toBeCloseTo(3)
  })

  it('backs off further for a bigger character and keeps the ground in view', () => {
    const small = frameBounds({ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] })
    const big = frameBounds({ min: [-1, 0, -0.5], max: [1, 2, 0.5] })
    expect(big.distance).toBeGreaterThan(small.distance)
    const floating = frameBounds({ min: [-0.5, 0.4, -0.5], max: [0.5, 1.4, 0.5] }, 1)
    expect(floating.targetY - floating.span / 2).toBeLessThanOrEqual(0)
  })

  it('survives empty or broken bounds', () => {
    const framing = frameBounds({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })
    expect(Number.isFinite(framing.distance)).toBe(true)
    expect(framing.distance).toBeGreaterThan(0)
  })

  it('keeps outlines visible when small and proportional when large', () => {
    expect(outlinePixels(32)).toBeGreaterThanOrEqual(1.25)
    expect(outlinePixels(512)).toBeGreaterThan(outlinePixels(64))
    const framing = frameBounds({ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] })
    expect(worldPerPixel(framing, 100) * 100).toBeCloseTo(framing.span)
  })
})

describe('portrait framing', () => {
  const body = { min: [-0.6, 0, -0.5], max: [0.6, 2, 0.5] } as const
  const head = { min: [-0.5, 1.1, -0.45], max: [0.5, 2, 0.45] } as const

  it('fills the view with the head and a little of the body', () => {
    const portrait = framePortrait(body, head, 1)
    const full = frameBounds(body, 1)
    expect(portrait.span).toBeLessThan(full.span * 0.7)
    expect(portrait.targetY).toBeGreaterThan(full.targetY)
    expect(portrait.targetY + portrait.span / 2).toBeGreaterThanOrEqual(2)
    expect(portrait.targetY - portrait.span / 2).toBeLessThan(1.1)
  })

  it('falls back to the full framing without head bounds', () => {
    const empty = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } as const
    expect(framePortrait(body, empty)).toEqual(frameBounds(body, 1.16))
  })
})

describe('face plan', () => {
  it('draws eyes, both pupils, brows and mouth in order', () => {
    const plan = planFace(defs, ids, neutral, { x: 0, y: 0 }, pupils, 0.5)
    expect(plan.draws.map((d) => d.layer)).toEqual(['eyes', 'pupils', 'pupils', 'brows', 'mouth'])
    expect(plan.draws[0]?.file).toBe('face/eyes-round/neutral.svg')
    expect(plan.draws.filter((d) => d.layer === 'pupils').map((d) => [d.clip, d.cx, d.scale])).toEqual([
      ['left', 176, 1.1],
      ['right', 336, 1.1],
    ])
    expect(plan.cheeks).toBe(0.5)
  })

  it('hides pupils for variants that do not show them', () => {
    const plan = planFace(defs, ids, { ...neutral, eyes: 'blink' }, { x: 0, y: 0 }, pupils, 0)
    expect(plan.draws.map((d) => d.layer)).toEqual(['eyes', 'brows', 'mouth'])
    expect(plan.draws[0]?.file).toBe('face/eyes-round/blink.svg')
  })

  it('moves pupils by gaze × range, up meaning a smaller canvas y', () => {
    const plan = planFace(defs, ids, neutral, { x: 1, y: 1 }, pupils, 0)
    const pupil = plan.draws.find((d) => d.layer === 'pupils')
    expect(pupil?.dx).toBeCloseTo(0.03 * FACE_CANVAS.width, 0)
    expect(pupil?.dy).toBeCloseTo(-0.04 * FACE_CANVAS.height, 0)
    expect(pupilOffset({ x: 5, y: -5 }, pupils['eyes-round'])).toEqual(pupilOffset({ x: 1, y: -1 }, pupils['eyes-round']))
  })

  it('changes its key only when the drawn pixels would', () => {
    const base = planFace(defs, ids, neutral, { x: 0.1, y: 0 }, pupils, 0.5).key
    expect(planFace(defs, ids, neutral, { x: 0.1001, y: 0 }, pupils, 0.5).key).toBe(base)
    expect(planFace(defs, ids, neutral, { x: 0.3, y: 0 }, pupils, 0.5).key).not.toBe(base)
    expect(planFace(defs, ids, { ...neutral, mouth: 'o' }, { x: 0.1, y: 0 }, pupils, 0.5).key).not.toBe(base)
    expect(planFace(defs, ids, neutral, { x: 0.1, y: 0 }, pupils, 0.8).key).not.toBe(base)
  })

  it('falls back to the neutral variant and skips unknown parts', () => {
    const plan = planFace(defs, { ...ids, eyes: 'eyes-dot', mouth: 'mouth-none' }, { ...neutral, eyes: 'wide' }, { x: 0, y: 0 }, pupils, 0)
    expect(plan.draws.map((d) => d.file)).toEqual(['face/eyes-dot/neutral.svg', 'face/brows-soft/neutral.svg'])
  })

  it('lists every file a face can need for preloading', () => {
    const files = faceFiles(defs, ids)
    expect(files).toContain('face/eyes-round/pupils.svg')
    expect(files).toContain('face/mouth-smile/talk-wide.svg')
    expect(files).toHaveLength(7 + 1 + 4 + 7)
  })
})

describe('2D fallback layout', () => {
  it('centres a circle with the face inside it', () => {
    const layout = fallbackLayout(100)
    expect(layout.cx).toBe(50)
    expect(layout.radius).toBeLessThan(50)
    expect(layout.face.x).toBeGreaterThan(layout.cx - layout.radius)
    expect(layout.face.x + layout.face.width).toBeLessThan(layout.cx + layout.radius)
    expect(layout.face.width / layout.face.height).toBeCloseTo(FACE_CANVAS.width / FACE_CANVAS.height)
  })
})
