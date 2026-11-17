/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Geometry shared by main's overlay host and the overlay renderers (
// OV-01): where a surface goes next to its anchor, the union the interactive
// view is sized to, and the stacking order. Everything is in chrome CSS px,
// relative to the window's content area, unless a name says otherwise.
import type { Rect, SurfaceAnchor, SurfacePolicy } from './overlay'

/**
 * 'top-center' and 'top-end' sit inside the anchor (a pane, say) along its
 * top edge; 'top-end' hugs the trailing corner, the way the find bar sits at
 * the pane's top right. 'center' and 'corner' sit in the window
 * itself: its middle, or its bottom trailing corner `gap` in from the edges
 * (what's new). The rest sit outside the anchor.
 */
export type Placement = 'below' | 'above' | 'left' | 'right' | 'center' | 'corner' | 'top-center' | 'top-end' | 'bottom-center'

/** Surfaces keep this far from the window edges. */
export const EDGE_MARGIN = 8

export const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 }

/**
 * An anchor as a window rect. Tab anchors are relative to the tab's pane;
 * a null rect means the whole pane. Returns null when the tab has no pane
 * (it is not showing), so the caller can hide the surface.
 */
export function resolveAnchorRect(anchor: SurfaceAnchor, paneOf: (tabId: string) => Rect | null): Rect | null {
  if (anchor.kind === 'window') return anchor.rect
  if (anchor.kind === 'point') return { x: anchor.x, y: anchor.y, width: 0, height: 0 }
  const pane = paneOf(anchor.tabId)
  if (!pane) return null
  if (!anchor.rect) return pane
  return { x: pane.x + anchor.rect.x, y: pane.y + anchor.rect.y, width: anchor.rect.width, height: anchor.rect.height }
}

function clamp(value: number, min: number, max: number): number {
  return max < min ? min : Math.min(Math.max(value, min), max)
}

/**
 * Places a surface of `size` next to `anchor`, inside `viewport`. 'below'
 * and 'above' centre on the anchor and flip when there is no room; every
 * placement is shifted to stay inside the window (DS-95).
 */
export function placeSurface(anchor: Rect, size: { width: number; height: number }, viewport: Rect, placement: Placement = 'below', gap = 6): Rect {
  const { width, height } = size
  const minX = viewport.x + EDGE_MARGIN
  const minY = viewport.y + EDGE_MARGIN
  const maxX = viewport.x + viewport.width - EDGE_MARGIN - width
  const maxY = viewport.y + viewport.height - EDGE_MARGIN - height
  const centreX = anchor.x + anchor.width / 2 - width / 2
  const centreY = anchor.y + anchor.height / 2 - height / 2
  let x: number
  let y: number
  switch (placement) {
    case 'center':
      x = viewport.x + (viewport.width - width) / 2
      y = viewport.y + (viewport.height - height) / 2
      break
    case 'corner':
      x = viewport.x + viewport.width - width - Math.max(gap, EDGE_MARGIN)
      y = viewport.y + viewport.height - height - Math.max(gap, EDGE_MARGIN)
      break
    case 'top-center':
      x = anchor.x + (anchor.width - width) / 2
      y = anchor.y + gap
      break
    case 'top-end':
      x = anchor.x + anchor.width - width - Math.max(gap, EDGE_MARGIN)
      y = anchor.y + gap
      break
    case 'bottom-center':
      x = anchor.x + (anchor.width - width) / 2
      y = anchor.y + anchor.height - height - gap
      break
    case 'left':
      x = anchor.x - gap - width
      if (x < minX && anchor.x + anchor.width + gap + width <= viewport.x + viewport.width - EDGE_MARGIN) x = anchor.x + anchor.width + gap
      y = centreY
      break
    case 'right':
      x = anchor.x + anchor.width + gap
      if (x > maxX && anchor.x - gap - width >= minX) x = anchor.x - gap - width
      y = centreY
      break
    case 'above':
      x = centreX
      y = anchor.y - gap - height
      if (y < minY && anchor.y + anchor.height + gap + height <= viewport.y + viewport.height - EDGE_MARGIN) y = anchor.y + anchor.height + gap
      break
    default:
      x = centreX
      y = anchor.y + anchor.height + gap
      if (y > maxY && anchor.y - gap - height >= minY) y = anchor.y - gap - height
  }
  return { x: Math.round(clamp(x, minX, maxX)), y: Math.round(clamp(y, minY, maxY)), width: Math.ceil(width), height: Math.ceil(height) }
}

/** The smallest rect holding every non-empty rect, or null when there are none. */
export function unionRect(rects: readonly (Rect | null | undefined)[]): Rect | null {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const r of rects) {
    if (!r || r.width <= 0 || r.height <= 0) continue
    left = Math.min(left, r.x)
    top = Math.min(top, r.y)
    right = Math.max(right, r.x + r.width)
    bottom = Math.max(bottom, r.y + r.height)
  }
  if (left === Infinity) return null
  return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - Math.floor(left)), height: Math.ceil(bottom - Math.floor(top)) }
}

/** Clips a rect to the viewport; null when nothing is left. */
export function clipRect(rect: Rect, viewport: Rect): Rect | null {
  const x = Math.max(rect.x, viewport.x)
  const y = Math.max(rect.y, viewport.y)
  const right = Math.min(rect.x + rect.width, viewport.x + viewport.width)
  const bottom = Math.min(rect.y + rect.height, viewport.y + viewport.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

/** Chrome CSS px to window px (the chrome may be zoomed). */
export function toWindowPx(rect: Rect, zoom: number): Rect {
  const z = zoom > 0 ? zoom : 1
  return { x: Math.round(rect.x * z), y: Math.round(rect.y * z), width: Math.round(rect.width * z), height: Math.round(rect.height * z) }
}

/** Window px back to chrome CSS px. */
export function toCssPx(rect: Rect, zoom: number): Rect {
  const z = zoom > 0 ? zoom : 1
  return { x: rect.x / z, y: rect.y / z, width: rect.width / z, height: rect.height / z }
}

const LAYER_RANK: Record<SurfacePolicy['layer'], number> = { hint: 1, menu: 2, modal: 3 }

/** Stacking (OV-02): modal over menus over hints; within a layer, the newer one on top. */
export function compareStacking(a: { layer: SurfacePolicy['layer']; seq: number }, b: { layer: SurfacePolicy['layer']; seq: number }): number {
  return LAYER_RANK[a.layer] - LAYER_RANK[b.layer] || a.seq - b.seq
}

/** The z-index a surface frame gets in its tier's renderer. */
export function zIndexFor(layer: SurfacePolicy['layer'], seq: number): number {
  return LAYER_RANK[layer] * 10_000 + (seq % 10_000)
}

/** How long an exit may run before the host removes the layer anyway (DS-82's safety timeout). */
export const EXIT_SAFETY_MS = 1000

/** The exit a surface plays: none under reduced motion, else its policy's. */
export function exitDuration(policy: Pick<SurfacePolicy, 'exitMs'>, reducedMotion: boolean): number {
  return reducedMotion ? 0 : Math.max(0, Math.min(policy.exitMs, 600))
}
