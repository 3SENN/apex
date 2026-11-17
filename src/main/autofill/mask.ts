/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Bounds } from '@shared/ipc'
import type { Size } from './placement'

// Painting over guarded fields before a capture leaves main (ST-15).
// Pure over a raw bitmap so it is unit-tested; masker.ts does the capture.

/** The mask's fill: --bg-muted in each theme, so a masked field reads as an empty box, not a hole. */
export const MASK_FILL = { light: { r: 0xef, g: 0xed, b: 0xe9 }, dark: { r: 0x30, g: 0x2e, b: 0x2c } } as const
/** Around each field, so focus rings and borders can't hint at the length. */
export const MASK_PAD = 3
/** --radius-xs at 1x. */
export const MASK_RADIUS = 6

export interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * Paints opaque rounded boxes into a BGRA bitmap (Electron's NativeImage
 * order) in place. Rects are in bitmap pixels and are clamped to it.
 */
export function maskBitmap(bitmap: Uint8Array, size: Size, rects: readonly Bounds[], color: Rgb, radius = MASK_RADIUS): void {
  const { width, height } = size
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x))
    const y0 = Math.max(0, Math.floor(rect.y))
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width))
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height))
    if (x1 <= x0 || y1 <= y0) continue
    const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (r > 0 && outsideCorner(x + 0.5, y + 0.5, x0, y0, x1, y1, r)) continue
        const i = (y * width + x) * 4
        bitmap[i] = color.b
        bitmap[i + 1] = color.g
        bitmap[i + 2] = color.r
        bitmap[i + 3] = 255
      }
    }
  }
}

function outsideCorner(px: number, py: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  const cx = px < x0 + r ? x0 + r : px > x1 - r ? x1 - r : px
  const cy = py < y0 + r ? y0 + r : py > y1 - r ? y1 - r : py
  if (cx === px || cy === py) return false
  return (px - cx) ** 2 + (py - cy) ** 2 > r * r
}

/**
 * Maps guarded rects (DIP, relative to the captured area's origin) into a
 * bitmap of `pixels` that shows `area` (DIP). Used for full captures and the
 * agent's zoomed regions alike.
 */
export function rectsToPixels(rects: readonly Bounds[], area: Bounds, pixels: Size, pad = MASK_PAD): Bounds[] {
  if (area.width <= 0 || area.height <= 0) return []
  const kx = pixels.width / area.width
  const ky = pixels.height / area.height
  return rects.map((r) => ({
    x: (r.x - pad - area.x) * kx,
    y: (r.y - pad - area.y) * ky,
    width: (r.width + pad * 2) * kx,
    height: (r.height + pad * 2) * ky,
  }))
}
