/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { SETUP_STEPS } from '@shared/onboarding'
import { LAYOUT_SIZES, layoutPages } from '../src/main/smokeLayout/pages'
import { BODY_HALF, BODY_W, ORBIT_MAX, PAD_X, SAY_H, SIDE_GAP, cardRoom, orbit, stageHeight, welcomeSlot, type WelcomeSlot } from '../src/renderer/src/pages/welcome/stage'

// The setup flow's one step template (DS-78). The companion and its bubble
// have their own slot, the illustration's tiles stay inside it and clear of
// the figure, and the content card always keeps room on the page.

/** The page sizes the flow meets: the audit's windows (less the toolbar), with a sidebar and with the chat panel. */
const PAGES: Array<{ width: number; height: number }> = LAYOUT_SIZES.flatMap((s) => {
  const height = s.height - 80
  const width = s.width - (s.panel ? 400 : 0)
  return [
    { width, height },
    { width: width - 240, height },
  ]
})

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('the welcome slot', () => {
  it('is a column beside the step on wide pages and sits above the title otherwise', () => {
    expect(welcomeSlot(1920, 1000).mode).toBe('side')
    expect(welcomeSlot(1280, 720).mode).toBe('side')
    expect(welcomeSlot(1040, 720).mode).toBe('top')
    expect(welcomeSlot(900, 620).mode).toBe('top')
    // Wide but short: the column would squeeze the scene, so the slot goes on top.
    expect(welcomeSlot(1400, 560).mode).toBe('top')
    expect(welcomeSlot(Number.NaN, -1)).toEqual(welcomeSlot(1280, 800))
  })

  it('fits the page at every width from 900 to 1920, beside or above the step', () => {
    for (const page of PAGES) {
      const slot = welcomeSlot(page.width, page.height)
      if (slot.mode === 'side') {
        // The column and the step share the width without squeezing the step.
        expect(slot.sceneW + SIDE_GAP + BODY_W - 40).toBeLessThanOrEqual(page.width - 2 * PAD_X)
        expect(stageHeight(slot)).toBeLessThanOrEqual(page.height - 52 - 36)
      } else expect(slot.sceneW).toBeLessThanOrEqual(page.width - 2 * PAD_X)
      expect(slot.figure).toBeLessThanOrEqual(slot.sceneH)
      expect(slot.figure).toBeLessThanOrEqual(slot.sceneW)
    }
  })

  it('reserves the bubble its own row above the figure', () => {
    for (const page of PAGES) expect(stageHeight(welcomeSlot(page.width, page.height))).toBe(SAY_H + welcomeSlot(page.width, page.height).sceneH)
  })

  it('always leaves the content card room to show itself (it scrolls beyond that)', () => {
    // A two-line title and a three-line subtitle (Dutch runs long), and a wrapped row of actions.
    const head = 36 * 2 + 8 + 22 * 3
    const actions = 40
    for (const page of PAGES) expect(cardRoom(welcomeSlot(page.width, page.height), page.height, head, actions)).toBeGreaterThanOrEqual(90)
    // The common case keeps a real card: one-line title, two-line subtitle.
    expect(cardRoom(welcomeSlot(820, 620), 620, 36 + 8 + 44, 40)).toBeGreaterThanOrEqual(160)
    expect(cardRoom(welcomeSlot(1280, 720), 720, 36 + 8 + 44, 40)).toBeGreaterThanOrEqual(400)
  })
})

describe('the illustration orbit', () => {
  const slots: WelcomeSlot[] = PAGES.map((p) => welcomeSlot(p.width, p.height))

  it('alternates left and right and never shows more than six tiles', () => {
    const slot = welcomeSlot(1280, 720)
    expect(orbit(0, slot).points).toEqual([])
    expect(orbit(9, slot).points).toHaveLength(ORBIT_MAX)
    expect(orbit(5, slot).points.map((p) => p.side)).toEqual(['left', 'right', 'left', 'right', 'left'])
    expect(orbit(Number.NaN, slot).points).toEqual([])
  })

  it('keeps every tile inside the scene, clear of the figure and of each other', () => {
    for (const slot of slots) {
      for (let n = 1; n <= ORBIT_MAX; n++) {
        const { points, hub } = orbit(n, slot)
        expect(points).toHaveLength(n)
        const half = slot.tile / 2
        const body = { x: slot.sceneW / 2 - slot.figure * BODY_HALF, y: 0, w: slot.figure * BODY_HALF * 2, h: slot.sceneH }
        const boxes = points.map((p) => ({ x: p.x - half, y: p.y - half, w: slot.tile, h: slot.tile }))
        for (const [i, b] of boxes.entries()) {
          expect(b.x).toBeGreaterThanOrEqual(0)
          expect(b.y).toBeGreaterThanOrEqual(0)
          expect(b.x + b.w).toBeLessThanOrEqual(slot.sceneW)
          expect(b.y + b.h).toBeLessThanOrEqual(slot.sceneH)
          expect(overlaps(b, body)).toBe(false)
          for (const other of boxes.slice(i + 1)) expect(overlaps(b, other)).toBe(false)
          // A name tag's room never reaches past the scene's edge or into the figure.
          const p = points[i]!
          expect(p.room).toBeGreaterThanOrEqual(Math.floor(half))
          if (p.room > half) {
            expect(p.x - p.room).toBeGreaterThanOrEqual(p.side === 'left' ? 0 : body.x + body.w)
            expect(p.x + p.room).toBeLessThanOrEqual(p.side === 'left' ? body.x : slot.sceneW)
          }
        }
        expect(hub.x).toBe(slot.sceneW / 2)
        expect(hub.y).toBeGreaterThan(0)
        expect(hub.y).toBeLessThan(slot.sceneH)
      }
    }
  })

  it('mirrors the two sides', () => {
    const { points } = orbit(4, welcomeSlot(1040, 720))
    expect(points[0]!.y).toBe(points[1]!.y)
    expect(points[2]!.y).toBe(points[3]!.y)
    expect(Math.round(points[0]!.x + points[1]!.x)).toBe(Math.round(welcomeSlot(1040, 720).sceneW))
  })

  it('shows no tiles when the scene is too narrow to keep them clear', () => {
    expect(orbit(4, { sceneW: 140, sceneH: 140, figure: 140, tile: 40 }).points).toEqual([])
  })
})

describe('the layout audit covers the setup flow', () => {
  it('opens atelier://welcome at every setup step', () => {
    const pages = layoutPages({ chatId: null, companionId: null, fileUrl: null, sourceUrl: null })
    const welcome = pages.filter((p) => p.welcomeStep)
    expect(welcome.map((p) => p.welcomeStep)).toEqual([...SETUP_STEPS])
    for (const p of welcome) {
      expect(p.url).toBe('atelier://welcome')
      expect(p.name).toBe(`welcome-${p.welcomeStep}`)
    }
    expect(pages.some((p) => p.name === 'welcome')).toBe(false)
  })
})
