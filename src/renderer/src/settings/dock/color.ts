/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The custom colour pad's conversions: hex ↔ hue, saturation and value.

export interface Hsv {
  h: number
  s: number
  v: number
}

export function hexToHsv(hex: string): Hsv {
  const n = Number.parseInt(hex.replace('#', ''), 16)
  if (!/^#?[0-9a-f]{6}$/i.test(hex) || !Number.isFinite(n)) return { h: 0, s: 0, v: 1 }
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return `#${[r, g, b].map((ch) => Math.round((ch + m) * 255).toString(16).padStart(2, '0')).join('')}`
}

/** A typed hex, with or without #, as #rrggbb, or null. */
export function parseHex(input: string): string | null {
  const t = input.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(t)) return `#${t.split('').map((c) => c + c).join('').toLowerCase()}`
  return /^[0-9a-f]{6}$/i.test(t) ? `#${t.toLowerCase()}` : null
}
