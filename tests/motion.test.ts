/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { PROFILE_HUES, PROFILE_HUE_IDS, CAPSULE_CONTRAST, GROUND, isProfileHue, profileTokens, profileVariables } from '../src/shared/profile'
import { contrastRatio, parseHex } from '../src/shared/accent'
import { MOTION, SPRING, resolveMotion, springAt, springDuration, springEasing, springPeak } from '../src/renderer/src/ui/logic/motion'
import { mergePresence, nextLayerState, nextPresenceChange, settlePresence, type PresenceEntry } from '../src/renderer/src/ui/logic/presence'
import { GLYPHS, VANISH, buildLattice, edgeMask, fieldColors, fieldPixelRatio, glyphScale, hash32, rippleAt, smoothstep, tideAt, TIDE, RIPPLE } from '../src/renderer/src/ui/logic/ambient'

function luminance(hex: string): number {
  const [r, g, b] = (parseHex(hex) ?? [0, 0, 0]).map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('motion tokens', () => {
  it('follows DS-81: card exits outlast entrances, menus pop in one frame and close at once', () => {
    expect(MOTION.exit).toBeGreaterThan(MOTION.enter)
    expect(MOTION.enter).toBeLessThanOrEqual(150)
    expect(MOTION.pop).toBeLessThanOrEqual(60)
    expect(MOTION.menuIn).toBeLessThanOrEqual(MOTION.pop)
    expect(MOTION.menuOut).toBe(0)
    expect(MOTION.quick).toBeLessThan(MOTION.layout)
    // One layout timeline of about 150 ms, whatever the distance.
    expect(MOTION.layout).toBeGreaterThanOrEqual(120)
    expect(MOTION.layout).toBeLessThanOrEqual(200)
    expect(MOTION.glide).toBeLessThanOrEqual(160)
    expect(MOTION.medium).toBeLessThan(MOTION.page)
  })

  it('resolves every token and the spring to instant when either switch is on', () => {
    for (const [system, app] of [[true, false], [false, true], [true, true]] as const) {
      const m = resolveMotion(system, app)
      expect(m.reduced).toBe(true)
      expect(Object.values(m.durations).every((v) => v === 0)).toBe(true)
      expect(springAt(0, m.spring)).toBe(1)
      expect(springDuration(m.spring)).toBe(0)
      expect(springEasing(m.spring)).toBe('linear')
    }
    const full = resolveMotion(false, false)
    expect(full.reduced).toBe(false)
    expect(full.durations).toEqual(MOTION)
    expect(full.spring).toEqual(SPRING)
  })

  it('springs from 0 to 1 with a slight overshoot, and settles', () => {
    expect(springAt(0)).toBe(0)
    const peak = springPeak()
    expect(peak).toBeGreaterThan(1.01)
    expect(peak).toBeLessThan(1.2)
    const end = springDuration()
    expect(end).toBeGreaterThan(0.2)
    expect(end).toBeLessThan(1.5)
    expect(Math.abs(springAt(end + 0.1) - 1)).toBeLessThan(0.003)
  })

  it('has no overshoot when critically damped', () => {
    const preset = { stiffness: 100, damping: 20, mass: 1 }
    for (let t = 0; t < 2; t += 0.01) expect(springAt(t, preset)).toBeLessThanOrEqual(1)
  })

  it('writes a CSS linear() easing that ends at 1', () => {
    const easing = springEasing()
    expect(easing.startsWith('linear(0, ')).toBe(true)
    expect(easing.endsWith(', 1)')).toBe(true)
  })
})

describe('row presence', () => {
  const key = (s: string): string => s
  const keys = (list: PresenceEntry<string>[]): string => list.map((e) => `${e.key}:${e.phase}`).join(' ')

  it('places the first list without animating', () => {
    expect(keys(mergePresence([], ['a', 'b'], key, 0, false))).toBe('a:idle b:idle')
  })

  it('enters new rows and keeps leaving rows where they were', () => {
    const shown = mergePresence([], ['a', 'b', 'c'], key, 0, false)
    const next = mergePresence(shown, ['a', 'c', 'd'], key, 10, true)
    expect(keys(next)).toBe('a:idle b:exit c:idle d:enter')
    // Merging the same list again changes nothing.
    expect(mergePresence(next, ['a', 'c', 'd'], key, 20, true)).toEqual(next)
  })

  it('keeps a leaving first row at the top', () => {
    const shown = mergePresence([], ['a', 'b'], key, 0, false)
    expect(keys(mergePresence(shown, ['b'], key, 5, true))).toBe('a:exit b:idle')
  })

  it('revives a row that comes back while leaving', () => {
    const shown = mergePresence(mergePresence([], ['a', 'b'], key, 0, false), ['a'], key, 5, true)
    expect(keys(mergePresence(shown, ['a', 'b'], key, 8, true))).toBe('a:idle b:idle')
  })

  it('drops leaving rows at once without animation', () => {
    const shown = mergePresence([], ['a', 'b'], key, 0, false)
    expect(keys(mergePresence(shown, ['b'], key, 5, false))).toBe('b:idle')
  })

  it('settles entrances and removes finished exits', () => {
    const shown = mergePresence(mergePresence([], ['a', 'b'], key, 0, false), ['a', 'c'], key, 100, true)
    expect(nextPresenceChange(shown, 150, 240, 160)).toBe(110)
    const mid = settlePresence(shown, 200, 240, 160)
    expect(mid).toBe(shown)
    const after = settlePresence(shown, 400, 240, 160)
    expect(keys(after)).toBe('a:idle c:idle')
    expect(nextPresenceChange(after, 400, 240, 160)).toBeNull()
  })

  it('keeps a layer mounted through its exit', () => {
    expect(nextLayerState('closed', true, 160)).toBe('open')
    expect(nextLayerState('open', false, 160)).toBe('closing')
    expect(nextLayerState('closing', true, 160)).toBe('open')
    expect(nextLayerState('open', false, 0)).toBe('closed')
    expect(nextLayerState('closed', false, 160)).toBe('closed')
  })
})

describe('ambient field', () => {
  it('builds a deterministic honeycomb lattice with bleed past the edges', () => {
    const a = buildLattice(200, 120, 22, 7)
    const b = buildLattice(200, 120, 22, 7)
    expect(a).toEqual(b)
    expect(Math.min(...a.map((c) => c.x))).toBeLessThan(0)
    expect(Math.max(...a.map((c) => c.x))).toBeGreaterThan(200)
    expect(Math.max(...a.map((c) => c.y))).toBeGreaterThan(120)
    // Odd rows are offset by half a pitch.
    const rowHeight = (22 * Math.sqrt(3)) / 2
    const row0 = a.filter((c) => Math.abs(c.y) < 0.01).map((c) => c.x)
    const row1 = a.filter((c) => Math.abs(c.y - rowHeight) < 0.01).map((c) => c.x)
    expect(row1[0]! - row0[0]!).toBeCloseTo(11)
    expect(buildLattice(0, 100)).toEqual([])
  })

  it('uses only Apex’s four glyphs, all of them', () => {
    const glyphs = new Set(buildLattice(400, 400).map((c) => c.glyph))
    expect([...glyphs].sort()).toEqual([...GLYPHS].sort())
    expect(buildLattice(400, 400, 22, 1)).not.toEqual(buildLattice(400, 400, 22, 2))
    expect(hash32(3, 4, 5)).toBe(hash32(3, 4, 5))
  })

  it('rolls the tide outward from the origin over time', () => {
    // A crest at distance 0 at t=0 sits one quarter-wavelength further out a quarter period later.
    expect(tideAt(0, 0)).toBe(1)
    expect(tideAt(TIDE.wavelength / 4, TIDE.period / 4)).toBeCloseTo(1)
    expect(tideAt(TIDE.wavelength / 2, 0)).toBe(0)
    for (let d = 0; d < 400; d += 13) {
      const v = tideAt(d, 1234)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  it('sends one ripple outward that fades', () => {
    const at = (RIPPLE.speed * 500) / 1000
    expect(rippleAt(at, 500)).toBeGreaterThan(rippleAt(at, 1500))
    expect(rippleAt(at, 500)).toBeGreaterThan(rippleAt(at + 200, 500))
    expect(rippleAt(at, RIPPLE.life)).toBe(0)
    expect(rippleAt(10, -1)).toBe(0)
  })

  it('lets calm cells vanish and caps the rest at full size', () => {
    expect(glyphScale(0, 0, 0.5)).toBe(0)
    expect(glyphScale(VANISH / 2, 0, 1)).toBe(0)
    expect(glyphScale(1, 1, 1)).toBe(1)
    expect(glyphScale(0, 0.6, 1)).toBeGreaterThan(0)
  })

  it('masks a top strip and washes out the bottom', () => {
    expect(edgeMask(0, 300, 40, 60)).toBe(0)
    expect(edgeMask(150, 300, 40, 60)).toBe(1)
    expect(edgeMask(300, 300, 40, 60)).toBe(0)
    expect(edgeMask(0, 300, 0, 0)).toBe(1)
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5)
  })

  it('draws darker glyphs than the wash in light mode and lighter ones in dark mode', () => {
    for (const tint of ['#6a4bff', '#e2468f', '#2e9b5a', '#d9890f', '#111111', '#f4f4f4']) {
      const light = fieldColors(tint, 'light')
      const dark = fieldColors(tint, 'dark')
      expect(luminance(light.glyph)).toBeLessThan(luminance(light.wash))
      expect(luminance(dark.glyph)).toBeGreaterThan(luminance(dark.wash))
    }
    expect(fieldColors('not a colour', 'light').glyph).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('caps the pixel density', () => {
    expect(fieldPixelRatio(3)).toBe(2)
    expect(fieldPixelRatio(1)).toBe(1)
    expect(fieldPixelRatio(Number.NaN)).toBe(1)
  })
})

describe('profile hues', () => {
  it('offers Apex’s nine hues with Stone first', () => {
    expect(PROFILE_HUE_IDS).toEqual(['stone', 'fig', 'moss', 'tide', 'clay', 'dusk', 'plum', 'sun', 'peony'])
    expect(PROFILE_HUES[0].label).toBe('Stone')
    expect(isProfileHue('moss')).toBe(true)
    expect(isProfileHue('lavender')).toBe(false)
  })

  it('keeps Stone the plain ground and washes the others lightly', () => {
    expect(profileTokens('stone', 'light').ground).toBe(GROUND.light)
    expect(profileTokens('stone', 'dark').ground).toBe(GROUND.dark)
    for (const id of PROFILE_HUE_IDS) {
      const light = profileTokens(id, 'light')
      const dark = profileTokens(id, 'dark')
      // The ground stays a pale tint in light mode and a deep slate in dark mode,
      // where it sits a step above the sheet (styles.css --bg-card), the darkest plane.
      expect(luminance(light.ground)).toBeGreaterThan(0.7)
      expect(luminance(dark.ground)).toBeLessThan(0.06)
      expect(luminance(dark.ground)).toBeGreaterThan(luminance('#222120'))
    }
  })

  it('keeps white capsule text readable in both modes', () => {
    for (const id of PROFILE_HUE_IDS) {
      for (const mode of ['light', 'dark'] as const) expect(contrastRatio('#ffffff', profileTokens(id, mode).hue)).toBeGreaterThanOrEqual(CAPSULE_CONTRAST)
    }
  })

  it('writes both modes as CSS variables', () => {
    expect(Object.keys(profileVariables('tide')).sort()).toEqual([
      '--profile-ground-dark', '--profile-ground-light', '--profile-hue-dark', '--profile-hue-light', '--profile-text-dark', '--profile-text-light',
    ])
    // Links, focus rings and the selected settings row read on every card surface (DS-03).
    for (const id of PROFILE_HUE_IDS) {
      expect(contrastRatio(profileTokens(id, 'light').text, '#ffffff')).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(profileTokens(id, 'dark').text, '#2b2a28')).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(profileTokens(id, 'dark').text, '#222120')).toBeGreaterThanOrEqual(4.5)
    }
  })
})
