/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Split view maths (SH-41): the left pane's share of the content width, the
// seam's position in px, and when the panes are even. Pure, so it is tested.
import { SPLIT_EVEN, SPLIT_RATIO_MAX, SPLIT_RATIO_MIN } from '@shared/tabs'

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_EVEN
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio))
}

/** Even within half a percent counts as even (reset is disabled then). */
export function isEven(ratio: number): boolean {
  return Math.abs(ratio - SPLIT_EVEN) < 0.005
}

/** The left pane's width in px for a content width and the gap between the panes. */
export function leftWidth(contentWidth: number, gap: number, ratio: number): number {
  return Math.max(0, (contentWidth - gap) * clampRatio(ratio))
}

/** A seam position (the left pane's width in px) back to a ratio. */
export function ratioFromWidth(width: number, contentWidth: number, gap: number): number {
  const usable = contentWidth - gap
  if (usable <= 0) return SPLIT_EVEN
  return clampRatio(width / usable)
}

/** The seam's px range for a content width. */
export function seamRange(contentWidth: number, gap: number): { min: number; max: number } {
  const usable = Math.max(0, contentWidth - gap)
  return { min: usable * SPLIT_RATIO_MIN, max: usable * SPLIT_RATIO_MAX }
}

/** Where the seam's drag ticks (for the haptics, in ratio units): thirds and the even point. */
export const SPLIT_SNAP_POINTS: readonly number[] = [1 / 3, 0.5, 2 / 3]

/** The panes' flex shares for a ratio, as the CSS variables the content reads. */
export function splitVars(ratio: number | undefined): Record<'--split-left' | '--split-right', string> {
  const r = clampRatio(ratio ?? SPLIT_EVEN)
  return { '--split-left': String(r), '--split-right': String(1 - r) }
}

/** The empty pane's chooser: this window's tabs not already showing, most recently used first. */
export function chooserTabs<T extends { id: string; lastActiveAt: number }>(snapshot: { tabs: readonly T[]; split: { primaryId: string; secondaryId: string } | null }): T[] {
  const showing = new Set(snapshot.split ? [snapshot.split.primaryId, snapshot.split.secondaryId] : [])
  return snapshot.tabs.filter((t) => !showing.has(t.id)).sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

/** Which side a tab shows on while split, or null when it isn't showing. */
export function sideOf(split: { primaryId: string; secondaryId: string } | null, tabId: string | null): 'left' | 'right' | null {
  if (!split || !tabId) return null
  if (split.primaryId === tabId) return 'left'
  if (split.secondaryId === tabId) return 'right'
  return null
}
