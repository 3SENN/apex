/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Base colours baked into the glTF materials. Tints are placeholders the
// runtime replaces from the profile; paints are final.

export const TINT_DEFAULTS = {
  skin: '#8f74f8',
  hair: '#4b3aa8',
  accent: '#c9bbff',
  outfit: '#6a4bff',
}

export const PAINTS = {
  white: '#fbf8ff',
  cream: '#fff1d6',
  ink: '#2d2442',
  boot: '#4a3d5e',
  gold: '#ffc84a',
  silver: '#cdd6e6',
  ruby: '#ff5c7a',
  sapphire: '#5ab4ff',
  emerald: '#4fd69c',
  petal: '#ff9cc6',
  petal2: '#ffd36e',
  petal3: '#b9a2ff',
  leaf: '#6cc77e',
  wood: '#c98d5d',
  paper: '#fffaf0',
  coffee: '#8a5a3c',
  foam: '#fff4e4',
  screen: '#9fe3ff',
  glass: '#dff4ff',
  balloon: '#ff6f91',
  string: '#e9e2f5',
  felt: '#5a4a86',
  star: '#ffe066',
}

/** '#rrggbb' (sRGB) to a linear RGBA factor for glTF. */
export function linearRgba(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const lin = v.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return [...lin.map((c) => Math.round(c * 1e5) / 1e5), 1]
}
