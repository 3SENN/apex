/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A small, deterministic rasterizer for Atelier's icon art.
//
// Coverage is computed per pixel from many horizontal sub-rows, each with
// exact span coverage in x, so edges are smooth at every size without any
// GPU or font engine. Painting is source-over in premultiplied sRGB, the same
// model SVG renderers use. No randomness, no clocks, no platform calls.

import { dilate, resample } from './bitmap.mjs'

/** Parses '#rgb', '#rrggbb' or '#rrggbbaa' into [r, g, b, a] in 0..1. */
export function hex(c, alpha = 1) {
  let s = c.replace('#', '')
  if (s.length === 3) s = s.split('').map((ch) => ch + ch).join('')
  const r = parseInt(s.slice(0, 2), 16) / 255
  const g = parseInt(s.slice(2, 4), 16) / 255
  const b = parseInt(s.slice(4, 6), 16) / 255
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1
  return [r, g, b, a * alpha]
}

/**
 * Coverage of closed polygons over a w×h pixel grid, in 0..1 per pixel.
 * `rule` is 'nonzero' or 'evenodd'.
 */
export function coverage(polys, w, h, rule = 'nonzero', subRows = 16) {
  const cov = new Float32Array(w * h)
  // Edges, bucketed by the pixel rows they touch.
  const rows = Array.from({ length: h }, () => [])
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i]
      const [x1, y1] = poly[(i + 1) % poly.length]
      if (y0 === y1) continue
      const e = y0 < y1 ? { xa: x0, ya: y0, xb: x1, yb: y1, dir: 1 } : { xa: x1, ya: y1, xb: x0, yb: y0, dir: -1 }
      e.slope = (e.xb - e.xa) / (e.yb - e.ya)
      const r0 = Math.max(0, Math.floor(e.ya))
      const r1 = Math.min(h - 1, Math.floor(e.yb))
      for (let r = r0; r <= r1; r++) rows[r].push(e)
    }
  }
  const wgt = 1 / subRows
  const xs = []
  for (let row = 0; row < h; row++) {
    const edges = rows[row]
    if (edges.length === 0) continue
    const base = row * w
    for (let k = 0; k < subRows; k++) {
      const y = row + (k + 0.5) / subRows
      xs.length = 0
      for (const e of edges) {
        if (y >= e.ya && y < e.yb) xs.push([e.xa + (y - e.ya) * e.slope, e.dir])
      }
      if (xs.length < 2) continue
      xs.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      let wind = 0
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i][1]
        const inside = rule === 'evenodd' ? (i + 1) % 2 === 1 : wind !== 0
        if (!inside) continue
        let xa = xs[i][0]
        let xb = xs[i + 1][0]
        if (xb <= 0 || xa >= w) continue
        if (xa < 0) xa = 0
        if (xb > w) xb = w
        const ia = Math.floor(xa)
        const ib = Math.floor(xb)
        if (ia === ib) {
          cov[base + ia] += (xb - xa) * wgt
        } else {
          cov[base + ia] += (ia + 1 - xa) * wgt
          for (let x = ia + 1; x < ib; x++) cov[base + x] += wgt
          if (ib < w) cov[base + ib] += (xb - ib) * wgt
        }
      }
    }
  }
  for (let i = 0; i < cov.length; i++) {
    const v = cov[i]
    cov[i] = v < 0 ? 0 : v > 1 ? 1 : v
  }
  return cov
}

/**
 * Gaussian-like blur of a single-channel mask: three box blurs, sized the
 * way SVG's feGaussianBlur specifies for a given standard deviation.
 */
export function blurMask(mask, w, h, sigma) {
  if (sigma <= 0) return mask
  const d = Math.max(1, Math.floor(sigma * ((3 * Math.sqrt(2 * Math.PI)) / 4) + 0.5))
  const r = Math.floor(d / 2)
  let a = Float32Array.from(mask)
  let b = new Float32Array(w * h)
  const pass = (src, dst, horizontal) => {
    const n = horizontal ? w : h
    const lines = horizontal ? h : w
    const size = 2 * r + 1
    for (let l = 0; l < lines; l++) {
      const at = (i) => (horizontal ? l * w + i : i * w + l)
      let acc = 0
      for (let i = -r; i <= r; i++) if (i >= 0 && i < n) acc += src[at(i)]
      for (let i = 0; i < n; i++) {
        dst[at(i)] = acc / size
        const out = i - r
        const inn = i + r + 1
        if (out >= 0) acc -= src[at(out)]
        if (inn < n) acc += src[at(inn)]
      }
    }
  }
  for (let i = 0; i < 3; i++) {
    pass(a, b, true)
    ;[a, b] = [b, a]
    pass(a, b, false)
    ;[a, b] = [b, a]
  }
  return a
}

function lerpStops(stops, t) {
  if (t <= stops[0].at) return stops[0].color
  const last = stops[stops.length - 1]
  if (t >= last.at) return last.color
  for (let i = 0; i < stops.length - 1; i++) {
    const s0 = stops[i]
    const s1 = stops[i + 1]
    if (t >= s0.at && t <= s1.at) {
      const u = s1.at === s0.at ? 0 : (t - s0.at) / (s1.at - s0.at)
      // Interpolate premultiplied, so a fade to transparent keeps its hue.
      const p0 = [s0.color[0] * s0.color[3], s0.color[1] * s0.color[3], s0.color[2] * s0.color[3], s0.color[3]]
      const p1 = [s1.color[0] * s1.color[3], s1.color[1] * s1.color[3], s1.color[2] * s1.color[3], s1.color[3]]
      const a = p0[3] + (p1[3] - p0[3]) * u
      if (a <= 0) return [0, 0, 0, 0]
      return [
        (p0[0] + (p1[0] - p0[0]) * u) / a,
        (p0[1] + (p1[1] - p0[1]) * u) / a,
        (p0[2] + (p1[2] - p0[2]) * u) / a,
        a
      ]
    }
  }
  return last.color
}

/**
 * Returns fn(x, y) → straight [r, g, b, a] for a paint:
 *   { type: 'solid', color }
 *   { type: 'linear', x1, y1, x2, y2, stops: [{ at, color }] }
 *   { type: 'radial', cx, cy, r, stops }
 */
export function paintFn(paint) {
  if (paint.type === 'solid') {
    const c = paint.color
    return () => c
  }
  if (paint.type === 'linear') {
    const { x1, y1, x2, y2, stops } = paint
    const dx = x2 - x1
    const dy = y2 - y1
    const l2 = dx * dx + dy * dy
    return (x, y) => lerpStops(stops, ((x - x1) * dx + (y - y1) * dy) / l2)
  }
  if (paint.type === 'radial') {
    const { cx, cy, r, stops } = paint
    return (x, y) => {
      const dx = x - cx
      const dy = y - cy
      return lerpStops(stops, Math.sqrt(dx * dx + dy * dy) / r)
    }
  }
  throw new Error(`Unknown paint ${paint.type}`)
}

/** A premultiplied RGBA canvas. */
export class Canvas {
  constructor(w, h) {
    this.w = w
    this.h = h
    this.px = new Float64Array(w * h * 4)
  }

  /** Paints `paint` through a coverage mask, scaled by `opacity`. */
  composite(mask, paint, opacity = 1) {
    const f = paintFn(paint)
    const { w, h, px } = this
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        const m = mask[i] * opacity
        if (m <= 0) continue
        const c = f(x + 0.5, y + 0.5)
        const a = c[3] * m
        if (a <= 0) continue
        const j = i * 4
        const k = 1 - a
        px[j] = c[0] * a + px[j] * k
        px[j + 1] = c[1] * a + px[j + 1] * k
        px[j + 2] = c[2] * a + px[j + 2] * k
        px[j + 3] = a + px[j + 3] * k
      }
    }
  }

  /** Paints premultiplied RGBA floats (canvas-sized) source-over, scaled by `opacity`. */
  compositePremultiplied(src, opacity = 1) {
    const { px } = this
    for (let j = 0; j < src.length; j += 4) {
      const a = src[j + 3] * opacity
      if (a <= 0) continue
      const k = 1 - a
      px[j] = src[j] * opacity + px[j] * k
      px[j + 1] = src[j + 1] * opacity + px[j + 1] * k
      px[j + 2] = src[j + 2] * opacity + px[j + 2] * k
      px[j + 3] = a + px[j + 3] * k
    }
  }

  /** Multiplies the canvas's alpha (and colour) by a mask: a clip after the fact. */
  clipTo(mask) {
    const { px } = this
    for (let i = 0; i < mask.length; i++) {
      const m = mask[i]
      const j = i * 4
      px[j] *= m
      px[j + 1] *= m
      px[j + 2] *= m
      px[j + 3] *= m
    }
  }

  /** 8-bit straight-alpha RGBA. */
  toRGBA8() {
    const { px } = this
    const out = new Uint8Array(this.w * this.h * 4)
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3]
      const a8 = Math.round(Math.min(1, Math.max(0, a)) * 255)
      out[i + 3] = a8
      if (a8 === 0) continue
      for (let c = 0; c < 3; c++) {
        const v = px[i + c] / a
        out[i + c] = Math.round(Math.min(1, Math.max(0, v)) * 255)
      }
    }
    return out
  }

  /** 8-bit RGB over a solid background colour (for formats without alpha). */
  toRGB8Over(bg) {
    const { px } = this
    const out = new Uint8Array(this.w * this.h * 3)
    for (let i = 0, o = 0; i < px.length; i += 4, o += 3) {
      const k = 1 - px[i + 3]
      for (let c = 0; c < 3; c++) {
        const v = px[i + c] + bg[c] * k
        out[o + c] = Math.round(Math.min(1, Math.max(0, v)) * 255)
      }
    }
    return out
  }
}

/** An image op's bitmap resampled onto the canvas grid (premultiplied floats). */
function placed(op, w, h) {
  return resample(op.bitmap, w, h, op.x, op.y, op.w, op.h, op.src)
}

/** The coverage of an image op's bitmap on the canvas (its resampled alpha). */
export function imageMask(op, w, h) {
  const pm = placed(op, w, h)
  const mask = new Float32Array(w * h)
  for (let i = 0; i < mask.length; i++) mask[i] = pm[i * 4 + 3]
  return mask
}

/**
 * Renders a scene: a list of operations in pixel coordinates.
 *   { op: 'fill', path, paint, rule?, opacity?, clip?, clipRule? }
 *   { op: 'shadow', path, color, sigma, dx?, dy?, rule? }
 *   { op: 'clip', path, rule? }   (clips everything drawn so far)
 *   { op: 'erase', path, rule? }  (cuts a shape out of everything drawn so far)
 *   { op: 'image', bitmap, x, y, w, h, src?, opacity?, tint? }
 *        a bitmap (lib/bitmap.mjs) area-resampled into (x, y, w, h); `src` is
 *        the source rectangle (default its content box); `tint` paints a
 *        colour through the bitmap's alpha instead of its own colours
 *   { op: 'halo', bitmap, x, y, w, h, src?, radius, sigma?, color }
 *        the bitmap's coverage grown by `radius` px (and softened by `sigma`),
 *        painted in `color`: a rim or glow that follows the shape
 */
export function render(scene, w, h) {
  const canvas = new Canvas(w, h)
  const size = Math.max(w, h)
  const subRows = size <= 64 ? 64 : size <= 256 ? 32 : 16
  const tol = Math.max(0.02, Math.min(0.12, size / 4096))
  for (const op of scene) {
    if (op.op === 'fill') {
      const mask = coverage(op.path.flatten(tol), w, h, op.rule ?? 'nonzero', subRows)
      if (op.clip) {
        const clip = coverage(op.clip.flatten(tol), w, h, op.clipRule ?? 'nonzero', subRows)
        for (let i = 0; i < mask.length; i++) mask[i] *= clip[i]
      }
      canvas.composite(mask, op.paint, op.opacity ?? 1)
    } else if (op.op === 'shadow') {
      const p = op.path.translate(op.dx ?? 0, op.dy ?? 0)
      const mask = blurMask(coverage(p.flatten(tol), w, h, op.rule ?? 'nonzero', subRows), w, h, op.sigma)
      canvas.composite(mask, { type: 'solid', color: op.color })
    } else if (op.op === 'clip') {
      canvas.clipTo(coverage(op.path.flatten(tol), w, h, op.rule ?? 'nonzero', subRows))
    } else if (op.op === 'erase') {
      const cov = coverage(op.path.flatten(tol), w, h, op.rule ?? 'nonzero', subRows)
      for (let i = 0; i < cov.length; i++) cov[i] = 1 - cov[i]
      canvas.clipTo(cov)
    } else if (op.op === 'image') {
      if (op.tint) canvas.composite(imageMask(op, w, h), { type: 'solid', color: op.tint }, op.opacity ?? 1)
      else canvas.compositePremultiplied(placed(op, w, h), op.opacity ?? 1)
    } else if (op.op === 'halo') {
      const grown = dilate(imageMask(op, w, h), w, h, op.radius)
      canvas.composite(op.sigma ? blurMask(grown, w, h, op.sigma) : grown, { type: 'solid', color: op.color })
    } else {
      throw new Error(`Unknown scene op ${op.op}`)
    }
  }
  return canvas
}
