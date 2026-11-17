/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chrome's accent follows the companion's accent colour. The picked
// colour can be anything from pastel to near black, so it is moved along
// lightness (hue and saturation kept) until it reads on the page surface.

export type ColorScheme = 'light' | 'dark'

export interface AccentTokens {
  /** Buttons, focus rings, links and selected states. */
  accent: string
  /** A lighter sibling for secondary highlights. */
  accent2: string
  /** The far end of the brand gradient. */
  accent3: string
  /** Tinted backgrounds behind accent text. */
  soft: string
  /** Text drawn on the accent. */
  text: string
}

type Rgb = [number, number, number]

/**
 * The surfaces accent text sits on, from styles.css's neutral ladder. Dark
 * text is checked on the raised step (--bg-raised), the lightest surface it
 * lands on, so it also reads on the card (--bg-card) below it.
 */
export const SURFACES: Record<ColorScheme, string> = { light: '#ffffff', dark: '#2b2a28' }
/** Apex ink (--text-primary in light mode), for text on pale accents. */
const INK = '#1c1a17'
const WHITE = '#ffffff'
/** WCAG AA for body text. */
export const MIN_CONTRAST = 4.5

export function parseHex(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match?.[1]) return null
  const n = Number.parseInt(match[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two '#rrggbb' colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(parseHex(a) ?? [0, 0, 0])
  const lb = luminance(parseHex(b) ?? [0, 0, 0])
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255]
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4
  return [h * 60, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360
  const lc = Math.min(1, Math.max(0, l))
  const a = s * Math.min(lc, 1 - lc)
  const f = (n: number): number => {
    const k = (n + hue / 30) % 12
    return 255 * (lc - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))
  }
  return toHex([f(0), f(8), f(4)])
}

function mix(color: string, base: string, amount: number): string {
  const c = parseHex(color) ?? [0, 0, 0]
  const b = parseHex(base) ?? [0, 0, 0]
  return toHex([0, 1, 2].map((i) => b[i]! + (c[i]! - b[i]!) * amount) as Rgb)
}

/**
 * The lightness nearest to the middle that still reaches MIN_CONTRAST on the
 * surface. Light mode keeps colours that already contrast (dark accents stay
 * dark); dark mode moves pastels down too, so filled buttons keep white text
 * legible, the way the default violet does.
 */
function readableLightness(h: number, s: number, l: number, scheme: ColorScheme): number {
  const surface = SURFACES[scheme]
  const ok = (lightness: number): boolean => contrastRatio(hslToHex(h, s, lightness), surface) >= MIN_CONTRAST
  if (scheme === 'light') {
    let lightness = l
    while (!ok(lightness) && lightness > 0) lightness = Math.max(0, lightness - 0.005)
    return lightness
  }
  let lightness = l
  if (ok(lightness)) {
    while (lightness > 0 && ok(lightness - 0.005)) lightness -= 0.005
  } else {
    while (!ok(lightness) && lightness < 1) lightness = Math.min(1, lightness + 0.005)
  }
  return lightness
}

/** Accent tokens for one colour scheme, readable on that scheme's surface. */
export function accentTokens(color: string, scheme: ColorScheme): AccentTokens {
  const rgb = parseHex(color) ?? [106, 75, 255]
  const [h, s, l] = rgbToHsl(rgb)
  const lightness = readableLightness(h, s, l, scheme)
  const accent = hslToHex(h, s, lightness)
  const text = contrastRatio(WHITE, accent) >= contrastRatio(INK, accent) ? WHITE : INK
  return {
    accent,
    accent2: hslToHex(h + 12, s, Math.min(0.82, lightness + 0.1)),
    accent3: hslToHex(h + 48, Math.max(s, 0.6), scheme === 'light' ? 0.74 : 0.7),
    soft: mix(accent, SURFACES[scheme], scheme === 'light' ? 0.11 : 0.18),
    text,
  }
}

/** CSS custom properties for both schemes; styles.css picks one per scheme. */
export function accentVariables(color: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const scheme of ['light', 'dark'] as const) {
    const t = accentTokens(color, scheme)
    vars[`--companion-accent-${scheme}`] = t.accent
    vars[`--companion-accent-2-${scheme}`] = t.accent2
    vars[`--companion-accent-3-${scheme}`] = t.accent3
    vars[`--companion-accent-soft-${scheme}`] = t.soft
    vars[`--companion-accent-text-${scheme}`] = t.text
  }
  return vars
}
