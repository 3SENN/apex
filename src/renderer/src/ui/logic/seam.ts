/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure maths for the Seam divider. The sidebar, the side panel, the chats
// divider and split view all size things through it, in px or in
// other units such as rows.

export interface SeamRange {
  min: number
  max: number
}

export type SeamOrientation = 'vertical' | 'horizontal'

export function clampSeam(value: number, { min, max }: SeamRange): number {
  // A container smaller than the minimum still gets the minimum.
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

export interface SeamDrag extends SeamRange {
  /** The value when the drag started. */
  start: number
  /** Pointer travel since the drag started, along the seam's axis. */
  deltaPx: number
  /** Pixels per unit of value; 1 when the value is a size in px. */
  pixelsPerUnit?: number
  /** The sized element lies after the seam, so moving toward it shrinks it. */
  reverse?: boolean
  /** Round to multiples of this (1 for row counts). */
  snap?: number
}

export function seamDragValue(d: SeamDrag): number {
  const units = (d.reverse ? -d.deltaPx : d.deltaPx) / (d.pixelsPerUnit || 1)
  let value = d.start + units
  if (d.snap) value = Math.round(value / d.snap) * d.snap
  return clampSeam(value, d)
}

export interface SeamKeyOptions extends SeamRange {
  orientation: SeamOrientation
  reverse?: boolean
  step: number
  /** Shift+arrow and Page Up/Down. Defaults to four steps. */
  largeStep?: number
  shift?: boolean
}

/**
 * The value after a key press on a focused seam, or null when the key does
 * nothing. Arrows along the seam's axis move it the way they point; Home and
 * End jump to the minimum and maximum.
 */
export function seamKeyValue(key: string, value: number, o: SeamKeyOptions): number | null {
  const large = o.largeStep ?? o.step * 4
  const amount = o.shift ? large : o.step
  const [back, forward] = o.orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
  const grow = o.reverse ? -1 : 1
  let next: number
  if (key === forward) next = value + amount * grow
  else if (key === back) next = value - amount * grow
  else if (key === 'PageUp') next = value + large
  else if (key === 'PageDown') next = value - large
  else if (key === 'Home') next = o.min
  else if (key === 'End') next = o.max
  else return null
  return clampSeam(next, o)
}

/** The double-click target: a fixed default, or one picked from the current value. */
export function seamResetValue(current: number, resetTo: number | ((current: number) => number), range: SeamRange): number {
  return clampSeam(typeof resetTo === 'function' ? resetTo(current) : resetTo, range)
}

// SH-41: the split seam's haptic tick
/**
 * The snap points one drag step from `prev` to `next` crossed, in travel
 * order. Reaching a point counts and leaving one the seam rests on doesn't,
 * so a drag that parks on a point fires once, not again as it moves off.
 */
export function seamSnapCrossings(prev: number, next: number, points: readonly number[]): number[] {
  if (next === prev) return []
  const up = next > prev
  const crossed = points.filter((p) => (up ? prev < p && next >= p : prev > p && next <= p))
  return crossed.sort((a, b) => (up ? a - b : b - a))
}
