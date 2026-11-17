/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The ghost's look for a growth value (SH-30): the thumbnail fades in over
// the second half of the growth, and the corners round from a chip's to a
// card's. Over the pinned grid it morphs into a tile (DS-16). Pure, so it is
// tested.

export interface GhostLayout {
  /** 0 while it is a chip; 1 once it is a full card. */
  thumbOpacity: number
  radius: number
  /** The title fades out over the first half of the tile morph (DS-16). */
  titleOpacity: number
  /** Past halfway into a pinned tile: draw the favicon alone, centred. */
  tile: boolean
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0)
const round2 = (n: number): number => Math.round(n * 100) / 100

/** `tile` is the morph into a pinned tile over the pinned grid (0 none, 1 a full tile), which wins over the growth. */
export function ghostLayout(grow: number, tile = 0): GhostLayout {
  const g = clamp01(grow)
  const m = clamp01(tile)
  const thumb = Math.max(0, (g - 0.35) / 0.65) * (1 - m)
  // A pinned tile's corners are 12 px (--radius-md).
  const base = 10 + 4 * g
  const radius = Math.round(base + (12 - base) * m)
  return { thumbOpacity: round2(thumb), radius, titleOpacity: round2(Math.max(0, 1 - m * 2)), tile: m >= 0.5 }
}
