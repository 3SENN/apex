/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { POPUP_MARGIN, type FillRow } from '@shared/autofill'
import type { Bounds } from '@shared/ipc'

// Where a fill popup goes (OV-25): below the field, flipped above when there
// is no room, and at least POPUP_MARGIN inside the tab. Pure, so the flip and
// clamp maths are unit-tested. Rects are tab-pane coordinates.

export interface Size {
  width: number
  height: number
}

export const POPUP_WIDTH = 300
const MIN_WIDTH = 200
const ROW_HEIGHT = 44
const FOOTER_HEIGHT = 36
const HEADER_HEIGHT = 30
const EMPTY_HEIGHT = 92
const PADDING = 8
const GAP = 4
const MAX_ROWS = 6

/** The fixed size a popup draws at for its rows (the surface uses the same numbers). */
export function popupSize(rows: readonly FillRow[], opts: { header?: boolean } = {}): Size {
  const items = rows.filter((r) => r.kind !== 'manage').length
  const footer = rows.some((r) => r.kind === 'manage') ? FOOTER_HEIGHT : 0
  const body = items === 0 ? EMPTY_HEIGHT : Math.min(items, MAX_ROWS) * ROW_HEIGHT
  return { width: POPUP_WIDTH, height: PADDING * 2 + body + footer + (opts.header ? HEADER_HEIGHT : 0) }
}

/** True while some of the field is inside the tab: a field scrolled away hides its popup. */
export function fieldVisible(field: Bounds, tab: Size): boolean {
  const midY = field.y + field.height / 2
  return field.width > 0 && field.height > 0 && midY >= 0 && midY <= tab.height && field.x + field.width > 0 && field.x < tab.width
}

/**
 * The popup's rect, or null when it can't show (the field is out of view or
 * the tab is too small). `flipped` is true when it sits above the field.
 */
export function placePopup(field: Bounds, size: Size, tab: Size, margin = POPUP_MARGIN): (Bounds & { flipped: boolean }) | null {
  if (!fieldVisible(field, tab)) return null
  const width = Math.min(size.width, tab.width - margin * 2)
  if (width < MIN_WIDTH) return null
  const x = Math.min(Math.max(field.x, margin), tab.width - margin - width)
  const below = field.y + field.height + GAP
  const roomBelow = tab.height - margin - below
  const roomAbove = field.y - GAP - margin
  const minHeight = Math.min(size.height, PADDING * 2 + ROW_HEIGHT)
  if (roomBelow >= size.height) return { x, y: below, width, height: size.height, flipped: false }
  if (roomAbove >= size.height) return { x, y: field.y - GAP - size.height, width, height: size.height, flipped: true }
  // Neither side fits whole: take the roomier one and let the list scroll.
  const flipped = roomAbove > roomBelow
  const height = Math.floor(Math.max(roomAbove, roomBelow))
  if (height < minHeight) return null
  return flipped ? { x, y: field.y - GAP - height, width, height, flipped } : { x, y: below, width, height, flipped }
}

export const CARD_WIDTH = 340
const CARD_INSET = 12

/** The save and hint cards sit at the tab's top right. */
export function placeCard(size: Size, tab: Size): Bounds {
  const width = Math.min(size.width, Math.max(0, tab.width - CARD_INSET * 2))
  return { x: Math.max(CARD_INSET, tab.width - CARD_INSET - width), y: CARD_INSET, width, height: size.height }
}

/** The cards' fixed heights by kind and field count. */
export function cardSize(kind: 'login' | 'card' | 'address' | 'hint', fields = 0): Size {
  if (kind === 'hint') return { width: CARD_WIDTH, height: 148 }
  if (kind === 'login') return { width: CARD_WIDTH, height: 250 }
  return { width: CARD_WIDTH, height: 132 + fields * 22 }
}

export function sameRect(a: Bounds | null, b: Bounds | null, tolerance = 0.5): boolean {
  if (!a || !b) return a === b
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance
}
