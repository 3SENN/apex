#!/usr/bin/env node
/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// Apex's app icon set, generated from code: the official branding's art,
// written into branding/official/ (the unofficial branding's plain icons come
// from scripts/app-icons/unofficial.mjs).
//
//   node scripts/app-icons/generate.mjs                 write the icon set (in place)
//   node scripts/app-icons/generate.mjs --check         exit 1 if any output is missing or stale
//   node scripts/app-icons/generate.mjs --release-art   also write the installer and document art
//   node scripts/app-icons/generate.mjs --out <dir>     write under <dir> instead of the repo root
//   node scripts/app-icons/generate.mjs --previews <dir>  write the logo variants and size sheets for review
//
// The logo is the brand mark: Pip drawn flat, with its sprout and two smiling
// eyes, as vector shapes in art.mjs (the same grid as apexbrowser.eu's
// mark.svg). The app icon is the mark in white on a flat violet tile. The
// companion and pack documents show the companions themselves: render-pip.mjs
// renders those with the app's own companion renderer into branding/official/art/,
// where they are committed. The art lives in art.mjs (the mark, the tile, trays,
// documents, installer art, the in-app mark) and iconbundle.mjs
// (Apex.icon for Icon Composer). lib/ holds a small rasterizer with
// area-averaged bitmap resampling, and the PNG, ICNS, ICO and BMP writers, so
// nothing here needs Electron, a GPU, ImageMagick or macOS. The same sources
// give the same pixels on every machine.
//
// Every output is listed in TARGETS below, with its sizes. manifest.json
// records, per file, the bytes' sha256 and a hash of the decoded pixels. A
// file is rewritten only when its pixels change, so a regenerate on another
// machine (whose zlib may compress differently) leaves the committed files
// alone.
//
// Outputs (under branding/official/) and who reads them:
//   icon.icns                  macOS app icon, 16 to 1024 px (fallback before macOS 26)
//   Apex.icon/                 macOS 26 Icon Composer document (light, dark, tinted, clear)
//   icon.ico                   Windows app, installer and uninstaller icon
//   icon.png                   1024 px, electron-builder's common icon
//   icons/NxN.png              Linux hicolor set
//   html-document.ico          Windows icon for .html files Apex opens
//   apexcompanion.ico          Windows icon for exported companions
//   apexpack.ico               Windows icon for packs (docs/packs.md): the group picture
//   resources/icons/app-N.png  runtime: the standard Apex icon (the Dock's fallback in development)
//   renderer/mark-N.png        the in-app mark (BrandMark)
//   renderer/app-icon-128.png  the standard icon in Settings › Dock icon
//   resources/tray/trayTemplate.png, trayTemplate@2x.png
//                              macOS menu bar, template images (black and alpha; macOS
//                              tints them for light and dark menu bars)
//   resources/tray/tray-light.ico  Windows notification area, for a light taskbar (dark glyph)
//   resources/tray/tray-dark.ico   Windows notification area, for a dark taskbar (light glyph)
//   resources/tray/tray.png, tray@2x.png  Linux tray (the tile, readable on any panel)
//   svg/*.svg                  the art as SVG, for review and editing tools
// With --release-art (`npm run icons`; electron-builder.yml packages these, and a
// plain run keeps them current once they exist):
//   html-document.icns, apexcompanion.icns, apexcompanion.png,
//   apexpack.icns, apexpack.png
//   dmg-background.png, dmg-background@2x.png  (540×380 pt window)
//   installerSidebar.bmp  (NSIS welcome and finish pages, 164×314)

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as art from './art.mjs'
import { buildIconBundle, BUNDLE_FILES } from './iconbundle.mjs'
import { writeBMP24, readBMP24 } from './lib/bmp.mjs'
import { readICNS, writeICNS, ICNS_ORDER, ICNS_TYPES } from './lib/icns.mjs'
import { readICO, writeICO } from './lib/ico.mjs'
import { decodePNG, encodePNG } from './lib/png.mjs'
import { render } from './lib/raster.mjs'
import { sceneToSVG } from './lib/svg.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..', '..')
export const MANIFEST = 'scripts/app-icons/manifest.json'
/** The official branding's folder, where every output goes (TRADEMARKS.md; scripts/branding.mjs). */
export const OFFICIAL = 'branding/official'

// One per icns entry: 16, 16@2x, 32, 32@2x, 128, 128@2x, 256, 256@2x, 512, 512@2x.
export const ICNS_SIZES = [16, 32, 32, 64, 128, 256, 256, 512, 512, 1024]
export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 256]
export const LINUX_SIZES = [16, 22, 24, 32, 48, 64, 96, 128, 256, 512]
export const RESOURCE_SIZES = [32, 64, 128, 256, 512]
export const TRAY_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64]
/** The in-app mark (src/renderer/src/brand/BrandLogo.tsx picks one by its drawn size). */
export const MARK_SIZES = [32, 64, 128]
export const MAC_TRAY = { size: 18 } // points; @2x is 36 px
export const LINUX_TRAY = { size: 24 }

// ---------------------------------------------------------------------------
// Rendering, cached per scene and size.

const cache = new Map()

function pixels(key, size, build) {
  const k = `${key}@${size}`
  if (!cache.has(k)) cache.set(k, render(build(size), size, size).toRGBA8())
  return cache.get(k)
}

const SCENES = {
  mac: (s) => art.appIcon(s, { style: 'mac' }),
  flat: (s) => art.appIcon(s, { style: 'flat' }),
  macDark: (s) => art.appIcon(s, { style: 'mac', appearance: 'dark' }),
  // A preview variant (writePreviews): the mark in its own colours on a white tile.
  macLight: (s) => art.appIcon(s, { style: 'mac', ground: 'light' }),
  mark: (s) => art.brandMark(s),
  template: (s) => art.trayTemplate(s),
  trayLight: (s) => art.trayWindows(s, 'light'),
  trayDark: (s) => art.trayWindows(s, 'dark'),
  htmlMac: (s) => art.htmlDocument(s, { style: 'mac' }),
  htmlFlat: (s) => art.htmlDocument(s, { style: 'flat' }),
  companionMac: (s) => art.companionDocument(s, { style: 'mac' }),
  companionFlat: (s) => art.companionDocument(s, { style: 'flat' }),
  packMac: (s) => art.packDocument(s, { style: 'mac' }),
  packFlat: (s) => art.packDocument(s, { style: 'flat' })
}

const img = (scene, size) => pixels(scene, size, SCENES[scene])

function icns(scene) {
  const images = new Map()
  for (const type of ICNS_ORDER) {
    const { size } = ICNS_TYPES[type]
    images.set(size, img(scene, size))
  }
  return writeICNS(images)
}

const ico = (scene, sizes) => writeICO(sizes.map((size) => ({ size, pixels: img(scene, size) })))
const png = (scene, size) => encodePNG(size, size, img(scene, size))

function svg(scene, size, title) {
  return sceneToSVG(SCENES[scene](size), size, size, { prefix: scene, title })
}

// ---------------------------------------------------------------------------
// Targets. kind: png | icns | ico | bmp | svg | json. `images` are the pixel
// sizes the file must hold. `release` targets are written only with
// --release-art.

export const TARGETS = [
  { path: `${OFFICIAL}/icon.icns`, kind: 'icns', images: ICNS_SIZES, build: () => icns('mac') },
  { path: `${OFFICIAL}/icon.ico`, kind: 'ico', images: ICO_SIZES, build: () => ico('flat', ICO_SIZES) },
  { path: `${OFFICIAL}/icon.png`, kind: 'png', images: [1024], build: () => png('flat', 1024) },
  ...LINUX_SIZES.map((s) => ({ path: `${OFFICIAL}/icons/${s}x${s}.png`, kind: 'png', images: [s], build: () => png('flat', s) })),
  ...BUNDLE_FILES.map(([p, kind]) => ({ path: `${OFFICIAL}/Apex.icon/${p}`, kind, images: kind === 'png' ? [1024] : [], build: () => iconBundleFile(p) })),
  { path: `${OFFICIAL}/html-document.ico`, kind: 'ico', images: ICO_SIZES, build: () => ico('htmlFlat', ICO_SIZES) },
  { path: `${OFFICIAL}/apexcompanion.ico`, kind: 'ico', images: ICO_SIZES, build: () => ico('companionFlat', ICO_SIZES) },
  { path: `${OFFICIAL}/apexpack.ico`, kind: 'ico', images: ICO_SIZES, build: () => ico('packFlat', ICO_SIZES) },
  ...RESOURCE_SIZES.map((s) => ({ path: `${OFFICIAL}/resources/icons/app-${s}.png`, kind: 'png', images: [s], build: () => png('mac', s) })),
  ...MARK_SIZES.map((s) => ({ path: `${OFFICIAL}/renderer/mark-${s}.png`, kind: 'png', images: [s], build: () => png('mark', s) })),
  { path: `${OFFICIAL}/renderer/app-icon-128.png`, kind: 'png', images: [128], build: () => png('mac', 128) },
  { path: `${OFFICIAL}/resources/tray/trayTemplate.png`, kind: 'png', images: [MAC_TRAY.size], template: true, build: () => png('template', MAC_TRAY.size) },
  { path: `${OFFICIAL}/resources/tray/trayTemplate@2x.png`, kind: 'png', images: [MAC_TRAY.size * 2], template: true, build: () => png('template', MAC_TRAY.size * 2) },
  { path: `${OFFICIAL}/resources/tray/tray-light.ico`, kind: 'ico', images: TRAY_ICO_SIZES, build: () => ico('trayLight', TRAY_ICO_SIZES) },
  { path: `${OFFICIAL}/resources/tray/tray-dark.ico`, kind: 'ico', images: TRAY_ICO_SIZES, build: () => ico('trayDark', TRAY_ICO_SIZES) },
  { path: `${OFFICIAL}/resources/tray/tray.png`, kind: 'png', images: [LINUX_TRAY.size], build: () => png('flat', LINUX_TRAY.size) },
  { path: `${OFFICIAL}/resources/tray/tray@2x.png`, kind: 'png', images: [LINUX_TRAY.size * 2], build: () => png('flat', LINUX_TRAY.size * 2) },
  { path: `${OFFICIAL}/svg/apex-icon-mac.svg`, kind: 'svg', images: [], build: () => svg('mac', 1024, 'Apex') },
  { path: `${OFFICIAL}/svg/apex-icon-mac-dark.svg`, kind: 'svg', images: [], build: () => svg('macDark', 1024, 'Apex') },
  { path: `${OFFICIAL}/svg/apex-icon-flat.svg`, kind: 'svg', images: [], build: () => svg('flat', 1024, 'Apex') },
  { path: `${OFFICIAL}/svg/tray-template.svg`, kind: 'svg', images: [], build: () => svg('template', MAC_TRAY.size * 2, 'Apex') },
  { path: `${OFFICIAL}/svg/html-document.svg`, kind: 'svg', images: [], build: () => svg('htmlMac', 1024, 'HTML document') },
  { path: `${OFFICIAL}/svg/apexcompanion.svg`, kind: 'svg', images: [], build: () => svg('companionMac', 1024, 'Apex companion') },
  { path: `${OFFICIAL}/svg/apexpack.svg`, kind: 'svg', images: [], build: () => svg('packMac', 1024, 'Apex pack') },
  // The installer and document art electron-builder.yml packages; written with --release-art.
  { path: `${OFFICIAL}/html-document.icns`, kind: 'icns', images: ICNS_SIZES, release: true, build: () => icns('htmlMac') },
  { path: `${OFFICIAL}/apexcompanion.icns`, kind: 'icns', images: ICNS_SIZES, release: true, build: () => icns('companionMac') },
  { path: `${OFFICIAL}/apexcompanion.png`, kind: 'png', images: [512], release: true, build: () => png('companionFlat', 512) },
  { path: `${OFFICIAL}/apexpack.icns`, kind: 'icns', images: ICNS_SIZES, release: true, build: () => icns('packMac') },
  { path: `${OFFICIAL}/apexpack.png`, kind: 'png', images: [512], release: true, build: () => png('packFlat', 512) },
  { path: `${OFFICIAL}/dmg-background.png`, kind: 'png', images: [[art.DMG.width, art.DMG.height]], release: true, build: () => dmg(1) },
  { path: `${OFFICIAL}/dmg-background@2x.png`, kind: 'png', images: [[art.DMG.width * 2, art.DMG.height * 2]], release: true, build: () => dmg(2) },
  { path: `${OFFICIAL}/installerSidebar.bmp`, kind: 'bmp', images: [[art.SIDEBAR.width, art.SIDEBAR.height]], release: true, build: () => sidebar() }
]

let bundle = null
function iconBundleFile(p) {
  bundle ??= buildIconBundle()
  const c = bundle.get(p)
  if (c == null) throw new Error(`Apex.icon has no ${p}`)
  return c
}

function dmg(scale) {
  const { ops, width, height } = art.dmgBackground(scale)
  return encodePNG(width, height, render(ops, width, height).toRGBA8())
}

function sidebar() {
  const { ops, width, height } = art.installerSidebar()
  return writeBMP24(width, height, render(ops, width, height).toRGB8Over([1, 1, 1]))
}

// ---------------------------------------------------------------------------
// Reading outputs back, and hashing what they show.

/** Decodes a file of a given kind into [{ width, height, pixels }] (empty for text). */
export function decode(kind, buf) {
  switch (kind) {
    case 'png':
      return [decodePNG(buf)]
    case 'icns':
      return readICNS(buf).map(({ width, height, pixels, type }) => ({ width, height, pixels, type }))
    case 'ico':
      return readICO(buf)
    case 'bmp':
      return [readBMP24(buf)]
    case 'svg':
    case 'json':
      return []
    default:
      throw new Error(`Unknown kind ${kind}`)
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/**
 * A hash of what a file shows: the decoded pixels for images, the bytes for
 * text. Two encodings of the same pixels hash the same, so does an SVG whose
 * embedded PNGs another machine's zlib compressed differently: each data URI
 * counts as its pixels.
 */
export function contentHash(kind, buf) {
  if (kind === 'json') return sha256(buf)
  if (kind === 'svg') return svgContentHash(buf.toString('utf8'))
  const h = createHash('sha256')
  for (const im of decode(kind, buf)) {
    h.update(`${im.width}x${im.height}\n`)
    h.update(im.pixels)
  }
  return h.digest('hex')
}

function svgContentHash(text) {
  const h = createHash('sha256')
  let last = 0
  for (const m of text.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)) {
    h.update(text.slice(last, m.index))
    const im = decodePNG(Buffer.from(m[1], 'base64'))
    h.update(`png ${im.width}x${im.height}\n`)
    h.update(im.pixels)
    last = m.index + m[0].length
  }
  h.update(text.slice(last))
  return h.digest('hex')
}

/** The [width, height] pairs a file holds, smallest first. */
export function imageSizes(kind, buf) {
  return decode(kind, buf)
    .map((im) => [im.width, im.height])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

export function expectedSizes(target) {
  return target.images.map((s) => (Array.isArray(s) ? s : [s, s])).sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

/** Builds one target's bytes. */
export function buildTarget(target) {
  const out = target.build()
  return Buffer.isBuffer(out) ? out : Buffer.from(out, 'utf8')
}

// ---------------------------------------------------------------------------
// Previews: the logo variants and the small sizes, for review (not shipped).

/** Pastes straight-alpha RGBA8 images onto an opaque ground; `zoom` enlarges by whole pixels. */
function contactSheet(width, height, ground, items) {
  const out = new Uint8Array(width * height * 4)
  for (let i = 0; i < out.length; i += 4) out.set([...ground, 255], i)
  for (const { pixels, size, x, y, zoom = 1 } of items) {
    for (let py = 0; py < size * zoom; py++) {
      for (let px = 0; px < size * zoom; px++) {
        const j = (Math.floor(py / zoom) * size + Math.floor(px / zoom)) * 4
        const a = pixels[j + 3] / 255
        const o = ((y + py) * width + x + px) * 4
        for (let c = 0; c < 3; c++) out[o + c] = Math.round(pixels[j + c] * a + out[o + c] * (1 - a))
      }
    }
  }
  return encodePNG(width, height, out)
}

export const VARIANTS = {
  a: { title: 'A: the mark in white on violet (the icon)', scene: 'mac' },
  b: { title: 'B: the mark on a dark tile (macOS dark)', scene: 'macDark' },
  c: { title: 'C: the mark in its own colours on a white tile', scene: 'macLight' }
}

/** Writes the variant previews and size sheets into `dir`; returns the file names. */
export function writePreviews(dir) {
  mkdirSync(dir, { recursive: true })
  const files = []
  const put = (name, buf) => {
    writeFileSync(join(dir, name), buf)
    files.push(name)
  }
  for (const [key, v] of Object.entries(VARIANTS)) put(`variant-${key}.png`, png(v.scene, 1024))
  // Each variant small: 16, 32, 64, 128, and 16 and 32 enlarged eight and four times, on light and dark.
  const sizes = [16, 32, 64, 128]
  for (const [key, v] of Object.entries(VARIANTS)) {
    for (const [mode, ground] of [['light', [246, 245, 250]], ['dark', [30, 28, 36]]]) {
      const items = []
      let x = 24
      for (const s of sizes) {
        items.push({ pixels: img(v.scene, s), size: s, x, y: 24 + (128 - s) })
        x += s + 24
      }
      items.push({ pixels: img(v.scene, 16), size: 16, x, y: 24, zoom: 8 })
      x += 128 + 24
      items.push({ pixels: img(v.scene, 32), size: 32, x, y: 24, zoom: 4 })
      x += 128 + 24
      put(`variant-${key}-sizes-${mode}.png`, contactSheet(x, 176, ground, items))
    }
  }
  // The tray and the documents.
  const tray = [
    { pixels: img('template', 18), size: 18, x: 24, y: 24 },
    { pixels: img('template', 36), size: 36, x: 60, y: 24 },
    { pixels: img('template', 36), size: 36, x: 120, y: 24, zoom: 4 },
    { pixels: img('trayDark', 32), size: 32, x: 288, y: 24, zoom: 4 }
  ]
  put('tray-light.png', contactSheet(440, 192, [236, 236, 240], tray))
  put('tray-dark.png', contactSheet(440, 192, [40, 40, 44], tray.slice(0, 3).map((t) => ({ ...t, pixels: invert(t.pixels) })).concat(tray[3])))
  put('documents.png', contactSheet(24 + 3 * (256 + 24), 304, [246, 245, 250], [
    { pixels: img('htmlMac', 256), size: 256, x: 24, y: 24 },
    { pixels: img('companionMac', 256), size: 256, x: 304, y: 24 },
    { pixels: img('htmlFlat', 32), size: 32, x: 584, y: 24, zoom: 4 },
    { pixels: img('companionFlat', 32), size: 32, x: 584, y: 160, zoom: 4 }
  ]))
  put('dmg-background.png', dmg(2))
  const side = art.installerSidebar()
  put('installer-sidebar.png', encodePNG(side.width, side.height, render(side.ops, side.width, side.height).toRGBA8()))
  return files
}

/** A template image as macOS shows it on a dark menu bar (white). */
function invert(pixels) {
  const out = Uint8Array.from(pixels)
  for (let i = 0; i < out.length; i += 4) out[i] = out[i + 1] = out[i + 2] = 255
  return out
}

// ---------------------------------------------------------------------------
// CLI.

function parseArgs(argv) {
  const opts = { check: false, releaseArt: false, out: REPO, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') opts.check = true
    else if (a === '--release-art') opts.releaseArt = true
    else if (a === '--quiet') opts.quiet = true
    else if (a === '--out') opts.out = resolve(argv[++i])
    else if (a === '--previews') opts.previews = resolve(argv[++i])
    else if (a === '--help' || a === '-h') opts.help = true
    else throw new Error(`Unknown option ${a}`)
  }
  return opts
}

const ABOUT = 'Apex app icons, generated by scripts/app-icons/generate.mjs. sha256 is the file; content is the decoded pixels (or text).'

/**
 * Generates (or checks) every target under `out`. Returns
 * { written, unchanged, problems, manifest }. `targets`, `manifest` and
 * `about` default to the official set (scripts/app-icons/unofficial.mjs passes
 * its own).
 */
export function generate({ out = REPO, releaseArt = false, check = false, log = () => {}, targets: all = TARGETS, manifest: manifestFile = MANIFEST, about = ABOUT } = {}) {
  // Release art is included when asked for, or when it is already there (once
  // the release build has adopted it, a plain run keeps it current).
  const targets = all.filter((t) => !t.release || releaseArt || existsSync(join(out, t.path)))
  const written = []
  const unchanged = []
  const problems = []
  const files = {}
  for (const t of targets) {
    const bytes = buildTarget(t)
    const content = contentHash(t.kind, bytes)
    const sizes = imageSizes(t.kind, bytes)
    const want = expectedSizes(t)
    if (JSON.stringify(sizes) !== JSON.stringify(want)) {
      problems.push(`${t.path}: built with sizes ${JSON.stringify(sizes)}, expected ${JSON.stringify(want)}`)
    }
    const abs = join(out, t.path)
    let onDisk = null
    if (existsSync(abs)) {
      onDisk = readFileSync(abs)
      let same = false
      try {
        same = contentHash(t.kind, onDisk) === content
      } catch {
        same = false
      }
      if (same) {
        unchanged.push(t.path)
        files[t.path] = entry(t, onDisk, content, sizes)
        continue
      }
    }
    if (check) {
      problems.push(onDisk ? `${t.path}: out of date` : `${t.path}: missing`)
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, bytes)
    written.push(t.path)
    files[t.path] = entry(t, bytes, content, sizes)
    log(`wrote ${t.path}`)
  }
  const manifest = {
    about,
    files: Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]))
  }
  const manifestPath = join(out, manifestFile)
  const manifestText = JSON.stringify(manifest, null, 2) + '\n'
  const prev = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null
  if (check) {
    if (prev !== manifestText) problems.push(`${manifestFile}: out of date`)
  } else if (prev !== manifestText) {
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeFileSync(manifestPath, manifestText)
  }
  return { written, unchanged, problems, manifest }
}

function entry(t, bytes, content, sizes) {
  return { kind: t.kind, bytes: bytes.length, sha256: sha256(bytes), content, sizes, ...(t.release ? { release: true } : {}) }
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    process.exit(2)
  }
  if (opts.help) {
    console.log('Usage: node scripts/app-icons/generate.mjs [--check] [--release-art] [--out <dir>] [--quiet] | --previews <dir>')
    return
  }
  const started = Date.now()
  if (opts.previews) {
    const files = writePreviews(opts.previews)
    console.log(`Previews: ${files.length} files in ${opts.previews} (${((Date.now() - started) / 1000).toFixed(1)}s).`)
    return
  }
  const log = opts.quiet ? () => {} : (m) => console.log(m)
  const r = generate({ out: opts.out, releaseArt: opts.releaseArt, check: opts.check, log })
  const rel = relative(process.cwd(), opts.out)
  const where = rel === '' ? '.' : rel.startsWith('..') ? opts.out : rel
  if (r.problems.length) {
    for (const p of r.problems) console.error(`✗ ${p}`)
    console.error(opts.check ? 'Icons are out of date: run node scripts/app-icons/generate.mjs' : 'Icon generation found problems.')
    process.exit(1)
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (opts.check) console.log(`Icons up to date (${r.unchanged.length} files, ${secs}s).`)
  else console.log(`Icons: ${r.written.length} written, ${r.unchanged.length} unchanged, under ${where} (${secs}s).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
