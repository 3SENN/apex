/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Atelier Companion Art: licensed under the Atelier Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// Atelier's icon art. The logo is the brand mark: Pip, Atelier's first companion,
// drawn flat, with the sprout growing from its highest point and two smiling
// eyes, in the same 64-unit grid as atelierbrowser.eu's mark.svg and icon.svg.
// The app icon is the mark in white on a flat violet squircle; the in-app
// mark is the mark in its own colours (lavender head, violet sprout); the
// tray is its silhouette with the eyes cut out. Small sizes grow the mark and
// keep the eyes at least a pixel wide, so it still reads at 16 px.
//
// The document icons for companions and packs show the companions
// themselves, rendered by the app's own companion renderer (render-pip.mjs
// writes those masters to branding/official/art/).
//
// Every builder returns a scene (see lib/raster.mjs) in pixel coordinates for
// the size asked, so small sizes can be fitted to the pixel grid.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bitmap, faceLandmarks } from './lib/bitmap.mjs'
import { fieldPath, smoothstep } from './lib/field.mjs'
import { Path, squircle, roundedRect, circle, spark, strokeCubic, strokeOutline } from './lib/geometry.mjs'
import { hex } from './lib/raster.mjs'
import { DMG, SIDEBAR, layout } from './lib/layout.mjs'

// The shared sizes (lib/layout.mjs), for the scripts that took them from here.
export { DMG, SIDEBAR, layout }

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

/** Pip's rendered masters (scripts/app-icons/render-pip.mjs), read from the repo; the companion and pack documents use them. */
export const MASTERS = { head: 'branding/official/art/pip-head.png', full: 'branding/official/art/pip-full.png' }

let masters = null
/** The masters as bitmaps, with the head's eyes and mouth located. */
export function pip() {
  if (!masters) {
    const head = Bitmap.read(join(REPO, MASTERS.head))
    const full = Bitmap.read(join(REPO, MASTERS.full))
    masters = { head, full, face: faceLandmarks(head) }
  }
  return masters
}

/** Atelier's icon colours: the brand's violet (atelierbrowser.eu/brand.html) and what the art around it needs. */
export const PALETTE = {
  /** The tile, the sprout, links. */
  violet: '#6a4bff',
  /** The mark's head in its own colours. */
  lavender: '#8f74f8',
  darkTile: '#1f1a3a',
  lightTile: '#ffffff',
  glyph: '#ffffff',
  /** Pip's own outline colour, for the rim small companion documents add. */
  rim: '#180074',
  /** Pip's eyes and mouth, for the face small companion documents redraw. */
  face: '#1d1236',
  ink: '#1d1a2e',
  paper: '#ffffff',
  shadow: '#0c0824',
  page: '#ffffff',
  pageEdge: '#d9d6e6',
  pageFold: '#ece9f6',
  pageLine: '#cdc8e0',
  ground: '#f6f5fa',
  groundLow: '#ebe8f3',
  groundGlyph: '#d4cdee',
  arrow: '#a79fd0'
}

const C = (k, a = 1) => hex(PALETTE[k], a)
const solid = (color) => ({ type: 'solid', color })

// ---------------------------------------------------------------------------
// The mark.

/**
 * The mark in its 64-unit grid (atelierbrowser.eu/assets/brand/mark.svg). The
 * head is one closed outline from (32, 19.5); the sprout and the eyes are
 * round-capped strokes. Every curve is a cubic: [x0, y0, x1, y1, x2, y2, x3, y3].
 */
export const MARK = {
  head: {
    start: [32, 19.5],
    curves: [
      [19.4, 19.5, 10.5, 27.3, 10.5, 39.9],
      [10.5, 51.6, 18.4, 58, 32, 58],
      [45.6, 58, 53.5, 51.6, 53.5, 39.9],
      [53.5, 27.3, 44.6, 19.5, 32, 19.5]
    ]
  },
  sprout: {
    width: 5.32,
    curves: [
      [31, 24.9, 30.6, 17.2, 32.1, 11.4, 38.2, 10],
      [31.2, 17.5, 29, 14.5, 25.5, 14.3, 23.5, 16]
    ]
  },
  eyes: {
    width: 3.1,
    curves: [
      [19.6, 40.2, 21.2, 36.8, 25.6, 36.8, 27.2, 40.2],
      [36.8, 40.2, 38.4, 36.8, 42.8, 36.8, 44.4, 40.2]
    ]
  },
  /** What is drawn: the head's sides and chin, and the sprout's tip with its cap. */
  box: { x0: 10.5, y0: 7.34, x1: 53.5, y1: 58 }
}

/**
 * The mark placed so what is drawn is `height` tall, centred on (cx, cy), as
 * paths: the head, the sprout's two strokes and the two eyes. Eye strokes are
 * at least `minEye` px wide so the face survives small sizes.
 */
export function markShapes({ cx, cy, height, minEye = 0 }) {
  const { box } = MARK
  const s = height / (box.y1 - box.y0)
  const mx = (box.x0 + box.x1) / 2
  const my = (box.y0 + box.y1) / 2
  const at = (c) => c.map((v, i) => (i % 2 ? cy + (v - my) * s : cx + (v - mx) * s))
  const [hx, hy] = at(MARK.head.start)
  const head = new Path().moveTo(hx, hy)
  for (const c of MARK.head.curves) head.cubicTo(...at(c))
  head.close()
  const sprout = MARK.sprout.curves.map((c) => strokeCubic(at(c), (MARK.sprout.width * s) / 2))
  const eyeHalf = Math.max(MARK.eyes.width * s, minEye) / 2
  const eyes = MARK.eyes.curves.map((c) => strokeCubic(at(c), eyeHalf))
  return { head, sprout, eyes }
}

/**
 * The mark's paint ops: the head, the sprout (in the head's colour unless
 * given), then the eyes in their colour, or cut out of everything drawn so
 * far when `eyes` is null.
 */
export function markOps(m, { head, sprout = head, eyes }) {
  const ops = [{ op: 'fill', path: m.head, paint: solid(head) }]
  for (const path of m.sprout) ops.push({ op: 'fill', path, paint: solid(sprout) })
  for (const path of m.eyes) ops.push(eyes ? { op: 'fill', path, paint: solid(eyes) } : { op: 'erase', path })
  return ops
}

/** The mark's height as a share of the tile's body: larger when small, so the face survives. */
export function markShare(body) {
  return body <= 18 ? 0.84 : body <= 30 ? 0.76 : body < 48 ? 0.7 : body < 120 ? 0.64 : 0.58
}

/** The narrowest eye stroke at an image size, in px. */
export function minEye(size) {
  return size <= 20 ? 1.15 : size <= 40 ? 1.3 : 0
}

/** The mark sits a little below the tile's middle, as on atelierbrowser.eu, so its weight looks centred. */
const MARK_DROP = 0.022

// ---------------------------------------------------------------------------
// Size fitting.

/**
 * Where a master goes so its content is `height` tall, centred on cx with
 * its content's middle at cy. Whole pixels when `snap` (small sizes), so
 * edges stay crisp.
 */
export function place(bmp, { cx, cy, height, snap = false }) {
  const { box } = bmp
  let h = height
  let w = (h * box.w) / box.h
  let x = cx - w / 2
  let y = cy - h / 2
  if (snap) {
    h = Math.max(1, Math.round(h))
    w = Math.max(1, Math.round(w))
    x = Math.round(cx - w / 2)
    y = Math.round(cy - h / 2)
  }
  return { bitmap: bmp, x, y, w, h }
}

/** A master's point (master pixels) on the canvas for a placement. */
export function mapPoint(pl, [mx, my]) {
  const { box } = pl.bitmap
  return [pl.x + ((mx - box.x) * pl.w) / box.w, pl.y + ((my - box.y) * pl.h) / box.h]
}

/** An ellipse path. */
function ellipse(cx, cy, rx, ry) {
  return circle(0, 0, 1).map((x, y) => [cx + x * rx, cy + y * ry])
}

// ---------------------------------------------------------------------------
// Scenes.

/**
 * The app icon: the mark in white on a flat violet tile, as on atelierbrowser.eu.
 *   style       'mac' | 'flat'
 *   appearance  'light' | 'dark' (the tile; macOS 26 dark)
 *   ground      'violet' (the icon) | 'light' (the mark in its own colours on a white tile, a preview variant)
 */
export function appIcon(size, { style = 'mac', appearance = 'light', ground = 'violet' } = {}) {
  const { inset, body } = layout(size, style)
  const tile = squircle(inset, inset, body, body, 5, size <= 64 ? 128 : 512)
  const dark = appearance === 'dark'
  const light = ground === 'light' && !dark
  const tileColour = C(dark ? 'darkTile' : light ? 'lightTile' : 'violet')
  const ops = []
  if (style === 'mac' && size >= 64) {
    ops.push({ op: 'shadow', path: tile, color: C('shadow', light ? 0.22 : 0.3), sigma: size * 0.011, dy: size * 0.012 })
  }
  ops.push({ op: 'fill', path: tile, paint: solid(tileColour) })
  const mark = markShapes({ cx: size / 2, cy: inset + body / 2 + body * MARK_DROP, height: body * markShare(body), minEye: minEye(size) })
  ops.push(...markOps(mark, light ? { head: C('lavender'), sprout: C('violet'), eyes: C('paper') } : { head: C('glyph'), eyes: tileColour }))
  return ops
}

/**
 * Pip's eyes and smile redrawn on the pixel grid for the smallest sizes,
 * where the rendered ones blur into the brows: two dots and a half disc.
 * As `erase` ops when `cut` (the tray's holes), else filled in `color`.
 */
export function smallFace(pl, size, color, { cut = false } = {}) {
  const { face } = pip()
  const scale = pl.w / pl.bitmap.box.w
  const snap = size <= 40
  const shapes = []
  const eyeR = Math.max(size <= 20 ? 0.95 : 1.4, ((face.leftEye.x1 - face.leftEye.x0) * scale) / 2.4)
  for (const eye of [face.leftEye, face.rightEye]) {
    let [x, y] = mapPoint(pl, [eye.cx, eye.cy])
    if (snap) {
      x = Math.floor(x) + 0.5
      y = Math.floor(y) + 0.5
    }
    shapes.push(circle(x, y, eyeR))
  }
  const [mx0, my0] = mapPoint(pl, [face.mouth.x0, face.mouth.y0])
  const [mx1] = mapPoint(pl, [face.mouth.x1, face.mouth.y0])
  const r = Math.max(size <= 20 ? 1.4 : 2, (mx1 - mx0) / 2)
  const mcx = snap ? Math.round(mx0 + mx1) / 2 : (mx0 + mx1) / 2
  const mtop = snap ? Math.round(my0) : my0
  shapes.push(new Path().moveTo(mcx - r, mtop).lineTo(mcx + r, mtop).arc(mcx, mtop, r, 0, Math.PI).close())
  return shapes.map((path) => (cut ? { op: 'erase', path } : { op: 'fill', path, paint: { type: 'solid', color } }))
}

/**
 * The mark as a single-colour glyph for trays: the head and the sprout, with
 * the eyes cut out. A template uses black.
 */
export function trayGlyph(size, { ink }) {
  const pad = size <= 20 ? 0.5 : 1
  const mark = markShapes({ cx: size / 2, cy: size / 2, height: size - pad * 2, minEye: size <= 20 ? 1.5 : size <= 40 ? 1.7 : 0 })
  return markOps(mark, { head: ink, eyes: null })
}

/** macOS menu-bar template: black and alpha only; macOS tints it for light and dark bars. */
export function trayTemplate(size) {
  return trayGlyph(size, { ink: hex('#000000') })
}

/** Windows notification-area glyph for a light or a dark taskbar. */
export function trayWindows(size, theme) {
  return trayGlyph(size, { ink: theme === 'dark' ? C('paper') : C('ink') })
}

/**
 * The in-app mark: the mark in its own colours on a clear square, a lavender
 * head under a violet sprout with white eyes (the wordmark sits beside it in
 * the UI).
 */
export function brandMark(size) {
  const pad = size <= 64 ? 1 : size * 0.03
  const mark = markShapes({ cx: size / 2, cy: size / 2, height: size - pad * 2, minEye: minEye(size) })
  return markOps(mark, { head: C('lavender'), sprout: C('violet'), eyes: C('paper') })
}

// ---------------------------------------------------------------------------
// Document icons: a page with a folded corner.

function page(size, style) {
  // Page box inside the canvas, portrait, about 0.78 wide to tall.
  let h = style === 'mac' ? size * 0.86 : size * 0.94
  let w = h * 0.78
  if (size < 64) {
    // Whole pixels at small sizes, so the page's edges stay crisp.
    h = Math.round(h)
    w = Math.round(w)
  }
  const x = size < 64 ? Math.floor((size - w) / 2) : (size - w) / 2
  const y = size < 64 ? Math.floor((size - h) / 2) : (size - h) / 2
  const fold = w * 0.28
  const r = Math.max(0.5, w * 0.06)
  const outline = new Path()
  outline.moveTo(x + r, y)
  outline.lineTo(x + w - fold, y)
  outline.lineTo(x + w, y + fold)
  outline.lineTo(x + w, y + h - r)
  outline.arc(x + w - r, y + h - r, r, 0, Math.PI / 2)
  outline.lineTo(x + r, y + h)
  outline.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI / 2)
  outline.lineTo(x, y + r)
  outline.arc(x + r, y + r, r, Math.PI, Math.PI / 2)
  outline.close()
  const flap = new Path().moveTo(x + w - fold, y).lineTo(x + w - fold, y + fold - r * 0.6).arc(x + w - fold + r * 0.6, y + fold - r * 0.6, r * 0.6, Math.PI, -Math.PI / 2).lineTo(x + w, y + fold).close()
  return { x, y, w, h, fold, outline, flap }
}

function pageScene(size, style) {
  const p = page(size, style)
  const ops = []
  if (style === 'mac' && size >= 64) {
    ops.push({ op: 'shadow', path: p.outline, color: C('shadow', 0.22), sigma: size * 0.01, dy: size * 0.01 })
  }
  const edge = Math.max(1, size / 256)
  // Border: the outline, then the page inset by the border width.
  ops.push({ op: 'fill', path: p.outline, paint: { type: 'solid', color: size < 48 ? hex('#bdb7d2') : C('pageEdge') } })
  const inner = p.outline.map((px, py) => [p.x + edge + ((px - p.x) * (p.w - 2 * edge)) / p.w, p.y + edge + ((py - p.y) * (p.h - 2 * edge)) / p.h])
  ops.push({
    op: 'fill',
    path: inner,
    paint: { type: 'linear', x1: 0, y1: p.y, x2: 0, y2: p.y + p.h, stops: [{ at: 0, color: C('page') }, { at: 1, color: hex('#f4f2fb') }] }
  })
  ops.push({ op: 'fill', path: p.flap, paint: { type: 'solid', color: C('pageFold') } })
  return { p, ops }
}

/** The icon for HTML documents Atelier opens: a page with text lines and the app icon as its badge. */
export function htmlDocument(size, { style = 'mac' } = {}) {
  const { p, ops } = pageScene(size, style)
  const small = size < 48
  if (!small) {
    const lh = Math.max(1, p.h * 0.035)
    const lx = p.x + p.w * 0.16
    const widths = [0.5, 0.68, 0.6]
    widths.forEach((f, i) => {
      const ly = p.y + p.h * (0.13 + i * 0.085)
      ops.push({ op: 'fill', path: roundedRect(lx, ly, p.w * f, lh, lh / 2), paint: { type: 'solid', color: C('pageLine') } })
    })
  }
  // The app icon as a badge in the lower part of the page, drawn at its own
  // pixel size so small sizes get the larger mark and wider eyes.
  const t = Math.round(small ? p.w * 0.9 : p.w * 0.62)
  const tx = Math.round(p.x + (p.w - t) / 2)
  const ty = Math.round(p.y + p.h * (small ? 0.34 : 0.45))
  const badge = appIcon(t, { style: 'flat' }).map((o) => translateOp(o, tx, ty))
  return ops.concat(badge)
}

/** The icon for exported companions (.ateliercompanion): a page with Pip's head on it. */
export function companionDocument(size, { style = 'mac' } = {}) {
  const { head } = pip()
  const { p, ops } = pageScene(size, style)
  const small = size < 48
  const cx = p.x + p.w / 2
  const height = p.w * (small ? 0.84 : 0.66)
  const cy = p.y + p.h * (small ? 0.6 : 0.58)
  const pl = place(head, { cx, cy, height, snap: small })
  if (!small) {
    // A pale violet disc behind Pip, and two small sparks for life.
    const r = p.w * 0.38
    ops.push({ op: 'fill', path: circle(cx, cy + height * 0.04, r), paint: { type: 'radial', cx, cy, r, stops: [{ at: 0, color: hex('#e7e1ff') }, { at: 1, color: hex('#f3f0ff', 0.4) }] } })
    ops.push({ op: 'shadow', path: ellipse(cx, pl.y + pl.h + pl.h * 0.01, pl.w * 0.3, pl.h * 0.045), color: C('shadow', 0.24), sigma: pl.h * 0.025 })
    ops.push({ op: 'fill', path: spark(cx + r * 1.0, cy - r * 0.98, r * 0.17, 0.42), paint: { type: 'solid', color: C('violet') } })
    ops.push({ op: 'fill', path: spark(cx - r * 1.02, cy - r * 0.62, r * 0.11, 0.42), paint: { type: 'solid', color: C('violet', 0.7) } })
  } else {
    ops.push({ op: 'halo', ...pl, radius: size <= 16 ? 0.9 : 1, color: C('rim') })
  }
  ops.push({ op: 'image', ...pl })
  if (pl.h <= 20) ops.push(...smallFace(pl, pl.h, C('face')))
  return ops
}

/** The .atelierpack group picture's other members (render-pip.mjs writes them; Pip is pip()). */
export const GROUP_MASTERS = {
  mochi: { head: 'branding/official/art/group-mochi-head.png', full: 'branding/official/art/group-mochi-full.png' },
  bolt: { head: 'branding/official/art/group-bolt-head.png', full: 'branding/official/art/group-bolt-full.png' },
}

let groupMasters = null
function group() {
  if (!groupMasters) {
    const read = (m) => ({ head: Bitmap.read(join(REPO, m.head)), full: Bitmap.read(join(REPO, m.full)) })
    groupMasters = { mochi: read(GROUP_MASTERS.mochi), bolt: read(GROUP_MASTERS.bolt) }
  }
  return groupMasters
}

/** Confetti for the group picture: dots, sparks and short streamers in the companions' colours. */
function confetti(p, ops) {
  const bits = [
    { kind: 'spark', x: 0.2, y: 0.17, r: 0.07, color: '#6a4bff' },
    { kind: 'dot', x: 0.43, y: 0.1, r: 0.03, color: '#ff8fc4' },
    { kind: 'dot', x: 0.56, y: 0.23, r: 0.025, color: '#ffd166' },
    { kind: 'bar', x: 0.33, y: 0.27, r: 0.055, color: '#4cc9f0', turn: -0.6 },
    { kind: 'spark', x: 0.66, y: 0.36, r: 0.05, color: '#ffd166' },
    { kind: 'dot', x: 0.13, y: 0.36, r: 0.028, color: '#4cc9f0' },
    { kind: 'bar', x: 0.82, y: 0.48, r: 0.05, color: '#ff8fc4', turn: 0.7 },
    { kind: 'dot', x: 0.47, y: 0.38, r: 0.02, color: '#6a4bff' },
  ]
  for (const b of bits) {
    const cx = p.x + p.w * b.x
    const cy = p.y + p.h * b.y
    const r = p.w * b.r
    if (b.kind === 'dot') ops.push({ op: 'fill', path: circle(cx, cy, r), paint: { type: 'solid', color: hex(b.color) } })
    else if (b.kind === 'spark') ops.push({ op: 'fill', path: spark(cx, cy, r, 0.42), paint: { type: 'solid', color: hex(b.color) } })
    else {
      const c = Math.cos(b.turn)
      const sn = Math.sin(b.turn)
      const bar = roundedRect(-r, -r * 0.28, r * 2, r * 0.56, r * 0.28).map((x, y) => [cx + x * c - y * sn, cy + x * sn + y * c])
      ops.push({ op: 'fill', path: bar, paint: { type: 'solid', color: hex(b.color) } })
    }
  }
}

/**
 * The icon for packs (.atelierpack): a group picture. Mochi, Pip and Bolt stand
 * together on the page under confetti, Pip in front; middling sizes keep their
 * three heads, and the smallest keep Pip's head alone so it still reads.
 */
export function packDocument(size, { style = 'mac' } = {}) {
  const { full: pipFull, head: pipHead } = pip()
  const { mochi, bolt } = group()
  const { p, ops } = pageScene(size, style)
  const cx = p.x + p.w / 2
  if (size < 24) {
    // As the companion document does at this size: Pip's head with a rim.
    const pl = place(pipHead, { cx, cy: p.y + p.h * 0.6, height: p.w * 0.84, snap: true })
    ops.push({ op: 'halo', ...pl, radius: size <= 16 ? 0.9 : 1, color: C('rim') })
    ops.push({ op: 'image', ...pl })
    if (pl.h <= 20) ops.push(...smallFace(pl, pl.h, C('face')))
    return ops
  }
  if (size < 64) {
    // Three heads, Pip in front and a little lower.
    const h = p.w * 0.5
    const snap = true
    const left = place(mochi.head, { cx: cx - p.w * 0.24, cy: p.y + p.h * 0.5, height: h * 0.88, snap })
    const right = place(bolt.head, { cx: cx + p.w * 0.24, cy: p.y + p.h * 0.5, height: h * 0.88, snap })
    const front = place(pipHead, { cx, cy: p.y + p.h * 0.66, height: h, snap })
    for (const pl of [left, right, front]) {
      ops.push({ op: 'halo', ...pl, radius: 1, color: C('rim') })
      ops.push({ op: 'image', ...pl })
    }
    // Pip's face drawn crisp, as the small app icons do, so the front face reads.
    if (front.h <= 26) ops.push(...smallFace(front, front.h, C('face')))
    ops.push({ op: 'fill', path: spark(p.x + p.w * 0.22, p.y + p.h * 0.18, p.w * 0.1, 0.42), paint: { type: 'solid', color: C('violet') } })
    return ops
  }
  // The group shot: a pale backdrop, confetti, and the three standing close, feet on one line.
  const r = p.w * 0.46
  ops.push({ op: 'fill', path: circle(cx, p.y + p.h * 0.62, r), paint: { type: 'radial', cx, cy: p.y + p.h * 0.62, r, stops: [{ at: 0, color: hex('#ece6ff') }, { at: 1, color: hex('#f6f3ff', 0.35) }] } })
  confetti(p, ops)
  const floor = p.y + p.h * 0.94
  const stand = (bmp, x, height) => {
    const pl = place(bmp, { cx: x, cy: 0, height })
    return { ...pl, y: floor - pl.h }
  }
  const side = p.h * 0.47
  const left = stand(mochi.full, cx - p.w * 0.25, side)
  const right = stand(bolt.full, cx + p.w * 0.245, side * 0.97)
  const front = stand(pipFull, cx, p.h * 0.56)
  ops.push({ op: 'shadow', path: ellipse(cx, floor - p.h * 0.01, p.w * 0.42, p.h * 0.03), color: C('shadow', 0.16), sigma: p.h * 0.02 })
  for (const pl of [left, right, front]) ops.push({ op: 'image', ...pl })
  return ops
}

/** Moves an op by (dx, dy). */
function translateOp(op, dx, dy) {
  const out = { ...op }
  if (op.path) out.path = op.path.translate(dx, dy)
  if (op.clip) out.clip = op.clip.translate(dx, dy)
  if (op.op === 'image' || op.op === 'halo') {
    out.x = op.x + dx
    out.y = op.y + dy
  }
  if (op.paint) {
    const p = { ...op.paint }
    if (p.type === 'linear') {
      p.x1 += dx
      p.y1 += dy
      p.x2 += dx
      p.y2 += dy
    } else if (p.type === 'radial') {
      p.cx += dx
      p.cy += dy
    }
    out.paint = p
  }
  return out
}

// ---------------------------------------------------------------------------
// Installer art.

/**
 * DMG window background (540×380 points). A light, quiet ground, the glyph
 * field rising faintly from the bottom edge, and a chevron between the app
 * (130, 220) and the Applications link (410, 220).
 */
export function dmgBackground(scale = 1) {
  const W = DMG.width * scale
  const H = DMG.height * scale
  const s = scale
  const rect = new Path().moveTo(0, 0).lineTo(W, 0).lineTo(W, H).lineTo(0, H).close()
  const ops = []
  ops.push({
    op: 'fill',
    path: rect,
    paint: { type: 'linear', x1: 0, y1: 0, x2: 0, y2: H, stops: [{ at: 0, color: C('ground') }, { at: 1, color: C('groundLow') }] }
  })
  const field = fieldPath({
    box: { x: 0, y: 0, w: W, h: H },
    pitch: 26 * s,
    origin: [W / 2, H * 1.05],
    seed: 11,
    // Only a low band under the icons' labels, growing toward the bottom edge.
    keep: (x, y) => smoothstep(H * 0.8, H * 1.02, y)
  })
  ops.push({ op: 'fill', path: field, paint: { type: 'solid', color: C('groundGlyph', 0.9) } })
  // The chevron, made of two round-capped strokes.
  const [ax, ay] = [(DMG.app[0] + DMG.applications[0]) / 2, DMG.app[1]]
  const arm = 14
  const chevron = strokeOutline(
    [
      [(ax - arm * 0.55) * s, (ay - arm) * s],
      [(ax + arm * 0.55) * s, ay * s],
      [(ax - arm * 0.55) * s, (ay + arm) * s]
    ],
    3.2 * s
  )
  ops.push({ op: 'fill', path: chevron, paint: { type: 'solid', color: C('arrow') } })
  return { ops, width: W, height: H }
}

/**
 * NSIS welcome and finish page sidebar, 164×314: the violet ground with the
 * mark in white near the top, as on the app icon.
 */
export function installerSidebar() {
  const { width: W, height: H } = SIDEBAR
  const rect = new Path().moveTo(0, 0).lineTo(W, 0).lineTo(W, H).lineTo(0, H).close()
  const mark = markShapes({ cx: W / 2, cy: 96, height: 92 })
  return { ops: [{ op: 'fill', path: rect, paint: solid(C('violet')) }, ...markOps(mark, { head: C('glyph'), eyes: C('violet') })], width: W, height: H }
}

// ---------------------------------------------------------------------------
// Icon Composer layers (branding/official/Atelier.icon). 1024-point canvas; the system
// supplies the squircle mask, glass and shadows.

/** The mark where the macOS icon puts it, scaled from the 824 body up to the full 1024 canvas around the centre. */
export function iconComposerLayers() {
  const size = 1024
  const { body } = layout(size, 'mac')
  const mark = markShapes({ cx: 512, cy: 512 + size * MARK_DROP, height: size * markShare(body) })
  return { size, mark }
}
