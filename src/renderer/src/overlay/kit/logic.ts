/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure maths for the overlay kit's cascading menus (DS-94, SH-54): where a
// submenu card sits beside its row, the forgiving pointer path toward an open
// submenu, and what the arrow keys and Escape do at each level. No DOM, so
// it is unit-tested in node. Anchor placement reuses ui/logic/popover.ts.

export interface Point {
  x: number
  y: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** Submenus sit this far from their parent card's edge (DS-94: about 3 px). */
export const SUBMENU_GAP = 3
/** The card's padding, so a submenu's first row lines up with its parent row. */
export const CARD_PADDING = 5
/** Hover intent before a submenu opens or switches. */
export const HOVER_OPEN_MS = 90
/** While the pointer heads for an open submenu, switching waits this long. */
export const AIM_GRACE_MS = 300
/** Submenus longer than this get their own search row. */
export const SEARCH_THRESHOLD = 12

/**
 * A submenu card's top-left beside `row` (the parent row's box) in a
 * `viewport`: to the right of `parent` (the parent card) when it fits,
 * otherwise to the left, otherwise wherever has more room; clamped inside
 * the window either way.
 */
export function placeSubmenu(
  row: Box,
  parent: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  options: { gap?: number; margin?: number; prefer?: 'right' | 'left' } = {},
): { left: number; top: number; side: 'right' | 'left'; maxHeight: number } {
  const gap = options.gap ?? SUBMENU_GAP
  const margin = options.margin ?? 8
  const roomRight = viewport.width - margin - (parent.left + parent.width + gap)
  const roomLeft = parent.left - gap - margin
  const fitsRight = size.width <= roomRight
  const fitsLeft = size.width <= roomLeft
  const prefer = options.prefer ?? 'right'
  const side = prefer === 'right' ? (fitsRight || (!fitsLeft && roomRight >= roomLeft) ? 'right' : 'left') : fitsLeft || (!fitsRight && roomLeft >= roomRight) ? 'left' : 'right'
  const rawLeft = side === 'right' ? parent.left + parent.width + gap : parent.left - gap - size.width
  const left = Math.max(margin, Math.min(rawLeft, viewport.width - margin - size.width))
  const maxHeight = Math.max(0, viewport.height - margin * 2)
  const height = Math.min(size.height, maxHeight)
  const rawTop = row.top - CARD_PADDING
  const top = Math.max(margin, Math.min(rawTop, viewport.height - margin - height))
  return { left: Math.round(left), top: Math.round(top), side, maxHeight: Math.round(maxHeight) }
}

/** Twice the signed area of the triangle a, b, c. */
function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/**
 * The forgiving pointer path (SH-54): true while `p` lies in the triangle
 * from `origin` (where the pointer was when it left the parent row) to the
 * submenu's near edge, padded a little. Moving through it toward the
 * submenu keeps the submenu open even when the pointer crosses other rows.
 */
export function inSafeTriangle(p: Point, origin: Point, submenu: Box, side: 'right' | 'left', pad = 8): boolean {
  const edgeX = side === 'right' ? submenu.left : submenu.left + submenu.width
  const a = origin
  const b = { x: edgeX, y: submenu.top - pad }
  const c = { x: edgeX, y: submenu.top + submenu.height + pad }
  const d1 = cross(a, b, p)
  const d2 = cross(b, c, p)
  const d3 = cross(c, a, p)
  const negative = d1 < 0 || d2 < 0 || d3 < 0
  const positive = d1 > 0 || d2 > 0 || d3 > 0
  return !(negative && positive)
}

export type CascadeMove = 'open' | 'close-level' | 'dismiss' | null

/**
 * What a key does at a cascade level: Escape closes the innermost level
 * first, then the menu (SH-54, KB table); → opens the active row's submenu;
 * ← closes a nested level (it mirrors when that level opened to the left).
 */
export function cascadeKey(key: string, level: number, rowHasSubmenu: boolean, side: 'right' | 'left' = 'right'): CascadeMove {
  const into = side === 'right' ? 'ArrowRight' : 'ArrowLeft'
  const back = side === 'right' ? 'ArrowLeft' : 'ArrowRight'
  if (key === 'Escape') return level > 0 ? 'close-level' : 'dismiss'
  if (key === into && rowHasSubmenu) return 'open'
  if (key === back && level > 0) return 'close-level'
  return null
}

/** The union of several boxes (the overlay host sizes its view to every open card). */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((b) => b.left))
  const top = Math.min(...boxes.map((b) => b.top))
  const right = Math.max(...boxes.map((b) => b.left + b.width))
  const bottom = Math.max(...boxes.map((b) => b.top + b.height))
  return { left, top, width: right - left, height: bottom - top }
}

/** The open path after opening `index` at `level`: deeper levels close. */
export function openPath(path: readonly number[], level: number, index: number): number[] {
  return [...path.slice(0, level), index]
}

/** The open path after the innermost level closes. */
export function closeInnermost(path: readonly number[]): number[] {
  return path.slice(0, -1)
}
