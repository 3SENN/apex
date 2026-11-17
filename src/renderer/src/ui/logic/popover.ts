/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure maths for in-window popovers (DS-94): where a popover sits next to its
// anchor, clamped to the window, and how the keyboard moves through a menu
// list. No DOM, so it is unit-tested in node.

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface PlaceOptions {
  /** Gap between the anchor and the popover. */
  gap: number
  /** Which anchor edge the popover lines up with. */
  align: 'start' | 'end'
  /** Preferred side; flips when the other side has more room. */
  side: 'below' | 'above'
  /** Space kept free at the window's edges. */
  margin: number
}

export const PLACE_DEFAULTS: PlaceOptions = { gap: 4, align: 'start', side: 'below', margin: 8 }

/**
 * The popover's top-left for a `size` box next to `anchor` in a `viewport`.
 * It prefers `side`, flips when it would not fit there and the other side
 * has more room, and stays inside the viewport's margins either way.
 */
export function placePopover(anchor: Rect, size: { width: number; height: number }, viewport: { width: number; height: number }, options: Partial<PlaceOptions> = {}): { left: number; top: number; side: 'below' | 'above'; maxHeight: number } {
  const o = { ...PLACE_DEFAULTS, ...options }
  const below = viewport.height - o.margin - (anchor.top + anchor.height + o.gap)
  const above = anchor.top - o.gap - o.margin
  const side = o.side === 'below' ? (size.height <= below || below >= above ? 'below' : 'above') : size.height <= above || above >= below ? 'above' : 'below'
  const room = Math.max(0, side === 'below' ? below : above)
  const height = Math.min(size.height, room)
  const top = side === 'below' ? anchor.top + anchor.height + o.gap : anchor.top - o.gap - height
  const rawLeft = o.align === 'start' ? anchor.left : anchor.left + anchor.width - size.width
  const left = Math.max(o.margin, Math.min(rawLeft, viewport.width - o.margin - size.width))
  return { left: Math.round(left), top: Math.round(Math.max(o.margin, top)), side, maxHeight: Math.round(room) }
}

/** Whether two rectangles overlap (shared edges don't count). */
export function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height
}

export interface NavItem {
  /** Headers, separators and disabled rows are skipped by the keyboard. */
  focusable: boolean
  label: string
}

/** The next focusable index from `from` in `direction`, wrapping; -1 when none. */
export function stepIndex(items: readonly NavItem[], from: number, direction: 1 | -1): number {
  const n = items.length
  if (n === 0) return -1
  for (let i = 1; i <= n; i++) {
    const at = (((from + direction * i) % n) + n) % n
    if (items[at]?.focusable) return at
  }
  return -1
}

/** Home and End: the first or last focusable index; -1 when none. */
export function edgeIndex(items: readonly NavItem[], edge: 'first' | 'last'): number {
  if (edge === 'first') return items.findIndex((i) => i.focusable)
  for (let i = items.length - 1; i >= 0; i--) if (items[i]?.focusable) return i
  return -1
}

/**
 * Type-to-filter in a list without a search row: the next focusable item,
 * after the current one, whose label starts with the typed prefix (case and
 * accents ignored). Typing the same letter again cycles through matches.
 */
export function typeAhead(items: readonly NavItem[], from: number, prefix: string): number {
  const want = fold(prefix)
  if (!want) return -1
  const n = items.length
  const repeated = want.length > 1 && [...want].every((c) => c === want[0])
  const needle = repeated ? want[0]! : want
  const start = repeated || want.length === 1 ? 1 : 0
  for (let i = start; i < n + start; i++) {
    const at = (from + i + n) % n
    const item = items[at]
    if (item?.focusable && fold(item.label).startsWith(needle)) return at
  }
  return -1
}

/** Items whose label (or extra words) contain every word of `query`; empty keeps all. */
export function filterItems<T extends { label: string; keywords?: string }>(items: readonly T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...items]
  return items.filter((item) => {
    const hay = fold(`${item.label} ${item.keywords ?? ''}`)
    return words.every((w) => hay.includes(w))
  })
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}
