/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { TRAFFIC_HEIGHT, measureTrafficFrame, trafficPlacement } from '../src/renderer/src/components/sidebar/logic/traffic'

// DS-05: the window controls are centred on the 40 px header with their real
// frame, measured from the overlay strip Electron reports beside them and the
// margin main applied, instead of an assumed 16 px frame.

const HEADER = { left: 0, top: 0, width: 72, height: 40 }

describe('traffic-light frame', () => {
  it('derives the frame from the overlay strip and the applied margin', () => {
    // Margin 14, 12; a 16 px frame; three buttons spanning 52 px.
    const overlay = { x: 14 + 52 + 14, y: 0, width: 1360, height: 16 + 2 * 12 }
    expect(measureTrafficFrame(overlay, { x: 14, y: 12 })).toEqual({ height: 16, groupWidth: 52 })
  })

  it('reads a taller frame', () => {
    const overlay = { x: 14 + 60 + 14, y: 0, width: 1360, height: 20 + 2 * 12 }
    expect(measureTrafficFrame(overlay, { x: 14, y: 12 })).toEqual({ height: 20, groupWidth: 60 })
  })

  it('believes nothing without an overlay or margin, or with an implausible result', () => {
    expect(measureTrafficFrame(null, { x: 14, y: 12 })).toBeNull()
    expect(measureTrafficFrame({ x: 80, y: 0, width: 1360, height: 40 }, null)).toBeNull()
    // Full screen: an empty overlay.
    expect(measureTrafficFrame({ x: 0, y: 0, width: 0, height: 0 }, { x: 14, y: 12 })).toBeNull()
    // A custom overlay height (40) with a margin of 0 would read as a 40 px frame.
    expect(measureTrafficFrame({ x: 52, y: 0, width: 1360, height: 40 }, { x: 0, y: 0 })).toBeNull()
    expect(measureTrafficFrame({ x: Number.NaN, y: 0, width: 1360, height: 40 }, { x: 14, y: 12 })).toBeNull()
  })

  it('centres the measured frame on the header', () => {
    expect(trafficPlacement(HEADER)).toEqual({ visible: true, x: 14, y: 12 })
    expect(trafficPlacement(HEADER, TRAFFIC_HEIGHT)).toEqual({ visible: true, x: 14, y: 12 })
    expect(trafficPlacement(HEADER, 14)).toEqual({ visible: true, x: 14, y: 13 })
    expect(trafficPlacement(HEADER, 20)).toEqual({ visible: true, x: 14, y: 10 })
    expect(trafficPlacement(HEADER, Number.NaN)).toEqual({ visible: true, x: 14, y: 12 })
  })

  it('converges in one step: re-measuring after the move agrees', () => {
    // The real frame is 14 px. The first move uses the assumed 16 px frame.
    const first = trafficPlacement(HEADER)
    if (!first.visible) throw new Error('hidden')
    const frame = measureTrafficFrame({ x: first.x + 52 + first.x, y: 0, width: 1360, height: 14 + 2 * first.y }, first)
    expect(frame?.height).toBe(14)
    const second = trafficPlacement(HEADER, frame?.height)
    if (!second.visible) throw new Error('hidden')
    expect(second.y).toBe(13)
    const again = measureTrafficFrame({ x: second.x + 52 + second.x, y: 0, width: 1360, height: 14 + 2 * second.y }, second)
    expect(again?.height).toBe(14)
  })
})
