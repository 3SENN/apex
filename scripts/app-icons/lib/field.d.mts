/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Types for field.mjs, for the tests.

export type Glyph = 'plus' | 'ring' | 'capsule' | 'sparkle'
export interface LatticeCell {
  x: number
  y: number
  glyph: Glyph
  jitter: number
  angle: number
}
export interface TideOptions {
  wavelength: number
  period: number
  low: number
  high: number
}
export const GLYPHS: readonly Glyph[]
export const TIDE: Readonly<TideOptions>
export const STILL_AT_MS: number
export const VANISH: number
export const GLYPH_MAX: number
export function hash32(a: number, b: number, seed: number): number
export function buildLattice(width: number, height: number, pitch: number, seed?: number): LatticeCell[]
export function smoothstep(edge0: number, edge1: number, x: number): number
export function tideAt(distance: number, timeMs: number, opts?: TideOptions): number
export function glyphScale(tide: number, ripple: number, jitter: number): number
