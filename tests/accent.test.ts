/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { accentTokens, accentVariables, contrastRatio, MIN_CONTRAST, parseHex, SURFACES } from '@shared/accent'

const SAMPLES = ['#c9bbff', '#6a4bff', '#ffe7a6', '#b7f1df', '#ffffff', '#000000', '#1d1630', '#ff0000', '#ffff00', '#00ffff', '#d3d9e4', '#808080']

function hue(hex: string): number {
  const [r, g, b] = (parseHex(hex) ?? [0, 0, 0]).map((c) => c / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return h * 60
}

describe('accent colour', () => {
  it('measures WCAG contrast', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21)
    expect(contrastRatio('#777777', '#777777')).toBe(1)
    expect(contrastRatio('#6a4bff', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#6a4bff'))
  })

  it('is readable on the surface and under its own text in both schemes', () => {
    for (const color of SAMPLES) {
      for (const scheme of ['light', 'dark'] as const) {
        const t = accentTokens(color, scheme)
        expect(contrastRatio(t.accent, SURFACES[scheme]), `${color} ${scheme}`).toBeGreaterThanOrEqual(MIN_CONTRAST)
        expect(contrastRatio(t.accent, t.text), `${color} ${scheme} text`).toBeGreaterThanOrEqual(MIN_CONTRAST)
        for (const value of Object.values(t)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  it('checks dark text on the neutral raised and card surfaces, not a purple-cast one (DS-136)', () => {
    expect(SURFACES.dark).toBe('#2b2a28')
    const presets = ['#c9bbff', '#ffe08a', '#ffd166', '#9be7ff', '#ffd447', '#f6c177']
    for (const color of [...SAMPLES, ...presets, '#6a4bff', '#3d9970', '#c45b87']) {
      const dark = accentTokens(color, 'dark').accent
      expect(contrastRatio(dark, '#2b2a28'), `${color} on raised`).toBeGreaterThanOrEqual(MIN_CONTRAST)
      expect(contrastRatio(dark, '#222120'), `${color} on card`).toBeGreaterThanOrEqual(MIN_CONTRAST)
    }
  })

  it('keeps the hue and leaves already readable light-mode colours alone', () => {
    expect(accentTokens('#6a4bff', 'light').accent).toBe('#6a4bff')
    expect(accentTokens('#1d1630', 'light').accent).toBe('#1d1630')
    for (const color of ['#c9bbff', '#ffe7a6', '#b7f1df', '#ff0000']) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(Math.abs(hue(accentTokens(color, scheme).accent) - hue(color)), `${color} ${scheme}`).toBeLessThan(4)
      }
    }
  })

  it('turns the default pastel accent into the familiar violet', () => {
    const light = accentTokens('#c9bbff', 'light')
    const dark = accentTokens('#c9bbff', 'dark')
    // Close to the original #6a4bff / #8c72ff accents.
    expect(contrastRatio(light.accent, '#6a4bff')).toBeLessThan(1.25)
    expect(contrastRatio(dark.accent, '#8c72ff')).toBeLessThan(1.25)
    expect(light.text).toBe('#ffffff')
    expect(light.soft).toMatch(/^#f/)
    expect(contrastRatio(dark.soft, SURFACES.dark)).toBeLessThan(1.6)
  })

  it('falls back for invalid input and emits variables for both schemes', () => {
    expect(accentTokens('violet', 'light').accent).toBe('#6a4bff')
    const vars = accentVariables('#62d6b3')
    expect(Object.keys(vars).sort()).toEqual([
      '--companion-accent-2-dark', '--companion-accent-2-light',
      '--companion-accent-3-dark', '--companion-accent-3-light',
      '--companion-accent-dark', '--companion-accent-light',
      '--companion-accent-soft-dark', '--companion-accent-soft-light',
      '--companion-accent-text-dark', '--companion-accent-text-light',
    ])
    expect(vars['--companion-accent-light']).toBe(accentTokens('#62d6b3', 'light').accent)
  })
})
