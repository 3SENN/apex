/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TINTS, type Tint } from '@shared/companion'
import { hexToRgb, weightedPick, type Rng } from '@shared/companionLogic'
import { t } from '@shared/i18n/core'

// Shuffle with a leaning: the palettes from randomization-config are
// re-weighted by how well their four colours fit a style, so "Soft" mostly
// rolls pale, gentle palettes without ruling the others out.

export const SHUFFLE_STYLES = [
  { id: 'any', get label() { return t('coCard.shuffle.any') } },
  { id: 'soft', get label() { return t('coCard.shuffle.soft') } },
  { id: 'bright', get label() { return t('coCard.shuffle.bright') } },
  { id: 'bold', get label() { return t('coCard.shuffle.bold') } },
] as const

export type ShuffleStyle = (typeof SHUFFLE_STYLES)[number]['id']

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h /= 6
  return { h, s, l }
}

/** How well a palette fits a style, from 0 (not at all) to 1. 'any' fits everything equally. */
export function paletteScore(colors: Record<Tint, string>, style: ShuffleStyle): number {
  if (style === 'any') return 1
  const hsl = TINTS.map((t) => hexToHsl(colors[t]))
  const sat = hsl.reduce((sum, c) => sum + c.s, 0) / hsl.length
  const light = hsl.reduce((sum, c) => sum + c.l, 0) / hsl.length
  const spread = Math.max(...hsl.map((c) => c.l)) - Math.min(...hsl.map((c) => c.l))
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  if (style === 'soft') return clamp((1 - sat) * 0.45 + light * 0.55)
  if (style === 'bright') return clamp(sat * 0.7 + (1 - Math.abs(light - 0.55) * 2) * 0.3)
  return clamp(spread * 0.6 + sat * 0.2 + (1 - light) * 0.2)
}

/** The palettes with weights tilted towards `style`; every palette keeps a small chance. */
export function biasPalettes<P extends { weight: number; colors: Record<Tint, string> }>(palettes: readonly P[], style: ShuffleStyle): P[] {
  if (style === 'any') return [...palettes]
  return palettes.map((p) => ({ ...p, weight: p.weight * (0.02 + paletteScore(p.colors, style) ** 3) }))
}

/** A palette for `style`, or undefined when there are none. */
export function pickPalette<P extends { weight: number; colors: Record<Tint, string> }>(palettes: readonly P[], style: ShuffleStyle, rng: Rng): P | undefined {
  return weightedPick(biasPalettes(palettes, style), rng)
}
