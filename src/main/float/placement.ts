/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Bounds } from '@shared/ipc'
import type { FloatAnchor, Placement } from '@shared/float'

// Where a floating window goes: inside one display's work area, anchored to
// the bottom centre, the bottom right or the right edge. Pure, so the maths
// is unit-tested; the manager feeds it the `screen` module's displays.

export interface DisplayLike {
  id: number
  workArea: Bounds
}

export interface Size {
  width: number
  height: number
}

/** Keeps a rect inside the work area, shrinking it when it is larger. */
export function clampToWorkArea(rect: Bounds, area: Bounds): Bounds {
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height)
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/** The rect for a float of `size` at `anchor` in `area`, `margin` DIP from the edges. */
export function anchorRect(size: Size, area: Bounds, anchor: FloatAnchor, margin: number): Bounds {
  const bottom = area.y + area.height - margin - size.height
  switch (anchor) {
    case 'bottom-center':
      return clampToWorkArea({ x: area.x + (area.width - size.width) / 2, y: bottom, ...size }, area)
    case 'bottom-right':
      return clampToWorkArea({ x: area.x + area.width - margin - size.width, y: bottom, ...size }, area)
    case 'right-edge':
      // A third of the way down, clear of the menu bar and the Dock.
      return clampToWorkArea({ x: area.x + area.width - margin - size.width, y: area.y + area.height / 3 - size.height / 2, ...size }, area)
  }
}

/** The display a float belongs on: the remembered one when it still exists, else the given one. */
export function pickDisplay(displays: readonly DisplayLike[], preferred: DisplayLike, remembered?: Placement['remembered']): DisplayLike {
  if (remembered) {
    const found = displays.find((d) => d.id === remembered.displayId)
    if (found) return found
  }
  return preferred
}

/** Places a float, honouring a remembered edge and height for the draggable widget. */
export function placeFloat(size: Size, display: DisplayLike, anchor: FloatAnchor, margin: number, remembered?: Placement['remembered']): Bounds {
  const area = display.workArea
  if (remembered && remembered.displayId === display.id) {
    const x = remembered.edge === 'left' ? area.x + margin : area.x + area.width - margin - size.width
    const y = area.y + remembered.yFraction * (area.height - size.height)
    return clampToWorkArea({ x, y, ...size }, area)
  }
  return anchorRect(size, area, anchor, margin)
}

/** Where a dragged widget now sits, to remember: its nearer edge and how far down (0..1). */
export function rememberPosition(rect: Bounds, display: DisplayLike): NonNullable<Placement['remembered']> {
  const area = display.workArea
  const centre = rect.x + rect.width / 2
  const edge = centre < area.x + area.width / 2 ? 'left' : 'right'
  const free = Math.max(1, area.height - rect.height)
  const yFraction = Math.min(1, Math.max(0, (rect.y - area.y) / free))
  return { displayId: display.id, edge, yFraction }
}

/** A requested size, kept between the kind's minimum (its base size) and maximum. */
export function clampSize(requested: Size, min: Size, max: Size): Size {
  const w = Number.isFinite(requested.width) ? requested.width : min.width
  const h = Number.isFinite(requested.height) ? requested.height : min.height
  return {
    width: Math.round(Math.min(max.width, Math.max(Math.min(min.width, max.width), w))),
    height: Math.round(Math.min(max.height, Math.max(32, h))),
  }
}
