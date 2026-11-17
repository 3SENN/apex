/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { POPUP_MARGIN, STILLNESS_MS, type FillRow } from '@shared/autofill'
import { CARD_WIDTH, POPUP_WIDTH, cardSize, fieldVisible, placeCard, placePopup, popupSize, sameRect } from '../src/main/autofill/placement'
import { StillnessGate } from '../src/main/autofill/stillness'
import { FOOTER_HEIGHT, HEADER_HEIGHT, POPUP_PADDING, ROW_HEIGHT, brandMark, pickOutcome, siteInitial, splitRows } from '@shared/overlay/autofill'

// Fill popup placement and the stillness rule (OV-25): below the field,
// flipped above when there's no room, 8 px inside the tab, hidden when the
// field is out of view; a pick counts only after 500 ms visible and still.

const tab = { width: 1000, height: 700 }
const rows = (n: number, manage = true): FillRow[] => [
  ...Array.from({ length: n }, (_, i) => ({ id: `l:${i}`, kind: 'login' as const, title: `user${i}` })),
  ...(manage ? [{ id: 'manage', kind: 'manage' as const, title: 'Manage passwords' }] : []),
]

describe('popupSize', () => {
  it('sizes rows, the footer and the cross-site header the way the surface draws them', () => {
    expect(popupSize(rows(2))).toEqual({ width: POPUP_WIDTH, height: POPUP_PADDING * 2 + 2 * ROW_HEIGHT + FOOTER_HEIGHT })
    expect(popupSize(rows(2), { header: true }).height).toBe(POPUP_PADDING * 2 + 2 * ROW_HEIGHT + FOOTER_HEIGHT + HEADER_HEIGHT)
    expect(popupSize(rows(2, false)).height).toBe(POPUP_PADDING * 2 + 2 * ROW_HEIGHT)
  })

  it('caps the list at six rows, and gives the empty state its own height', () => {
    expect(popupSize(rows(20)).height).toBe(popupSize(rows(6)).height)
    expect(popupSize(rows(0)).height).toBeGreaterThan(POPUP_PADDING * 2 + FOOTER_HEIGHT)
  })
})

describe('placePopup', () => {
  const size = popupSize(rows(3))

  it('opens below the field, aligned to its left edge', () => {
    const field = { x: 100, y: 100, width: 240, height: 32 }
    const rect = placePopup(field, size, tab)
    expect(rect).toMatchObject({ x: 100, y: 136, width: POPUP_WIDTH, height: size.height, flipped: false })
  })

  it('flips above when there is no room below', () => {
    const field = { x: 100, y: 600, width: 240, height: 32 }
    const rect = placePopup(field, size, tab)
    expect(rect?.flipped).toBe(true)
    expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBe(596)
  })

  it('stays at least 8 px inside the tab', () => {
    const right = placePopup({ x: 900, y: 100, width: 90, height: 30 }, size, tab)
    expect((right?.x ?? 0) + (right?.width ?? 0)).toBe(tab.width - POPUP_MARGIN)
    const left = placePopup({ x: -40, y: 100, width: 90, height: 30 }, size, tab)
    expect(left?.x).toBe(POPUP_MARGIN)
  })

  it('takes the roomier side and lets the list scroll when neither fits', () => {
    const short = { width: 600, height: 260 }
    const rect = placePopup({ x: 20, y: 60, width: 200, height: 30 }, popupSize(rows(6)), short)
    expect(rect?.flipped).toBe(false)
    expect((rect?.y ?? 0) + (rect?.height ?? 0)).toBeLessThanOrEqual(short.height - POPUP_MARGIN)
  })

  it('hides while the field is scrolled away, or the tab is too narrow', () => {
    expect(placePopup({ x: 100, y: -80, width: 200, height: 30 }, size, tab)).toBeNull()
    expect(placePopup({ x: 100, y: 800, width: 200, height: 30 }, size, tab)).toBeNull()
    expect(placePopup({ x: 10, y: 10, width: 100, height: 30 }, size, { width: 150, height: 600 })).toBeNull()
    expect(fieldVisible({ x: 0, y: 0, width: 0, height: 0 }, tab)).toBe(false)
  })
})

describe('placeCard', () => {
  it('puts save cards at the tab top right, 12 px in', () => {
    expect(placeCard(cardSize('login'), tab)).toEqual({ x: tab.width - 12 - CARD_WIDTH, y: 12, width: CARD_WIDTH, height: cardSize('login').height })
    expect(placeCard(cardSize('hint'), { width: 300, height: 400 }).width).toBe(276)
    expect(cardSize('address', 4).height).toBeGreaterThan(cardSize('address', 2).height)
  })
})

describe('StillnessGate', () => {
  const at = { x: 10, y: 10, width: 300, height: 120 }

  it('refuses picks before the popup has shown, and for 500 ms after', () => {
    const gate = new StillnessGate()
    expect(gate.ready(0)).toBe(false)
    gate.shown(at, 1000)
    expect(gate.ready(1000 + STILLNESS_MS - 1)).toBe(false)
    expect(gate.ready(1000 + STILLNESS_MS)).toBe(true)
  })

  it('restarts on a move or a resize, but not on the same rect again', () => {
    const gate = new StillnessGate()
    gate.shown(at, 0)
    gate.shown({ ...at }, 300)
    expect(gate.ready(STILLNESS_MS)).toBe(true)
    gate.shown({ ...at, y: 40 }, 600)
    expect(gate.ready(900)).toBe(false)
    expect(gate.ready(1100)).toBe(true)
    gate.shown({ ...at, y: 40, width: 280 }, 1200)
    expect(gate.ready(1500)).toBe(false)
    gate.moved(1600)
    expect(gate.ready(2000)).toBe(false)
    expect(gate.ready(2100)).toBe(true)
  })

  it('starts over after hiding', () => {
    const gate = new StillnessGate()
    gate.shown(at, 0)
    gate.hidden()
    expect(gate.ready(5000)).toBe(false)
    gate.moved(5000)
    expect(gate.ready(9000)).toBe(false)
  })

  it('compares rects within half a pixel', () => {
    expect(sameRect(at, { ...at, x: 10.3 })).toBe(true)
    expect(sameRect(at, { ...at, x: 11 })).toBe(false)
    expect(sameRect(null, at)).toBe(false)
  })
})

describe('popup surface helpers', () => {
  it('keeps the manage link out of the list, and hidden passkey rows out entirely', () => {
    const { items, manage } = splitRows([...rows(2), { id: 'p:1', kind: 'passkey', title: 'Passkey' }])
    expect(items.map((r) => r.id)).toEqual(['l:0', 'l:1'])
    expect(manage?.id).toBe('manage')
  })

  it('draws a brand mark, a site initial and the pick outcome', () => {
    expect(brandMark('visa')).toBe('VISA')
    expect(brandMark('unknown')).toBeNull()
    expect(siteInitial('www.example.com')).toBe('E')
    expect(siteInitial('')).toBe('•')
    expect(pickOutcome('gone')).toBe('close')
    expect(pickOutcome('auth-cancelled')).toBe('cancelled')
    expect(pickOutcome('too-soon')).toBe('stay')
  })
})
