/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { ellipseReach, FACE_BELOW, frameFace, frameBounds, PORTRAIT_BELOW, resolveFraming, stillFraming, type Bounds } from '../src/renderer/src/companion/layout'
import { allocateLive, LIVE_CAP, LIVE_MIN_PX, LiveBudget, PatDetector, type LiveRequest } from '../src/renderer/src/companion/liveBudget'
import { BOB_PERIOD_S, bobPixels, gazeStep, idleBlinks, listenBlinks, nextGlance } from '../src/renderer/src/companion/cadence'
import { seededRng } from '../src/shared/companionLogic'

const head: Bounds = { min: [-0.5, 1, -0.4], max: [0.5, 2, 0.45] }
const skull: Bounds = { min: [-0.45, 1, -0.4], max: [0.45, 1.8, 0.45] }

/** True when every corner of `box` lands inside the framed square (the camera sits at z = distance). */
function fitsWhole(box: Bounds, f: { targetY: number; distance: number; span: number }): boolean {
  for (const x of [box.min[0], box.max[0]])
    for (const y of [box.min[1], box.max[1]])
      for (const z of [box.min[2], box.max[2]]) {
        const scale = f.distance / (f.distance - z)
        if (Math.abs(x) * scale > f.span / 2 + 1e-9 || Math.abs(y - f.targetY) * scale > f.span / 2 + 1e-9) return false
      }
  return true
}

describe('face framing (CO-18, DS-67)', () => {
  it('fits the whole head, hair, ears and hat inside the box with nothing clipped', () => {
    expect(fitsWhole(head, frameFace(head, skull, 1.42))).toBe(true)
    const tall: Bounds = { min: [-0.5, 1, -0.4], max: [0.5, 3.4, 0.45] }
    expect(fitsWhole(tall, frameFace(tall, skull, 1.42))).toBe(true)
    const ears: Bounds = { min: [-1.1, 1, -0.4], max: [1.1, 2, 0.45] }
    expect(fitsWhole(ears, frameFace(ears, skull, 1.42))).toBe(true)
  })

  it('leans from the middle of the head toward the eye line, within a small span cost', () => {
    const f = frameFace(head, skull, 1.42)
    expect(f.targetY).toBeLessThan(1.5)
    expect(f.targetY).toBeGreaterThanOrEqual((1.42 + 1.5) / 2 - 1e-9)
    // Without an eye line (or one outside the head) it uses the same point below the skull's middle.
    expect(frameFace(head, skull, 5).targetY).toBeCloseTo(frameFace(head, skull, null).targetY)
    const centred = frameFace(head, skull, 1.5)
    expect(f.span / centred.span).toBeLessThanOrEqual(1.06 + 1e-9)
  })

  it('stays tight: the head fills most of the box', () => {
    const f = frameFace(head, skull, 1.42)
    expect(f.span).toBeLessThan(((head.max[1] - head.min[1]) / 0.94) * 1.4)
    expect(f.distance).toBeCloseTo(f.span / 2 / Math.tan((13 * Math.PI) / 180))
  })

  it('is much tighter than the full body', () => {
    const body: Bounds = { min: [-0.6, 0, -0.5], max: [0.6, 2, 0.5] }
    expect(frameFace(head, skull, 1.42).span).toBeLessThan(frameBounds(body).span * 0.75)
  })

  it('survives broken bounds', () => {
    const broken: Bounds = { min: [Number.NaN, 0, 0], max: [1, 1, 1] }
    expect(Number.isFinite(frameFace(broken, null, null).span)).toBe(true)
  })

  it('ellipse reach from the centre is the larger semi-axis', () => {
    expect(ellipseReach({ min: [-1, 0, 0], max: [1, 1, 0] }, 0.5)).toBeCloseTo(1, 2)
    expect(ellipseReach({ min: [-0.2, 0, 0], max: [0.2, 2, 0] }, 1)).toBeCloseTo(1, 2)
  })
})

describe('framing rules', () => {
  it('auto frames the face below the portrait size and the full body above', () => {
    expect(resolveFraming('auto', PORTRAIT_BELOW - 1)).toBe('face')
    expect(resolveFraming('auto', PORTRAIT_BELOW)).toBe('full')
    expect(resolveFraming('bust', 400)).toBe('bust')
  })

  it('small stills are face-only, big ones full body, explicit framings win', () => {
    expect(stillFraming(undefined, 36)).toBe('face')
    expect(stillFraming('auto', FACE_BELOW * 2 - 1)).toBe('face')
    expect(stillFraming('auto', FACE_BELOW * 2)).toBe('full')
    expect(stillFraming('full', 36)).toBe('full')
    expect(stillFraming('face', 512)).toBe('face')
  })
})

const req = (id: number, size: number, patch: Partial<LiveRequest> = {}): LiveRequest => ({ id, size, visible: true, priority: 0, since: id, ...patch })

describe('live-view budget (DS-71)', () => {
  it('keeps small and off-screen figures as stills', () => {
    const granted = allocateLive([req(1, LIVE_MIN_PX - 1), req(2, 200, { visible: false }), req(3, 200)], new Set())
    expect([...granted]).toEqual([3])
  })

  it('caps simultaneous contexts, preferring priority, then size', () => {
    const requests = Array.from({ length: LIVE_CAP + 3 }, (_, i) => req(i + 1, 120 + i))
    requests.push(req(99, 100, { priority: 5 }))
    const granted = allocateLive(requests, new Set())
    expect(granted.size).toBe(LIVE_CAP)
    expect(granted.has(99)).toBe(true)
    // The smallest equal-priority ones lose out.
    expect(granted.has(1)).toBe(false)
  })

  it('lets holders keep their slot against equal newcomers', () => {
    const requests = [req(1, 150), req(2, 150), req(3, 150)]
    const granted = allocateLive(requests, new Set([3]), 1)
    expect([...granted]).toEqual([3])
  })

  it('revokes before it grants, and never exceeds the cap as views come and go', () => {
    const log: string[] = []
    const budget = new LiveBudget(2, 96, (run) => run())
    const views = [1, 2, 3].map((n) => budget.register({ size: 120, visible: true, priority: 0 }, (live) => log.push(`${n}:${live}`)))
    expect(log).toEqual(['1:true', '2:true'])
    log.length = 0
    views[0]?.update({ visible: false })
    expect(log).toEqual(['1:false', '3:true'])
    log.length = 0
    views[1]?.release()
    views[0]?.update({ visible: true })
    expect(log).toEqual(['1:true'])
    expect([1, 2, 3].filter((_, i) => views[i] && budget.isLive(views[i]!.id)).length).toBeLessThanOrEqual(2)
  })

  it('the card, the new tab, two empty chats and welcome all fit', () => {
    const open = [req(1, 240, { priority: 2 }), req(2, 156, { priority: 1 }), req(3, 240), req(4, 150), req(5, 240, { priority: 2 })]
    expect(allocateLive(open, new Set()).size).toBe(5)
  })
})

describe('pats (DS-70)', () => {
  const stroke = (detector: PatDetector, from: number, strokes: number, t0: number, width = 30): boolean => {
    let landed = false
    let t = t0
    for (let s = 0; s < strokes; s++) {
      const dir = s % 2 === 0 ? 1 : -1
      for (let i = 1; i <= 6; i++) {
        t += 16
        if (detector.move(from + dir * (i / 6) * width + (dir < 0 ? width : 0), t)) landed = true
      }
    }
    return landed
  }

  it('needs a few back-and-forth strokes for the first pat', () => {
    const detector = new PatDetector()
    expect(stroke(detector, 100, 2, 0)).toBe(false)
    expect(stroke(detector, 100, 4, 100)).toBe(true)
  })

  it('makes follow-up pats easier for a few seconds', () => {
    const detector = new PatDetector()
    expect(stroke(detector, 100, 6, 0)).toBe(true)
    expect(stroke(detector, 100, 3, 1000)).toBe(true)
  })

  it('ignores jitter and a pointer that only passes over', () => {
    const detector = new PatDetector()
    let landed = false
    for (let i = 0; i < 60; i++) landed = detector.move(100 + (i % 2) * 3, i * 16) || landed
    for (let i = 0; i < 40; i++) landed = detector.move(100 + i * 4, 1000 + i * 16) || landed
    expect(landed).toBe(false)
  })

  it('starts over when the pointer leaves the head', () => {
    const detector = new PatDetector()
    stroke(detector, 100, 3, 0)
    detector.reset()
    expect(stroke(detector, 100, 2, 200)).toBe(false)
  })
})

describe('live cadence (DS-135)', () => {
  it('breathes about a pixel on a 1.5 s period, and not at all under Reduce Motion', () => {
    const samples = Array.from({ length: 60 }, (_, i) => bobPixels((i / 60) * BOB_PERIOD_S, false))
    expect(Math.max(...samples)).toBeGreaterThanOrEqual(0.5)
    expect(Math.max(...samples)).toBeLessThanOrEqual(1.5)
    expect(bobPixels(0.3, false)).toBeCloseTo(bobPixels(0.3 + BOB_PERIOD_S, false))
    expect(bobPixels(0.4, true)).toBe(0)
  })

  it('blinks every 3–5 s, sometimes twice about 400 ms apart', () => {
    const rng = seededRng(4)
    let doubles = 0
    for (let i = 0; i < 200; i++) {
      const blinks = idleBlinks(10, rng)
      expect(blinks[0]).toBeGreaterThanOrEqual(13)
      expect(blinks[0]).toBeLessThanOrEqual(15)
      if (blinks.length === 2) {
        doubles++
        expect((blinks[1] ?? 0) - (blinks[0] ?? 0)).toBeCloseTo(0.4)
      }
    }
    expect(doubles).toBeGreaterThan(10)
    expect(doubles).toBeLessThan(120)
  })

  it('text present: a quick blink, then a double blink about 1.8 s later; cleared: one blink about 2 s later', () => {
    expect(listenBlinks(5, true)).toEqual([5.05, 6.8, 7.2])
    expect(listenBlinks(5, false)).toEqual([7])
  })

  it('holds a sideways glance, mostly switching sides, for 4–8 s', () => {
    const rng = seededRng(9)
    let glance = nextGlance(null, rng)
    let switches = 0
    for (let i = 0; i < 50; i++) {
      expect(Math.abs(glance.gaze.x)).toBeGreaterThanOrEqual(0.25)
      expect(glance.holdFor).toBeGreaterThanOrEqual(4)
      expect(glance.holdFor).toBeLessThanOrEqual(8)
      const next = nextGlance(glance.gaze, rng)
      if (Math.sign(next.gaze.x) !== Math.sign(glance.gaze.x)) switches++
      glance = next
    }
    expect(switches).toBeGreaterThan(25)
  })

  it('swings the gaze in about 180 ms, and snaps under Reduce Motion', () => {
    let gaze = 0
    for (let t = 0; t < 0.18; t += 1 / 60) gaze += (1 - gaze) * gazeStep(1 / 60, false)
    expect(gaze).toBeGreaterThan(0.9)
    expect(gazeStep(1 / 60, true)).toBe(1)
  })
})
