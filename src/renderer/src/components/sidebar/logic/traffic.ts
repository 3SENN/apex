/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where the macOS window controls go, from the header slot's box. Pure, so
// the travel-and-hide rule is unit-tested; App reports the result to main.

/** How far the controls may travel past the window's left edge before they hide (they can't be drawn outside it). */
export const TRAFFIC_HIDE_PAST = 24
/** The first button sits this far into the slot: x 14, 37 and 60 at rest (DS-05). */
export const TRAFFIC_INSET = 14
/**
 * The frame height assumed until the real one is measured: 16 px (a 14 px
 * disc), which centred in the 40 px header puts the frames at y 12 (DS-05).
 * macOS draws its own buttons, so App measures the real frame
 * (measureTrafficFrame) and centres that instead.
 */
export const TRAFFIC_HEIGHT = 16

/** Bounds a measured frame must fall in to be believed; anything else keeps the assumed one. */
const FRAME_HEIGHT = { min: 10, max: 32 } as const
const FRAME_GROUP_WIDTH = { min: 36, max: 120 } as const

export type TrafficPlacement = { visible: false } | { visible: true; x: number; y: number }

/** The real button frame: each button's height and the three buttons' run from the first's left edge to the last's right edge. */
export interface TrafficFrame {
  height: number
  groupWidth: number
}

/**
 * The controls travel with the slot (the sidebar sliding away) and hide once
 * it has left the window, or when there is no slot at all. They are centred
 * on the slot's height with the frame height given (the measured one once
 * known).
 */
export function trafficPlacement(slot: { left: number; top: number; width: number; height: number } | null, frameHeight: number = TRAFFIC_HEIGHT): TrafficPlacement {
  if (!slot || slot.width <= 0 || slot.left <= -TRAFFIC_HIDE_PAST) return { visible: false }
  const frame = Number.isFinite(frameHeight) && frameHeight > 0 ? frameHeight : TRAFFIC_HEIGHT
  return {
    visible: true,
    x: Math.max(0, Math.round(slot.left + TRAFFIC_INSET)),
    y: Math.max(0, Math.round(slot.top + (slot.height - frame) / 2)),
  }
}

/**
 * DS-05: the real traffic-light frame, measured rather than assumed. With
 * the Window Controls Overlay on, Electron reports the strip beside the
 * buttons: it starts one margin past the last button's right edge and is as
 * tall as a button plus a margin above and below, where the margin is the
 * position main applied (getWindowButtonPosition, in CSS px). So
 *   height = overlay.height - 2 × margin.y
 *   groupWidth = overlay.x - 2 × margin.x
 * Null when there is no overlay or margin yet, or the result is implausible
 * (the overlay hidden, in full screen, or a custom overlay height).
 */
export function measureTrafficFrame(overlay: { x: number; y: number; width: number; height: number } | null, margin: { x: number; y: number } | null): TrafficFrame | null {
  if (!overlay || !margin) return null
  if (![overlay.x, overlay.height, overlay.width, margin.x, margin.y].every(Number.isFinite)) return null
  if (overlay.width <= 0 || overlay.height <= 0) return null
  const height = Math.round(overlay.height - 2 * margin.y)
  const groupWidth = Math.round(overlay.x - 2 * margin.x)
  if (height < FRAME_HEIGHT.min || height > FRAME_HEIGHT.max) return null
  if (groupWidth < FRAME_GROUP_WIDTH.min || groupWidth > FRAME_GROUP_WIDTH.max) return null
  return { height, groupWidth }
}
