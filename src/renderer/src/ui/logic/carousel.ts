/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A paging strip of cards (the Guides gallery's sections, and any
// other carousel page). The strip moves one card pitch per step; the card
// nearest the middle of the view is the centre card (drawn larger and raised),
// cards cut by an edge fade, and cards wholly outside are out of view.

export type CarouselRole = 'centre' | 'near' | 'edge' | 'out'

export interface CarouselInput {
  count: number
  /** The strip's visible width, px. */
  viewport: number
  /** One card's width and the gap between cards, px. */
  card: number
  gap: number
  /** How many cards the strip has moved left. */
  offset: number
}

export interface CarouselLayout {
  pitch: number
  /** The offset, kept within 0…maxOffset. */
  offset: number
  maxOffset: number
  /** The slot (from the left of the view) that holds the centre card. */
  middleSlot: number
  centre: number
  /** The strip's translateX, px. */
  translate: number
  roles: CarouselRole[]
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

export function carouselLayout({ count, viewport, card, gap, offset }: CarouselInput): CarouselLayout {
  const pitch = card + gap
  const middleSlot = pitch > 0 ? Math.max(0, Math.round((viewport / 2 - card / 2) / pitch)) : 0
  // The last card can reach the middle, and no further.
  const maxOffset = Math.max(0, count - 1 - middleSlot)
  const o = clamp(Math.round(offset), 0, maxOffset)
  const centre = count === 0 ? -1 : Math.min(count - 1, o + middleSlot)
  const roles = Array.from({ length: count }, (_, i): CarouselRole => {
    if (i === centre) return 'centre'
    const left = (i - o) * pitch
    const right = left + card
    if (right <= 0 || left >= viewport) return 'out'
    if (left < 0 || right > viewport) return 'edge'
    return 'near'
  })
  return { pitch, offset: o, maxOffset, middleSlot, centre, translate: -o * pitch, roles }
}

/** One press of the previous or next arrow. */
export function stepCarousel(layout: Pick<CarouselLayout, 'offset' | 'maxOffset'>, delta: -1 | 1): number {
  return clamp(layout.offset + delta, 0, layout.maxOffset)
}

/** The offset that brings card `index` to the middle (or as near as the ends allow), e.g. when it takes focus. */
export function offsetFor(layout: Pick<CarouselLayout, 'middleSlot' | 'maxOffset'>, index: number): number {
  return clamp(index - layout.middleSlot, 0, layout.maxOffset)
}

/** Category chips: every category that has guides, in catalogue order, with its count, after an "all" chip. */
export function categoryCounts<C extends string>(order: readonly C[], items: readonly { category: string }[]): { id: 'all' | C; count: number }[] {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  return [{ id: 'all' as const, count: items.length }, ...order.filter((c) => counts.has(c)).map((c) => ({ id: c, count: counts.get(c) ?? 0 }))]
}
