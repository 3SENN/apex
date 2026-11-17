/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Bitmaps for the icon art: Pip's rendered masters (branding/official/art/*.png), cut
// to their content, resampled by exact area averaging, and the masks the
// small sizes and the tray need (a grown silhouette, the face's features).
// Pure and deterministic, like the rest of lib/.

import { readFileSync } from 'node:fs'
import { decodePNG } from './png.mjs'

/**
 * A straight-alpha RGBA8 image, premultiplied once into floats for
 * resampling. `box` is the tight bounding box of its visible pixels.
 */
export class Bitmap {
  constructor(width, height, pixels) {
    this.width = width
    this.height = height
    this.pixels = pixels
    const pm = new Float32Array(width * height * 4)
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
      const a = pixels[i + 3] / 255
      pm[i] = (pixels[i] / 255) * a
      pm[i + 1] = (pixels[i + 1] / 255) * a
      pm[i + 2] = (pixels[i + 2] / 255) * a
      pm[i + 3] = a
      if (pixels[i + 3] > 2) {
        const x = p % width
        const y = (p - x) / width
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    this.pm = pm
    this.box = x1 < 0 ? { x: 0, y: 0, w: width, h: height } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
  }

  static fromPNG(buf) {
    const { width, height, pixels } = decodePNG(buf)
    return new Bitmap(width, height, pixels)
  }

  static read(path) {
    return Bitmap.fromPNG(readFileSync(path))
  }

  /** A single-channel image (0..1) as a black bitmap with that alpha. */
  static fromMask(mask, width, height) {
    const px = new Uint8Array(width * height * 4)
    for (let i = 0; i < mask.length; i++) px[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, mask[i])) * 255)
    return new Bitmap(width, height, px)
  }

  alpha() {
    const out = new Float32Array(this.width * this.height)
    for (let i = 0; i < out.length; i++) out[i] = this.pm[i * 4 + 3]
    return out
  }
}

/**
 * Per destination pixel along one axis: the source pixels it covers and how
 * much of the destination pixel each fills. The source span [s0, s0 + sLen)
 * lands on [d0, d0 + dLen) in destination pixels (both may be fractional).
 */
function axisWeights(s0, sLen, d0, dLen, dSize, sSize) {
  const out = []
  const k = sLen / dLen
  const first = Math.max(0, Math.floor(d0))
  const last = Math.min(dSize, Math.ceil(d0 + dLen))
  for (let i = first; i < last; i++) {
    const a = s0 + (i - d0) * k
    const b = a + k
    const lo = Math.max(0, Math.floor(Math.max(a, s0)))
    const hi = Math.min(sSize, Math.ceil(Math.min(b, s0 + sLen)))
    const taps = []
    for (let s = lo; s < hi; s++) {
      const overlap = Math.min(b, s + 1, s0 + sLen) - Math.max(a, s, s0)
      if (overlap > 0) taps.push(s, overlap / k)
    }
    if (taps.length) out.push({ i, taps })
  }
  return out
}

/**
 * Resamples a source rectangle of a bitmap onto a w×h canvas grid at
 * (dx, dy, dw, dh) (canvas pixels, fractional allowed) by exact area
 * averaging. Returns premultiplied RGBA floats the size of the canvas.
 * `src` defaults to the bitmap's content box.
 */
export function resample(bmp, w, h, dx, dy, dw, dh, src = bmp.box) {
  const cols = axisWeights(src.x, src.w, dx, dw, w, bmp.width)
  const rows = axisWeights(src.y, src.h, dy, dh, h, bmp.height)
  const out = new Float32Array(w * h * 4)
  if (!cols.length || !rows.length) return out
  // Horizontal pass over just the source rows any destination row reads.
  const rowLo = Math.max(0, Math.floor(src.y))
  const rowHi = Math.min(bmp.height, Math.ceil(src.y + src.h))
  const tmp = new Float32Array((rowHi - rowLo) * w * 4)
  const { pm, width } = bmp
  for (let sy = rowLo; sy < rowHi; sy++) {
    const srcRow = sy * width * 4
    const dstRow = (sy - rowLo) * w * 4
    for (const { i, taps } of cols) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let t = 0; t < taps.length; t += 2) {
        const j = srcRow + taps[t] * 4
        const f = taps[t + 1]
        r += pm[j] * f
        g += pm[j + 1] * f
        b += pm[j + 2] * f
        a += pm[j + 3] * f
      }
      const o = dstRow + i * 4
      tmp[o] = r
      tmp[o + 1] = g
      tmp[o + 2] = b
      tmp[o + 3] = a
    }
  }
  for (const { i: y, taps } of rows) {
    for (const { i: x } of cols) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let t = 0; t < taps.length; t += 2) {
        const j = ((taps[t] - rowLo) * w + x) * 4
        const f = taps[t + 1]
        r += tmp[j] * f
        g += tmp[j + 1] * f
        b += tmp[j + 2] * f
        a += tmp[j + 3] * f
      }
      const o = (y * w + x) * 4
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = a > 1 ? 1 : a
    }
  }
  return out
}

/** Grows a mask by a disc of `radius` pixels (a max filter), for halos and rims. */
export function dilate(mask, w, h, radius) {
  if (radius <= 0) return Float32Array.from(mask)
  const r = Math.ceil(radius)
  const out = new Float32Array(w * h)
  const offsets = []
  for (let oy = -r; oy <= r; oy++) {
    for (let ox = -r; ox <= r; ox++) {
      const d = Math.hypot(ox, oy)
      // A soft edge on the disc keeps the grown outline anti-aliased.
      const wgt = Math.min(1, Math.max(0, radius + 0.5 - d))
      if (wgt > 0) offsets.push(ox, oy, wgt)
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0
      for (let k = 0; k < offsets.length; k += 3) {
        const sx = x + offsets[k]
        const sy = y + offsets[k + 1]
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
        const v = mask[sy * w + sx] * offsets[k + 2]
        if (v > m) m = v
      }
      out[y * w + x] = m
    }
  }
  return out
}

/** Shrinks a binary mask by a square of `radius` pixels (a min filter), in two separable passes. */
export function erodeSquare(mask, w, h, radius) {
  const pass = (src, horizontal) => {
    const out = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 1
        for (let k = -radius; k <= radius && m > 0; k++) {
          const sx = horizontal ? x + k : x
          const sy = horizontal ? y : y + k
          const v = sx < 0 || sy < 0 || sx >= w || sy >= h ? 0 : src[sy * w + sx]
          if (v < m) m = v
        }
        out[y * w + x] = m
      }
    }
    return out
  }
  return pass(pass(mask, true), false)
}

/**
 * The face's features in a head master: the dark marks (eyes, brows,
 * mouth) well inside the outline, as connected components with their
 * centroid, bounds and area, largest first. Coordinates are master pixels.
 */
export function faceFeatures(bmp, { darkness = 0.32, edge = 0.02 } = {}) {
  const { width: w, height: h, pixels } = bmp
  const solid = new Float32Array(w * h)
  for (let i = 0; i < solid.length; i++) solid[i] = pixels[i * 4 + 3] > 200 ? 1 : 0
  // Stay clear of the outline: features sit at least `edge` of the head's width inside it.
  const inner = erodeSquare(solid, w, h, Math.max(2, Math.round(bmp.box.w * edge)))
  const dark = new Uint8Array(w * h)
  for (let i = 0; i < dark.length; i++) {
    if (!inner[i]) continue
    const lum = (0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2]) / 255
    if (lum < darkness) dark[i] = 1
  }
  const seen = new Uint8Array(w * h)
  const parts = []
  const stack = []
  for (let start = 0; start < dark.length; start++) {
    if (!dark[start] || seen[start]) continue
    let area = 0
    let sx = 0
    let sy = 0
    let x0 = w
    let y0 = h
    let x1 = 0
    let y1 = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const p = stack.pop()
      const x = p % w
      const y = (p - x) / w
      area++
      sx += x
      sy += y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= dark.length || seen[q] || !dark[q]) continue
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue
        seen[q] = 1
        stack.push(q)
      }
    }
    if (area >= (bmp.box.w * bmp.box.w) / 20000) parts.push({ cx: sx / area + 0.5, cy: sy / area + 0.5, x0, y0, x1: x1 + 1, y1: y1 + 1, area })
  }
  return parts.sort((a, b) => b.area - a.area || a.cy - b.cy || a.cx - b.cx)
}

/**
 * Where the eyes and the mouth are in a head master: the mouth is the
 * largest mark near the middle column; each eye is the lowest mark on its
 * side above the mouth (below the brow). The hair, above the face, is left
 * out. Master pixel coordinates.
 */
export function faceLandmarks(bmp) {
  const faceTop = bmp.box.y + bmp.box.h * 0.35
  const parts = faceFeatures(bmp).filter((p) => p.cy > faceTop)
  const mid = bmp.box.x + bmp.box.w / 2
  const near = bmp.box.w * 0.1
  const mouth = parts.find((p) => Math.abs(p.cx - mid) < near)
  if (!mouth) throw new Error('Pip master: no mouth found')
  const side = (left) =>
    parts
      .filter((p) => p !== mouth && (left ? p.cx < mid - near : p.cx > mid + near) && p.cy < mouth.cy)
      .sort((a, b) => b.cy - a.cy)[0]
  const leftEye = side(true)
  const rightEye = side(false)
  if (!leftEye || !rightEye) throw new Error('Pip master: the eyes were not found')
  return { leftEye, rightEye, mouth }
}
