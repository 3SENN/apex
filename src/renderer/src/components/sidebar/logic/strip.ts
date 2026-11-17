/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The horizontal strip's sizes (SH-21): pinned tabs are icons at the leading
// edge; the other tabs share the rest, shrinking from about 200 px to about
// 20 px, after which the strip scrolls and keeps the active tab in view: a
// jump when it is far away, a glide when it is near. Pure, so it is tested.

export const STRIP_TAB_MAX = 200
export const STRIP_TAB_MIN = 20
export const STRIP_PINNED = 40
export const STRIP_GAP = 3
export const STRIP_NEW_TAB = 32

export interface StripRoom {
  /** The tab area's width in px. */
  available: number
  /** Unpinned tabs shown (tabs of collapsed groups are not). */
  tabs: number
  pinned: number
  /** Width taken by group chips, in px. */
  chips?: number
}

/** Each unpinned tab's width. */
export function stripTabWidth({ available, tabs, pinned, chips = 0 }: StripRoom): number {
  if (tabs <= 0) return STRIP_TAB_MAX
  const fixed = pinned * (STRIP_PINNED + STRIP_GAP) + chips + STRIP_NEW_TAB + STRIP_GAP
  const each = Math.floor((available - fixed) / tabs - STRIP_GAP)
  return Math.max(STRIP_TAB_MIN, Math.min(STRIP_TAB_MAX, each))
}

/** Whether the tabs no longer fit at the floor, so the strip scrolls. */
export function stripOverflows(room: StripRoom): boolean {
  const { available, tabs, pinned, chips = 0 } = room
  return pinned * (STRIP_PINNED + STRIP_GAP) + chips + tabs * (STRIP_TAB_MIN + STRIP_GAP) + STRIP_NEW_TAB > available
}

/** What a tab of this width shows: title and close, the title alone, or the icon alone. */
export function stripDensity(width: number): 'full' | 'compact' | 'icon' {
  if (width >= 88) return 'full'
  if (width >= 44) return 'compact'
  return 'icon'
}

/** How far a jump counts as far: more than one and a half views away. */
export const FAR_VIEWS = 1.5

/**
 * Where to scroll so the active tab is in view, and how: null when it is
 * already fully visible; 'auto' (a jump) when it is far, 'smooth' when near.
 */
export function stripScroll(tab: { left: number; width: number }, view: { scrollLeft: number; width: number }, reduced = false): { left: number; behavior: 'auto' | 'smooth' } | null {
  const start = view.scrollLeft
  const end = start + view.width
  if (tab.left >= start && tab.left + tab.width <= end) return null
  const left = tab.left < start ? tab.left : tab.left + tab.width - view.width
  const far = Math.abs(left - start) > view.width * FAR_VIEWS
  return { left: Math.max(0, Math.round(left)), behavior: reduced || far ? 'auto' : 'smooth' }
}
