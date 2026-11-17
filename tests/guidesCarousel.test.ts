/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { carouselLayout, categoryCounts, offsetFor, stepCarousel } from '../src/renderer/src/ui/logic/carousel'

// The Guides gallery's section carousels.

const base = { viewport: 848, card: 206, gap: 16 }

describe('carouselLayout', () => {
  it('starts at the left with a centre card in the middle slot', () => {
    const l = carouselLayout({ ...base, count: 8, offset: 0 })
    expect(l.pitch).toBe(222)
    expect(l.middleSlot).toBe(1)
    expect(l.centre).toBe(1)
    expect(l.translate).toBe(-0)
    expect(l.roles.slice(0, 5)).toEqual(['near', 'centre', 'near', 'edge', 'out'])
  })

  it('moves one pitch per step and stops when the last card is in the middle', () => {
    let l = carouselLayout({ ...base, count: 5, offset: 0 })
    expect(l.maxOffset).toBe(3)
    l = carouselLayout({ ...base, count: 5, offset: stepCarousel(l, 1) })
    expect(l.offset).toBe(1)
    expect(l.translate).toBe(-222)
    expect(l.centre).toBe(2)
    expect(l.roles[0]).toBe('out')
    l = carouselLayout({ ...base, count: 5, offset: 99 })
    expect(l.offset).toBe(3)
    expect(l.centre).toBe(4)
    expect(stepCarousel(l, 1)).toBe(3)
    expect(stepCarousel({ offset: 0, maxOffset: 2 }, -1)).toBe(0)
  })

  it('fades cards cut by an edge and marks hidden ones out of view', () => {
    const l = carouselLayout({ ...base, count: 8, offset: 2 })
    expect(l.roles[0]).toBe('out')
    expect(l.roles[1]).toBe('out')
    expect(l.roles[2]).toBe('near')
    expect(l.roles[3]).toBe('centre')
    expect(l.roles[4]).toBe('near')
    expect(l.roles[5]).toBe('edge')
    expect(l.roles[6]).toBe('out')
  })

  it('handles short and empty strips', () => {
    expect(carouselLayout({ ...base, count: 2, offset: 3 })).toMatchObject({ offset: 0, maxOffset: 0, centre: 1 })
    expect(carouselLayout({ ...base, count: 0, offset: 0 })).toMatchObject({ centre: -1, roles: [] })
    expect(carouselLayout({ ...base, viewport: 300, count: 4, offset: 0 }).middleSlot).toBe(0)
  })

  it('brings a focused card to the middle', () => {
    const l = carouselLayout({ ...base, count: 8, offset: 0 })
    expect(offsetFor(l, 6)).toBe(5)
    expect(offsetFor(l, 1)).toBe(0)
    expect(offsetFor(l, 7)).toBe(l.maxOffset)
  })
})

describe('categoryCounts', () => {
  it('counts every category that has items, after the all chip', () => {
    const items = [{ category: 'travel' }, { category: 'basics' }, { category: 'travel' }]
    expect(categoryCounts(['basics', 'research', 'travel'] as const, items)).toEqual([
      { id: 'all', count: 3 },
      { id: 'basics', count: 1 },
      { id: 'travel', count: 2 },
    ])
  })
})
