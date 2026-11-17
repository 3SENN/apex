/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { contrastRatio } from '@shared/accent'
import { DEFAULT_LOOK, type CompanionLook } from '@shared/companion'
import { heroTint, primaryPillColors } from '../src/renderer/src/companion-card/logic/cardColors'
import { CARD_DEFAULT_SHARE, CARD_INSET, CARD_LOOK_WIDTH, CARD_MIN_WIDTH, CARD_PAGE_KEEP, cardFrame, countLabel, FIGURE_MARGIN, heroMetrics, shareForWidth, TAB_ROW, underlineFor } from '../src/renderer/src/companion-card/logic/cardLayout'
import { combineSaves, createSaveRegistry, parseDuration } from '../src/renderer/src/companion-card/logic/saves'

describe('card frame', () => {
  const region = { width: 1170, height: 846 }

  it('takes about half the content area, inset from its edges', () => {
    const f = cardFrame(region, { share: null, looking: false, mode: 'float' })
    expect(f.width).toBe(Math.round(1170 * CARD_DEFAULT_SHARE))
    expect([f.top, f.right, f.bottom]).toEqual([CARD_INSET.top, CARD_INSET.right, CARD_INSET.bottom])
    expect(f.min).toBe(CARD_MIN_WIDTH)
    expect(f.max).toBe(1170 - CARD_INSET.right - CARD_PAGE_KEEP)
  })

  it('remembers a share, clamped to what fits', () => {
    expect(cardFrame(region, { share: 0.7, looking: false, mode: 'float' }).width).toBe(819)
    expect(cardFrame(region, { share: 0.99, looking: false, mode: 'float' }).width).toBe(1170 - CARD_INSET.right - CARD_PAGE_KEEP)
    expect(cardFrame(region, { share: 0.1, looking: false, mode: 'float' }).width).toBe(CARD_MIN_WIDTH)
    expect(shareForWidth(585, 1170)).toBe(0.5)
    expect(shareForWidth(585, 0)).toBeNull()
  })

  it('widens for the look editor, within the room there is', () => {
    expect(cardFrame(region, { share: null, looking: true, mode: 'float' }).width).toBe(CARD_LOOK_WIDTH)
    // DS-43: it grows leftward by 292 px from whatever width it had (608 → 900 by default).
    expect(cardFrame(region, { share: 0.6, looking: true, mode: 'float' }).width).toBe(702 + 292)
    const small = cardFrame({ width: 700, height: 600 }, { share: null, looking: true, mode: 'float' })
    expect(small.width).toBe(small.max)
    expect(small.max).toBeLessThan(700)
  })

  it('still fits a region narrower than the minimum', () => {
    const f = cardFrame({ width: 400, height: 600 }, { share: null, looking: false, mode: 'float' })
    expect(f.width).toBeLessThanOrEqual(400 - CARD_INSET.right)
    expect(f.min).toBe(f.max)
  })

  it('fills a chat column', () => {
    expect(cardFrame({ width: 420, height: 800 }, { share: 0.3, looking: true, mode: 'column' })).toEqual({ mode: 'column', top: 0, right: 0, bottom: 0, width: 420, min: 420, max: 420 })
  })
})

describe('card hero', () => {
  it('keeps the design proportions at the design width', () => {
    const m = heroMetrics(607)
    expect(m.scale).toBe(1)
    expect(m.figureSize / FIGURE_MARGIN).toBeCloseTo(233, -1)
    expect(m.headY).toBe(62)
    // The feet land on the floor ellipse, which is drawn at feetY.
    expect(m.feetY).toBe(295)
    // The pattern band is gone about 40 px above the name row (DS-39).
    expect(m.fieldTop).toBe(40)
    expect(m.fieldTop + m.fieldHeight).toBeLessThanOrEqual(m.nameY - 18 - 40)
    expect(m.height).toBe(305)
    // The name row sits level with the shins, above the feet.
    expect(m.nameY).toBeGreaterThan(m.headY + 150)
    expect(m.nameY).toBeLessThan(m.feetY)
    // The figure's square centres on the figure.
    expect(m.figureTop + m.figureSize / 2).toBeCloseTo((m.headY + m.feetY) / 2, -1)
  })

  it('keeps the figure a fixed size on wider cards and shrinks it only in narrow columns', () => {
    // Fixed whatever the card width, as in the full tab (DS-40, DS-121); a narrow column shrinks it.
    expect(heroMetrics(900).figureSize).toBe(heroMetrics(607).figureSize)
    expect(heroMetrics(1170).height).toBe(heroMetrics(607).height)
    expect(heroMetrics(400).figureSize).toBeLessThan(heroMetrics(607).figureSize)
    expect(heroMetrics(3000).scale).toBe(heroMetrics(5000).scale)
    expect(heroMetrics(100).scale).toBe(heroMetrics(200).scale)
  })
})

describe('card tab row', () => {
  const widths = [52, 38, 60]

  it('puts the underline under the active tab, icon included, overhanging both sides', () => {
    expect(underlineFor(widths, 0)).toEqual({ left: TAB_ROW.start - TAB_ROW.overhang, width: 52 + TAB_ROW.iconBox + 2 * TAB_ROW.overhang })
    const second = underlineFor(widths, 2)!
    expect(second.left).toBe(TAB_ROW.start + 52 + TAB_ROW.gap + 38 + TAB_ROW.gap - TAB_ROW.overhang)
    expect(second.width).toBe(60 + TAB_ROW.iconBox + 2 * TAB_ROW.overhang)
  })

  it('has no underline without an active tab', () => {
    expect(underlineFor(widths, -1)).toBeNull()
    expect(underlineFor(widths, 3)).toBeNull()
  })

  it('counts in words', () => {
    expect(countLabel(null, 'skill', 'skills')).toBe('…')
    expect(countLabel(0, 'skill', 'skills')).toBe('0 skills')
    expect(countLabel(1, 'skill', 'skills')).toBe('1 skill')
    expect(countLabel(4, 'routine', 'routines')).toBe('4 routines')
  })
})

describe('card colours', () => {
  const look = (colors: Partial<CompanionLook['colors']>): CompanionLook => ({ ...DEFAULT_LOOK, colors: { ...DEFAULT_LOOK.colors, ...colors } })

  it('washes the hero in the head colour', () => {
    expect(heroTint(look({ skin: '#ffcc99' }))).toBe('#ffcc99')
  })

  it('fills the primary pill with the deepest look colour, dark enough for a white label', () => {
    const pale = primaryPillColors(look({ outfit: '#ffe8f0', hair: '#fff6cc' }))
    expect(contrastRatio('#ffffff', pale.rest)).toBeGreaterThanOrEqual(4.5)
    expect(pale.text).toBe('#ffffff')
    const deep = primaryPillColors(look({ outfit: '#1d2a6b', hair: '#f0e0a0' }))
    expect(deep.rest).toBe('#1d2a6b')
    // Hover and press go darker, so white reads even better on them.
    expect(contrastRatio('#ffffff', deep.hover)).toBeGreaterThan(contrastRatio('#ffffff', deep.rest))
    expect(contrastRatio('#ffffff', deep.press)).toBeGreaterThan(contrastRatio('#ffffff', deep.hover))
    expect(primaryPillColors(look({ outfit: '#2a6b1d', hair: '#10204a' })).rest).toBe('#10204a')
  })
})

describe('card saves', () => {
  it('shows the most urgent state', () => {
    expect(combineSaves([])).toBe('idle')
    expect(combineSaves(['idle', 'saved'])).toBe('saved')
    expect(combineSaves(['saved', 'saving'])).toBe('saving')
    expect(combineSaves(['saving', 'error', 'saved'])).toBe('error')
  })

  it('collects fields, retries failed ones and carries a busy label', () => {
    const registry = createSaveRegistry()
    let changes = 0
    registry.subscribe(() => changes++)
    let retried = 0
    registry.report('name', { state: 'saving' })
    registry.report('notes', { state: 'error', retry: () => retried++ })
    expect(registry.summary().state).toBe('error')
    registry.summary().retry?.()
    expect(retried).toBe(1)
    // A fresh callback with the same state changes nothing on screen.
    const before = changes
    registry.report('notes', { state: 'error', retry: () => retried++ })
    expect(changes).toBe(before)
    registry.report('notes', null)
    expect(registry.summary()).toMatchObject({ state: 'saving', retry: null })
    registry.setBusy('Duplicating…')
    expect(registry.summary().busy).toBe('Duplicating…')
  })

  it('flushes every field, and gives up on a stuck one', async () => {
    const registry = createSaveRegistry()
    let flushed = 0
    registry.report('a', { state: 'idle', flush: async () => void flushed++ })
    registry.report('b', { state: 'idle', flush: () => new Promise(() => undefined) })
    await registry.flushAll(20)
    expect(flushed).toBe(1)
  })

  it('reads CSS times', () => {
    expect(parseDuration('240ms')).toBe(240)
    expect(parseDuration(' 0.16s ')).toBe(160)
    expect(parseDuration('0s')).toBe(0)
    expect(parseDuration('')).toBeNull()
    expect(parseDuration('fast')).toBeNull()
  })
})
