/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The "tide weave": Apex's ambient field. A honeycomb lattice of small glyphs
// (rounded plus, ring, short capsule, four-point sparkle) whose sizes swell
// in slow concentric waves from an origin (a companion's feet, or the stage
// centre). A poke or a finished task sends one extra ripple outward. Pure
// maths here; ui/AmbientField.tsx draws it.
import { parseHex, toHex } from '@shared/accent'

export const GLYPHS = ['plus', 'ring', 'capsule', 'sparkle'] as const
export type Glyph = (typeof GLYPHS)[number]

export const LATTICE_PITCH = 22

export interface LatticeCell {
  x: number
  y: number
  glyph: Glyph
  /** 0–1, fixed per cell, so neighbours never swell in lockstep. */
  jitter: number
  /** Capsules lean at one of a few fixed angles (radians). */
  angle: number
}

/** A small deterministic integer hash (no Math.random: the field is the same on every mount). */
export function hash32(a: number, b: number, seed: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

const CAPSULE_ANGLES = [Math.PI / 4, -Math.PI / 4, 0, Math.PI / 2]

/**
 * An offset (honeycomb) lattice that covers width × height plus one cell of
 * bleed on every side, so the field reads as wider than its container.
 */
export function buildLattice(width: number, height: number, pitch = LATTICE_PITCH, seed = 1): LatticeCell[] {
  if (width <= 0 || height <= 0 || pitch <= 0) return []
  const rowHeight = (pitch * Math.sqrt(3)) / 2
  const cells: LatticeCell[] = []
  const rows = Math.ceil(height / rowHeight) + 1
  const cols = Math.ceil(width / pitch) + 1
  for (let r = -1; r <= rows; r++) {
    const offset = r % 2 === 0 ? 0 : pitch / 2
    for (let c = -1; c <= cols; c++) {
      const h = hash32(c, r, seed)
      cells.push({
        x: c * pitch + offset,
        y: r * rowHeight,
        glyph: GLYPHS[h % GLYPHS.length]!,
        jitter: ((h >>> 8) & 0xffff) / 0xffff,
        angle: CAPSULE_ANGLES[(h >>> 4) % CAPSULE_ANGLES.length]!,
      })
    }
  }
  return cells
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export interface TideOptions {
  /** Distance between two swells, in px. */
  wavelength: number
  /** One swell passing a point, in ms. */
  period: number
  /** Below this the glyph vanishes (calm gaps)… */
  low: number
  /** …above this it is full size (dense bands). */
  high: number
}

export const TIDE: Readonly<TideOptions> = { wavelength: 190, period: 8000, low: 0.3, high: 0.82 }

/** The swell (0–1) at a distance from the origin at a time: concentric rings rolling outward. */
export function tideAt(distance: number, timeMs: number, opts: TideOptions = TIDE): number {
  const phase = distance / opts.wavelength - timeMs / opts.period
  const raw = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase)
  return smoothstep(opts.low, opts.high, raw)
}

export interface RippleOptions {
  /** px per second. */
  speed: number
  /** Thickness of the ring, px. */
  width: number
  /** How long until it has faded completely, ms. */
  life: number
}

export const RIPPLE: Readonly<RippleOptions> = { speed: 240, width: 46, life: 2400 }

/** One extra ring leaving the origin (a poke, a greeting, a finished task); 0 once it has faded. */
export function rippleAt(distance: number, ageMs: number, opts: RippleOptions = RIPPLE): number {
  if (ageMs < 0 || ageMs >= opts.life) return 0
  const front = (opts.speed * ageMs) / 1000
  const d = (distance - front) / opts.width
  const fade = 1 - ageMs / opts.life
  return fade * fade * Math.exp(-d * d)
}

/** Below this a glyph is not drawn at all. */
export const VANISH = 0.08

/** The size factor (0–1) a cell draws at. */
export function glyphScale(tide: number, ripple: number, jitter: number): number {
  const s = Math.min(1, tide + ripple * 0.75) * (0.82 + 0.18 * jitter)
  return s < VANISH ? 0 : Math.min(1, s)
}

/** How visible a row is: faded in from the top and washed out toward the bottom (px from each edge). */
export function edgeMask(y: number, height: number, fadeTop: number, fadeBottom: number): number {
  const top = fadeTop > 0 ? smoothstep(0, fadeTop, y) : 1
  const bottom = fadeBottom > 0 ? smoothstep(0, fadeBottom, height - y) : 1
  return Math.min(top, bottom)
}

/** A box (px, in the field's own box) with text sitting on the field, which the glyphs keep mostly clear of. */
export interface FieldClearing {
  left: number
  top: number
  right: number
  bottom: number
}

/** Shapes a field beyond its top and bottom fades (the new tab's ground). */
export interface FieldMask {
  /**
   * Fade out toward the ellipse inscribed in the box: full strength within
   * this fraction of its radii, gone at the rim, so there is no outline.
   */
  ellipse?: number
  /** Areas with text over the field; the glyphs dim to CLEARING.keep there. */
  clear?: readonly FieldClearing[]
}

export interface ClearingOptions {
  /** What is left of the glyphs inside a clearing. */
  keep: number
  /** The dimming starts this many px outside its edge… */
  reach: number
  /** …and is complete this many px inside. */
  inset: number
}

export const CLEARING: Readonly<ClearingOptions> = { keep: 0.22, reach: 32, inset: 8 }

/** A floor field (the new tab's ground) is at full strength within this fraction of its ellipse's radii. */
export const FLOOR_CORE = 0.42

/** How visible a point is inside a box's inscribed ellipse: 1 within `core` of the radii, easing to 0 at the rim and beyond. */
export function ellipseMask(x: number, y: number, width: number, height: number, core: number): number {
  if (width <= 0 || height <= 0) return 0
  const r = Math.hypot((x - width / 2) / (width / 2), (y - height / 2) / (height / 2))
  return 1 - smoothstep(Math.min(core, 0.99), 1, r)
}

/** Signed distance from a box's edge: negative inside, positive outside. */
function edgeDistance(x: number, y: number, z: FieldClearing): number {
  const dx = Math.max(z.left - x, 0, x - z.right)
  const dy = Math.max(z.top - y, 0, y - z.bottom)
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy)
  return -Math.min(x - z.left, z.right - x, y - z.top, z.bottom - y)
}

/** How visible a point is given the clearings: CLEARING.keep inside one, 1 a little way outside, eased between. */
export function clearingMask(x: number, y: number, zones: readonly FieldClearing[], opts: Readonly<ClearingOptions> = CLEARING): number {
  let visible = 1
  for (const zone of zones) {
    const t = smoothstep(-opts.inset, opts.reach, edgeDistance(x, y, zone))
    visible = Math.min(visible, opts.keep + (1 - opts.keep) * t)
  }
  return visible
}

/** The mask's strength at a point of a width × height field (1 without a mask). */
export function fieldMask(x: number, y: number, width: number, height: number, mask: FieldMask | undefined): number {
  if (!mask) return 1
  const shape = mask.ellipse === undefined ? 1 : ellipseMask(x, y, width, height, mask.ellipse)
  if (shape <= 0 || !mask.clear?.length) return shape
  return shape * clearingMask(x, y, mask.clear)
}

export interface FieldColors {
  /** The background a field owner can paint under the glyphs. */
  wash: string
  /** The glyph colour (#rrggbb); drawn at `alpha`. */
  glyph: string
  alpha: number
}

function mixHex(color: string, base: string, amount: number): string {
  const c = parseHex(color) ?? [0, 0, 0]
  const b = parseHex(base) ?? [0, 0, 0]
  return toHex([0, 1, 2].map((i) => b[i]! + (c[i]! - b[i]!) * amount) as [number, number, number])
}

/** The paper and charcoal the washes are mixed into (styles.css --bg-card). */
export const FIELD_SURFACES = { light: '#fdfcfa', dark: '#222120' } as const

/**
 * The field's colours. Light mode: glyphs are a deeper tint of the colour
 * than the wash, so they read darker than their ground. Dark mode: they glow
 * faintly lighter than the ground.
 */
export function fieldColors(tint: string, mode: 'light' | 'dark'): FieldColors {
  const color = parseHex(tint) ? tint : '#8c8378'
  if (mode === 'light') return { wash: mixHex(color, FIELD_SURFACES.light, 0.16), glyph: mixHex(color, '#000000', 0.86), alpha: 0.3 }
  return { wash: mixHex(color, FIELD_SURFACES.dark, 0.2), glyph: mixHex(color, '#ffffff', 0.55), alpha: 0.16 }
}

/** Canvas backing scale: sharp on retina, capped so a large field stays cheap. */
export function fieldPixelRatio(devicePixelRatio: number, cap = 2): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1
  return Math.min(cap, devicePixelRatio)
}
