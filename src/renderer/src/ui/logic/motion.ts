/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Atelier's motion numbers and the spring, as pure data. styles.css mirrors the
// durations as --motion-* tokens; ui/motion.ts adds the live Reduce Motion
// switch. Everything resolves to instant when motion is reduced.

export interface MotionDurations {
  /** In-window menus, popovers and the palette: a fade of one frame at most. */
  pop: number
  /** Hover reveals, row closes, the focus ring, hover-card exits. */
  quick: number
  /** Cards, sheets and dialogs coming in, on the decelerate curve. */
  enter: number
  /** The same leaving: a little longer, on the accelerating curve (DS-81). */
  exit: number
  /** Rows, the card's underline and frames moving to a new place. */
  glide: number
  /** A drop or a hop coming to rest: about the spring's settling time (DS-81, ~600 ms). */
  settle: number
  /** The look editor widening; staged fades. */
  medium: number
  /** Carousel paging, ease-in-out. */
  page: number
  /** Kept for callers of the older names: menus open in `pop` and close at once. */
  menuIn: number
  menuOut: number
  /** Sidebar, side panel and split changes: chrome and page views on one timeline. */
  layout: number
  /** One swell of the ambient field. */
  swell: number
}

// Atelier's motion durations (design-spec.md, DS-81).
export const MOTION: Readonly<MotionDurations> = {
  pop: 60,
  quick: 90,
  enter: 140,
  exit: 180,
  glide: 150,
  settle: 600,
  medium: 250,
  page: 450,
  menuIn: 60,
  menuOut: 0,
  layout: 150,
  swell: 8000,
}

export interface SpringPreset {
  stiffness: number
  damping: number
  mass: number
}

/**
 * The one spring: a slight overshoot, for the floor's physics only (hops,
 * perching, landings). floorSim settles landings with it, and styles.css
 * carries it as --ease-floor (springEasing(SPRING)); everything else uses the
 * decelerate curve.
 */
export const SPRING: Readonly<SpringPreset> = { stiffness: 260, damping: 20, mass: 1 }

export interface ResolvedMotion {
  reduced: boolean
  durations: MotionDurations
  spring: SpringPreset
}

const INSTANT: MotionDurations = { pop: 0, quick: 0, enter: 0, exit: 0, glide: 0, settle: 0, medium: 0, page: 0, menuIn: 0, menuOut: 0, layout: 0, swell: 0 }
/** A spring that is already at rest: infinitely stiff and critically damped. */
const INSTANT_SPRING: SpringPreset = { stiffness: Number.POSITIVE_INFINITY, damping: Number.POSITIVE_INFINITY, mass: 1 }

/** Either the system's or Atelier's own Reduce Motion stills everything. */
export function resolveMotion(systemReduced: boolean, appReduced: boolean): ResolvedMotion {
  const reduced = systemReduced || appReduced
  return reduced ? { reduced, durations: { ...INSTANT }, spring: { ...INSTANT_SPRING } } : { reduced, durations: { ...MOTION }, spring: { ...SPRING } }
}

/**
 * Position of a spring released from 0 toward 1 after `t` seconds (closed
 * form, from rest). Under-damped springs overshoot past 1 and settle.
 */
export function springAt(t: number, preset: SpringPreset = SPRING): number {
  // The instant spring is already at rest.
  if (!Number.isFinite(preset.stiffness)) return 1
  if (t <= 0) return 0
  const { stiffness: k, damping: c, mass: m } = preset
  const w0 = Math.sqrt(k / m)
  const zeta = c / (2 * Math.sqrt(k * m))
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
  }
  // Critically (or over-) damped: no overshoot.
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t)
}

/** Seconds until the spring stays within `epsilon` of rest. */
export function springDuration(preset: SpringPreset = SPRING, epsilon = 0.002): number {
  if (!Number.isFinite(preset.stiffness)) return 0
  const step = 1 / 120
  let last = 0
  for (let t = step; t < 5; t += step) if (Math.abs(springAt(t, preset) - 1) > epsilon) last = t
  return Math.round((last + step) * 1000) / 1000
}

/** The largest value the spring reaches (1 means no overshoot). */
export function springPeak(preset: SpringPreset = SPRING): number {
  const end = springDuration(preset)
  let peak = 1
  for (let t = 0; t <= end; t += 1 / 240) peak = Math.max(peak, springAt(t, preset))
  return peak
}

/**
 * A CSS linear() easing that follows the spring, for transitions that should
 * overshoot like the JS spring does.
 */
export function springEasing(preset: SpringPreset = SPRING, points = 24): string {
  const end = springDuration(preset)
  if (end === 0) return 'linear'
  const stops: string[] = []
  for (let i = 0; i <= points; i++) stops.push((Math.round(springAt((end * i) / points, preset) * 1000) / 1000).toString())
  stops[stops.length - 1] = '1'
  return `linear(${stops.join(', ')})`
}
