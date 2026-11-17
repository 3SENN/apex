#!/usr/bin/env node
/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// The unofficial branding's icons (branding/unofficial/; TRADEMARKS.md), all
// drawn from one SVG: branding/unofficial/icon.svg, a neutral rounded tile
// with a plain mark. Nothing of Apex's art is used.
//
//   node scripts/app-icons/unofficial.mjs           write the icons (in place)
//   node scripts/app-icons/unofficial.mjs --check   exit 1 if any is missing or stale
//
// The same files, sizes and formats as the official set
// (scripts/app-icons/generate.mjs), so electron-builder's config and the app
// take either folder: icon.icns, icon.ico, icon.png, icons/NxN.png, the
// document icons, the DMG and NSIS art, resources/ (the runtime icon and
// tray) and renderer/ (the in-app mark and icon). No Icon Composer document:
// macOS 26 draws icon.icns. It reuses the official pipeline's rasterizer and
// writers (lib/) and its manifest scheme (unofficial.manifest.json), so the
// output is the same on every machine.
//
// The SVG reader takes only what icon.svg holds: one <rect id="tile"> with
// rx, and <path> elements (absolute or relative M, L, H, V, C, Q, Z) with
// fill and fill-opacity inside <g id="mark">.

import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { generate, ICNS_SIZES, ICO_SIZES, LINUX_SIZES, LINUX_TRAY, MAC_TRAY, MARK_SIZES, REPO, RESOURCE_SIZES, TRAY_ICO_SIZES } from './generate.mjs'
import { writeBMP24 } from './lib/bmp.mjs'
import { Path, roundedRect, strokeOutline } from './lib/geometry.mjs'
import { ICNS_ORDER, ICNS_TYPES, writeICNS } from './lib/icns.mjs'
import { writeICO } from './lib/ico.mjs'
import { DMG, SIDEBAR, layout } from './lib/layout.mjs'
import { encodePNG } from './lib/png.mjs'
import { hex, render } from './lib/raster.mjs'
import { sceneToSVG } from './lib/svg.mjs'

export const DIR = 'branding/unofficial'
export const SOURCE = `${DIR}/icon.svg`
export const MANIFEST = 'scripts/app-icons/unofficial.manifest.json'
const ABOUT = 'The unofficial branding\'s icons, drawn from branding/unofficial/icon.svg by scripts/app-icons/unofficial.mjs. sha256 is the file; content is the decoded pixels (or text).'

// ---------------------------------------------------------------------------
// Reading the SVG.

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]))

/** SVG path data as a Path (absolute and relative M, L, H, V, C, Q, Z). */
export function parsePathData(d) {
  const tokens = d.match(/[MLHVCQZmlhvcqz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? []
  const path = new Path()
  let i = 0
  let cmd = ''
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  const num = () => {
    const v = Number(tokens[i++])
    if (!Number.isFinite(v)) throw new Error(`Bad number in path data near "${tokens[i - 1]}"`)
    return v
  }
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (cmd.toUpperCase()) {
      case 'M':
        x = ox + num()
        y = oy + num()
        path.moveTo(x, y)
        sx = x
        sy = y
        cmd = rel ? 'l' : 'L' // further pairs are lines
        break
      case 'L':
        x = ox + num()
        y = oy + num()
        path.lineTo(x, y)
        break
      case 'H':
        x = ox + num()
        path.lineTo(x, y)
        break
      case 'V':
        y = oy + num()
        path.lineTo(x, y)
        break
      case 'C': {
        const [x1, y1, x2, y2, x3, y3] = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()]
        path.cubicTo(x1, y1, x2, y2, x3, y3)
        x = x3
        y = y3
        break
      }
      case 'Q': {
        const [qx, qy, x3, y3] = [ox + num(), oy + num(), ox + num(), oy + num()]
        path.cubicTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x3 + (2 / 3) * (qx - x3), y3 + (2 / 3) * (qy - y3), x3, y3)
        x = x3
        y = y3
        break
      }
      case 'Z':
        path.close()
        x = sx
        y = sy
        break
      default:
        throw new Error(`Path command "${cmd}" isn't supported here`)
    }
  }
  return path
}

/** icon.svg's tile and mark: { tile: { x, y, w, h, rx, color }, mark: [{ path, color }] }. */
export function readSource(text) {
  const tileTag = /<rect\b[^>]*\bid="tile"[^>]*>/.exec(text)?.[0]
  if (!tileTag) throw new Error(`${SOURCE} has no <rect id="tile">`)
  const t = attrs(tileTag)
  const tile = { x: Number(t.x ?? 0), y: Number(t.y ?? 0), w: Number(t.width), h: Number(t.height), rx: Number(t.rx ?? 0), color: hex(t.fill ?? '#000000') }
  if (![tile.x, tile.y, tile.w, tile.h, tile.rx].every(Number.isFinite) || tile.w <= 0 || tile.h <= 0) throw new Error(`${SOURCE}: the tile needs x, y, width, height and rx`)
  const group = /<g\b([^>]*\bid="mark"[^>]*)>([\s\S]*?)<\/g>/.exec(text)
  if (!group) throw new Error(`${SOURCE} has no <g id="mark">`)
  const g = attrs(group[1])
  const mark = [...group[2].matchAll(/<path\b[^>]*>/g)].map(([tag]) => {
    const a = attrs(tag)
    if (!a.d) throw new Error(`${SOURCE}: a mark path has no d`)
    return { path: parsePathData(a.d), fill: a.fill ?? g.fill ?? '#ffffff', opacity: Number(a['fill-opacity'] ?? g['fill-opacity'] ?? 1) }
  })
  if (mark.length === 0) throw new Error(`${SOURCE}: the mark has no paths`)
  return { tile, mark }
}

let source = null
const art = () => (source ??= readSource(readFileSync(join(REPO, SOURCE), 'utf8')))

// ---------------------------------------------------------------------------
// Scenes, in pixels for the size asked (as art.mjs's are).

const solid = (color) => ({ type: 'solid', color })
const INK = hex('#20242a')
const PAPER = hex('#ffffff')

/** The mark's paths moved by `fn` ([x, y] → [x, y]) and filled with `ink` (or their own fill), keeping each path's opacity. */
function markOps(fn, ink) {
  return art().mark.map(({ path, fill, opacity }) => ({ op: 'fill', path: path.map((x, y) => fn([x, y])), paint: solid(ink ? [ink[0], ink[1], ink[2], ink[3] * opacity] : hex(fill, opacity)) }))
}

/** The mark grows a little inside the tile at small sizes, so it still reads at 16 px. */
const markGrow = (size) => (size <= 20 ? 1.18 : size <= 40 ? 1.1 : 1)

/** The app icon: `style` 'mac' (Apple's grid, a soft shadow) or 'flat' (the tile nearly fills the canvas). */
export function appIcon(size, { style = 'mac' } = {}) {
  const { tile } = art()
  const { inset, body } = layout(size, style)
  const k = body / tile.w
  const to = ([x, y]) => [inset + (x - tile.x) * k, inset + (y - tile.y) * k]
  const tilePath = roundedRect(inset, inset, body, tile.h * k, tile.rx * k)
  const ops = []
  if (style === 'mac' && size >= 64) ops.push({ op: 'shadow', path: tilePath, color: hex('#000000', 0.28), sigma: size * 0.011, dy: size * 0.012 })
  ops.push({ op: 'fill', path: tilePath, paint: solid(tile.color) })
  const g = markGrow(size)
  const c = size / 2
  ops.push(...markOps(([x, y]) => {
    const [px, py] = to([x, y])
    return [c + (px - c) * g, c + (py - c) * g]
  }))
  return ops
}

/** The mark alone, fitted to the canvas with `pad` px around it, in `ink`. */
function markAlone(size, ink, pad = size <= 20 ? 0.5 : 1) {
  const b = art().mark.reduce((acc, { path }) => {
    const r = path.bounds()
    return { x0: Math.min(acc.x0, r.x0), y0: Math.min(acc.y0, r.y0), x1: Math.max(acc.x1, r.x1), y1: Math.max(acc.y1, r.y1) }
  }, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity })
  const k = (size - pad * 2) / Math.max(b.x1 - b.x0, b.y1 - b.y0)
  const ox = (size - (b.x1 - b.x0) * k) / 2
  const oy = (size - (b.y1 - b.y0) * k) / 2
  return markOps(([x, y]) => [ox + (x - b.x0) * k, oy + (y - b.y0) * k], ink)
}

/** A page with a folded corner, in greys. */
function page(size, style) {
  let h = style === 'mac' ? size * 0.86 : size * 0.94
  let w = h * 0.78
  if (size < 64) {
    h = Math.round(h)
    w = Math.round(w)
  }
  const x = size < 64 ? Math.floor((size - w) / 2) : (size - w) / 2
  const y = size < 64 ? Math.floor((size - h) / 2) : (size - h) / 2
  const fold = w * 0.28
  const outline = new Path().moveTo(x, y).lineTo(x + w - fold, y).lineTo(x + w, y + fold).lineTo(x + w, y + h).lineTo(x, y + h).close()
  const flap = new Path().moveTo(x + w - fold, y).lineTo(x + w - fold, y + fold).lineTo(x + w, y + fold).close()
  const edge = Math.max(1, size / 256)
  const inner = outline.map((px, py) => [x + edge + ((px - x) * (w - 2 * edge)) / w, y + edge + ((py - y) * (h - 2 * edge)) / h])
  const ops = []
  if (style === 'mac' && size >= 64) ops.push({ op: 'shadow', path: outline, color: hex('#000000', 0.2), sigma: size * 0.01, dy: size * 0.01 })
  ops.push({ op: 'fill', path: outline, paint: solid(hex(size < 48 ? '#b4b8bf' : '#d5d8dd')) })
  ops.push({ op: 'fill', path: inner, paint: solid(PAPER) })
  ops.push({ op: 'fill', path: flap, paint: solid(hex('#e8eaed')) })
  return { x, y, w, h, ops }
}

/** A document icon: the page, text lines for web pages, and the app icon as its badge. */
export function documentIcon(size, { style = 'mac', lines = false } = {}) {
  const p = page(size, style)
  const ops = p.ops
  if (lines && size >= 48) {
    const lh = Math.max(1, p.h * 0.035)
    ;[0.5, 0.68, 0.6].forEach((f, i) => ops.push({ op: 'fill', path: roundedRect(p.x + p.w * 0.16, p.y + p.h * (0.13 + i * 0.085), p.w * f, lh, lh / 2), paint: solid(hex('#cfd3d9')) }))
  }
  const small = size < 48
  const t = Math.round(small ? p.w * 0.9 : p.w * 0.62)
  const tx = Math.round(p.x + (p.w - t) / 2)
  const ty = Math.round(p.y + p.h * (small ? 0.34 : lines ? 0.45 : 0.36))
  for (const op of appIcon(t, { style: 'flat' })) ops.push({ ...op, path: op.path.translate(tx, ty) })
  return ops
}

/** The DMG window's background: a quiet grey ground and a chevron from the app to Applications. */
function dmgBackground(scale) {
  const W = DMG.width * scale
  const H = DMG.height * scale
  const rect = new Path().moveTo(0, 0).lineTo(W, 0).lineTo(W, H).lineTo(0, H).close()
  const [ax, ay] = [(DMG.app[0] + DMG.applications[0]) / 2, DMG.app[1]]
  const arm = 14
  const chevron = strokeOutline([[(ax - arm * 0.55) * scale, (ay - arm) * scale], [(ax + arm * 0.55) * scale, ay * scale], [(ax - arm * 0.55) * scale, (ay + arm) * scale]], 3.2 * scale)
  const ops = [
    { op: 'fill', path: rect, paint: { type: 'linear', x1: 0, y1: 0, x2: 0, y2: H, stops: [{ at: 0, color: hex('#f5f6f7') }, { at: 1, color: hex('#e9ebee') }] } },
    { op: 'fill', path: chevron, paint: solid(hex('#a3a9b1')) }
  ]
  return encodePNG(W, H, render(ops, W, H).toRGBA8())
}

/** The NSIS sidebar: the tile's colour with the mark near the top. */
function installerSidebar() {
  const { width: W, height: H } = SIDEBAR
  const rect = new Path().moveTo(0, 0).lineTo(W, 0).lineTo(W, H).lineTo(0, H).close()
  const size = 96
  const ops = [{ op: 'fill', path: rect, paint: solid(art().tile.color) }, ...markAlone(size, null).map((op) => ({ ...op, path: op.path.translate((W - size) / 2, 48) }))]
  return writeBMP24(W, H, render(ops, W, H).toRGB8Over([1, 1, 1]))
}

const SCENES = {
  mac: (s) => appIcon(s, { style: 'mac' }),
  flat: (s) => appIcon(s, { style: 'flat' }),
  template: (s) => markAlone(s, hex('#000000')),
  trayLight: (s) => markAlone(s, INK),
  trayDark: (s) => markAlone(s, PAPER),
  htmlMac: (s) => documentIcon(s, { style: 'mac', lines: true }),
  htmlFlat: (s) => documentIcon(s, { style: 'flat', lines: true }),
  docMac: (s) => documentIcon(s, { style: 'mac' }),
  docFlat: (s) => documentIcon(s, { style: 'flat' })
}

const cache = new Map()
function img(scene, size) {
  const key = `${scene}@${size}`
  if (!cache.has(key)) cache.set(key, render(SCENES[scene](size), size, size).toRGBA8())
  return cache.get(key)
}
const png = (scene, size) => encodePNG(size, size, img(scene, size))
const ico = (scene, sizes) => writeICO(sizes.map((size) => ({ size, pixels: img(scene, size) })))
const icns = (scene) => writeICNS(new Map(ICNS_ORDER.map((type) => [ICNS_TYPES[type].size, img(scene, ICNS_TYPES[type].size)])))
const svg = (scene, size, title) => sceneToSVG(SCENES[scene](size), size, size, { prefix: `summit-${scene}`, title })

// ---------------------------------------------------------------------------
// Targets: the official set's files and sizes (generate.mjs), from this art.

const at = (p) => `${DIR}/${p}`

export const TARGETS = [
  { path: at('icon.icns'), kind: 'icns', images: ICNS_SIZES, build: () => icns('mac') },
  { path: at('icon.ico'), kind: 'ico', images: ICO_SIZES, build: () => ico('flat', ICO_SIZES) },
  { path: at('icon.png'), kind: 'png', images: [1024], build: () => png('flat', 1024) },
  ...LINUX_SIZES.map((s) => ({ path: at(`icons/${s}x${s}.png`), kind: 'png', images: [s], build: () => png('flat', s) })),
  { path: at('html-document.icns'), kind: 'icns', images: ICNS_SIZES, build: () => icns('htmlMac') },
  { path: at('html-document.ico'), kind: 'ico', images: ICO_SIZES, build: () => ico('htmlFlat', ICO_SIZES) },
  ...['apexcompanion', 'apexpack'].flatMap((name) => [
    { path: at(`${name}.icns`), kind: 'icns', images: ICNS_SIZES, build: () => icns('docMac') },
    { path: at(`${name}.ico`), kind: 'ico', images: ICO_SIZES, build: () => ico('docFlat', ICO_SIZES) },
    { path: at(`${name}.png`), kind: 'png', images: [512], build: () => png('docFlat', 512) }
  ]),
  { path: at('dmg-background.png'), kind: 'png', images: [[DMG.width, DMG.height]], build: () => dmgBackground(1) },
  { path: at('dmg-background@2x.png'), kind: 'png', images: [[DMG.width * 2, DMG.height * 2]], build: () => dmgBackground(2) },
  { path: at('installerSidebar.bmp'), kind: 'bmp', images: [[SIDEBAR.width, SIDEBAR.height]], build: () => installerSidebar() },
  ...RESOURCE_SIZES.map((s) => ({ path: at(`resources/icons/app-${s}.png`), kind: 'png', images: [s], build: () => png('mac', s) })),
  { path: at('resources/tray/trayTemplate.png'), kind: 'png', images: [MAC_TRAY.size], template: true, build: () => png('template', MAC_TRAY.size) },
  { path: at('resources/tray/trayTemplate@2x.png'), kind: 'png', images: [MAC_TRAY.size * 2], template: true, build: () => png('template', MAC_TRAY.size * 2) },
  { path: at('resources/tray/tray-light.ico'), kind: 'ico', images: TRAY_ICO_SIZES, build: () => ico('trayLight', TRAY_ICO_SIZES) },
  { path: at('resources/tray/tray-dark.ico'), kind: 'ico', images: TRAY_ICO_SIZES, build: () => ico('trayDark', TRAY_ICO_SIZES) },
  { path: at('resources/tray/tray.png'), kind: 'png', images: [LINUX_TRAY.size], build: () => png('flat', LINUX_TRAY.size) },
  { path: at('resources/tray/tray@2x.png'), kind: 'png', images: [LINUX_TRAY.size * 2], build: () => png('flat', LINUX_TRAY.size * 2) },
  // The in-app mark is the flat tile: it reads on light and dark grounds alike.
  ...MARK_SIZES.map((s) => ({ path: at(`renderer/mark-${s}.png`), kind: 'png', images: [s], build: () => png('flat', s) })),
  { path: at('renderer/app-icon-128.png'), kind: 'png', images: [128], build: () => png('mac', 128) },
  { path: at('svg/icon-mac.svg'), kind: 'svg', images: [], build: () => svg('mac', 1024, 'Summit') },
  { path: at('svg/tray-template.svg'), kind: 'svg', images: [], build: () => svg('template', MAC_TRAY.size * 2, 'Summit') }
]

/** Writes (or checks) the unofficial icons; returns generate()'s result. */
export function generateUnofficial({ out = REPO, check = false, log = () => {} } = {}) {
  return generate({ out, check, log, releaseArt: true, targets: TARGETS, manifest: MANIFEST, about: ABOUT })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const check = process.argv.includes('--check')
  const started = Date.now()
  const r = generateUnofficial({ check, log: process.argv.includes('--quiet') ? () => {} : (m) => console.log(m) })
  if (r.problems.length) {
    for (const p of r.problems) console.error(`✗ ${p}`)
    console.error(check ? 'The unofficial icons are out of date: run node scripts/app-icons/unofficial.mjs' : 'Icon generation found problems.')
    process.exit(1)
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.log(check ? `Unofficial icons up to date (${r.unchanged.length} files, ${secs}s).` : `Unofficial icons: ${r.written.length} written, ${r.unchanged.length} unchanged, under ${relative(process.cwd(), join(REPO, DIR)) || '.'} (${secs}s).`)
}
