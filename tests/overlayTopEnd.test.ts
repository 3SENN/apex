/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EDGE_MARGIN, placeSurface } from '@shared/overlayLayout'

describe("overlay placement 'top-end' (find bar)", () => {
  const viewport = { x: 0, y: 0, width: 1200, height: 800 }
  const pane = { x: 240, y: 52, width: 900, height: 700 }

  it('hugs the top-right corner of the anchor', () => {
    const r = placeSurface(pane, { width: 360, height: 44 }, viewport, 'top-end', 8)
    expect(r).toEqual({ x: 240 + 900 - 360 - 8, y: 52 + 8, width: 360, height: 44 })
  })

  it('keeps clear of the window edge when the pane reaches it', () => {
    const r = placeSurface({ x: 0, y: 40, width: 1200, height: 760 }, { width: 360, height: 44 }, viewport, 'top-end', 4)
    expect(r.x + r.width).toBeLessThanOrEqual(viewport.width - EDGE_MARGIN)
  })

  it('stays inside a pane narrower than the bar', () => {
    const r = placeSurface({ x: 900, y: 52, width: 200, height: 600 }, { width: 360, height: 44 }, viewport, 'top-end', 8)
    expect(r.x).toBeGreaterThanOrEqual(EDGE_MARGIN)
    expect(r.x + r.width).toBeLessThanOrEqual(viewport.width - EDGE_MARGIN)
  })

  it('is where the find bar is placed', () => {
    const src = readFileSync('src/renderer/src/overlay/surfaces/address/index.ts', 'utf8')
    const findBar = src.slice(src.indexOf("const findBar"), src.indexOf("const zoomPopover"))
    expect(findBar).toContain("placement: 'top-end'")
  })
})
