/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { edgeIndex, filterItems, intersects, placePopover, stepIndex, typeAhead } from '../src/renderer/src/ui/logic/popover'

const viewport = { width: 1470, height: 923 }

describe('popover placement (DS-94)', () => {
  it('opens under the anchor, lined up with its start, with the gap', () => {
    const at = placePopover({ left: 12, top: 300, width: 276, height: 34 }, { width: 272, height: 200 }, viewport, { gap: 4 })
    expect(at).toMatchObject({ left: 12, top: 338, side: 'below' })
  })

  it('right-aligns to the anchor when asked', () => {
    const at = placePopover({ left: 500, top: 100, width: 32, height: 32 }, { width: 240, height: 120 }, viewport, { align: 'end', gap: 4 })
    expect(at.left).toBe(500 + 32 - 240)
  })

  it('flips above when there is no room below, and clamps to the window', () => {
    const at = placePopover({ left: 1400, top: 860, width: 60, height: 40 }, { width: 236, height: 300 }, viewport)
    expect(at.side).toBe('above')
    expect(at.top + 300).toBeLessThanOrEqual(860)
    expect(at.left + 236).toBeLessThanOrEqual(viewport.width - 8)
  })

  it('opens above by preference (the footer menu) unless below has more room', () => {
    expect(placePopover({ left: 10, top: 860, width: 200, height: 40 }, { width: 236, height: 200 }, viewport, { side: 'above' }).side).toBe('above')
    expect(placePopover({ left: 10, top: 20, width: 200, height: 40 }, { width: 236, height: 200 }, viewport, { side: 'above' }).side).toBe('below')
  })

  it('caps the height to the room it has', () => {
    const at = placePopover({ left: 10, top: 600, width: 100, height: 30 }, { width: 200, height: 2000 }, viewport)
    expect(at.maxHeight).toBeLessThan(600)
  })

  it('tells when a popover reaches over the page area', () => {
    const page = { left: 300, top: 77, width: 1170, height: 846 }
    expect(intersects({ left: 12, top: 300, width: 272, height: 200 }, page)).toBe(false)
    expect(intersects({ left: 200, top: 300, width: 272, height: 200 }, page)).toBe(true)
  })
})

describe('menu keyboard', () => {
  const items = [
    { focusable: false, label: 'Companions' },
    { focusable: true, label: 'Pip' },
    { focusable: false, label: 'Juniper' },
    { focusable: true, label: 'Pepper' },
    { focusable: true, label: 'New companion…' },
  ]

  it('steps over headers and disabled rows, wrapping', () => {
    expect(stepIndex(items, 1, 1)).toBe(3)
    expect(stepIndex(items, 4, 1)).toBe(1)
    expect(stepIndex(items, 1, -1)).toBe(4)
    expect(stepIndex([], 0, 1)).toBe(-1)
  })

  it('jumps to the first and last focusable rows', () => {
    expect(edgeIndex(items, 'first')).toBe(1)
    expect(edgeIndex(items, 'last')).toBe(4)
  })

  it('types ahead to a label, cycling on a repeated letter', () => {
    expect(typeAhead(items, 1, 'p')).toBe(3)
    expect(typeAhead(items, 3, 'p')).toBe(1)
    expect(typeAhead(items, 1, 'pe')).toBe(3)
    expect(typeAhead(items, 1, 'pp')).toBe(3)
    expect(typeAhead(items, 1, 'zz')).toBe(-1)
  })

  it('filters on every word, ignoring case and accents', () => {
    const rows = [{ label: 'Résumé review' }, { label: 'Daily digest', keywords: 'news' }, { label: 'Weekly review' }]
    expect(filterItems(rows, 'resume').map((r) => r.label)).toEqual(['Résumé review'])
    expect(filterItems(rows, 'review weekly').map((r) => r.label)).toEqual(['Weekly review'])
    expect(filterItems(rows, 'news').map((r) => r.label)).toEqual(['Daily digest'])
    expect(filterItems(rows, '  ')).toHaveLength(3)
  })
})
