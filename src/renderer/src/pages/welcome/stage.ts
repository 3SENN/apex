/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The setup flow's one step template (DS-78): the progress bar, then the
// companion's own slot (its speech bubble above it, its illustration around
// it), then the title, subtitle, content card and actions. At wide pages
// the slot becomes a column beside the step. Everything sits in its own
// box in the page's flow, so the companion and its bubble can never cover
// the words. Pure maths here; WelcomeFlow measures the page and sets the
// numbers as CSS variables, welcome.css lays the boxes out from them.

/** 'side': the slot is a column left of the step; 'top': it sits above the title. */
export type WelcomeSlotMode = 'side' | 'top'

export interface WelcomeSlot {
  mode: WelcomeSlotMode
  /** The scene box (the figure and its illustration), CSS px. */
  sceneW: number
  sceneH: number
  /** The figure's square box, standing at the bottom centre of the scene. */
  figure: number
  /** One illustration tile (square). */
  tile: number
}

/** The progress dots and menu above the template. */
export const BAR_H = 52
/** The bubble's own row above the figure (two lines and the tail); a longer line grows it, never over the scene. */
export const SAY_H = 66
/** The template's padding (top, bottom, sides) and the gap between its parts, mirrored in welcome.css. */
export const PAD_TOP = 8
export const PAD_BOTTOM = 28
export const PAD_X = 24
export const GAP = 18
/** The step column's widest width. */
export const BODY_W = 600
/** The side column needs this much page. */
export const SIDE_MIN_W = 1100
export const SIDE_MIN_H = 600
/** The gap between the side column and the step. */
export const SIDE_GAP = 56
/** The figure's body (arms out, mid-wave) as a fraction of its box's width, each side of the centre. */
export const BODY_HALF = 0.3
/** At most this many tiles around the figure. */
export const ORBIT_MAX = 6

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
/** Even widths keep the figure on a whole pixel. */
const even = (v: number): number => Math.floor(v / 2) * 2
const finite = (v: number, fallback: number): number => (Number.isFinite(v) && v > 0 ? v : fallback)

/** The slot for a page of `width` × `height` CSS px. */
export function welcomeSlot(width: number, height: number): WelcomeSlot {
  const w = finite(width, 1280)
  const h = finite(height, 800)
  const room = h - BAR_H - PAD_TOP - PAD_BOTTOM
  if (w >= SIDE_MIN_W && h >= SIDE_MIN_H) {
    const sceneH = Math.round(clamp((room - SAY_H) * 0.82, 280, 420))
    // The column and the step share the page; the column never squeezes the step under BODY_W - 40.
    const sceneW = even(Math.min(sceneH * 1.05, w - 2 * PAD_X - SIDE_GAP - (BODY_W - 40)))
    return { mode: 'side', sceneW, sceneH, figure: Math.round(sceneH * 0.86), tile: Math.round(clamp(sceneH * 0.14, 44, 56)) }
  }
  const sceneH = Math.round(clamp(room * 0.23, 120, 190))
  return { mode: 'top', sceneW: even(Math.max(sceneH, Math.min(sceneH * 2.1, w - 2 * PAD_X))), sceneH, figure: sceneH, tile: Math.round(clamp(sceneH * 0.24, 34, 46)) }
}

/** The slot's height in the page's flow: the bubble's row and the scene (side by side with the step when 'side'). */
export function stageHeight(slot: WelcomeSlot): number {
  return SAY_H + slot.sceneH
}

/**
 * Room left for a step's content card once the bar, the slot, the title and
 * subtitle (`head`) and the actions are placed: the card scrolls inside this
 * rather than pushing the actions off the page.
 */
export function cardRoom(slot: WelcomeSlot, height: number, head: number, actions: number): number {
  const room = finite(height, 800) - BAR_H - PAD_TOP - PAD_BOTTOM - head - actions - 2 * GAP
  return Math.round(slot.mode === 'side' ? room : room - stageHeight(slot) - GAP)
}

export interface OrbitPoint {
  /** The tile's centre in the scene box, CSS px. */
  x: number
  y: number
  /** How far the tile may reach each side of its centre (a name tag's half-width) without leaving the scene or touching the figure. */
  room: number
  side: 'left' | 'right'
}

export interface Orbit {
  /** Where the connecting lines start: the figure's chest. */
  hub: { x: number; y: number }
  points: OrbitPoint[]
}

/**
 * Where a step's illustration tiles go around the figure: alternately left
 * and right, spread over the figure's height in a soft arc, always clear of
 * its body and inside the scene. Too narrow a scene shows no tiles.
 */
export function orbit(count: number, slot: Pick<WelcomeSlot, 'sceneW' | 'sceneH' | 'figure' | 'tile'>): Orbit {
  const { sceneW: w, sceneH: h, figure, tile } = slot
  const cx = w / 2
  const top = h * 0.98 - figure
  const hub = { x: cx, y: Math.round(top + figure * 0.55) }
  const n = Math.max(0, Math.min(ORBIT_MAX, Math.floor(finite(count, 0))))
  // The band a tile's centre may sit in, measured out from the centre line.
  const near = figure * BODY_HALF + tile / 2 + 6
  const far = cx - tile / 2 - 4
  if (n === 0 || far < near) return { hub, points: [] }
  const mid = (near + far) / 2
  const lo = Math.max(tile / 2 + 4, h * 0.2)
  const hi = Math.min(h - tile / 2 - 4, h * 0.8)
  const perSide = { left: Math.ceil(n / 2), right: Math.floor(n / 2) }
  const points: OrbitPoint[] = []
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? 'left' : 'right'
    const k = perSide[side]
    const j = Math.floor(i / 2)
    const t = k === 1 ? 0.42 : k === 2 ? [0.14, 0.86][j]! : j / (k - 1)
    const y = k === 1 ? h * t : lo + (hi - lo) * t
    // The arc: the middle of three bows out a little, the ends tuck in.
    const bow = k === 3 ? (j === 1 ? 0.6 : -0.25) * (far - mid) : 0
    const d = clamp(mid + bow, near, far)
    const x = side === 'left' ? cx - d : cx + d
    const room = Math.max(tile / 2, Math.min(d - figure * BODY_HALF - 6, cx - d - 4))
    points.push({ x: Math.round(x), y: Math.round(y), room: Math.floor(room), side })
  }
  return { hub, points }
}
