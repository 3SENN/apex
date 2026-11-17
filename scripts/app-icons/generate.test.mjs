/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// node --test scripts/app-icons/generate.test.mjs
//
// Checks Atelier's generated icon set: Pip's masters (for the companion and pack
// documents) are there and sound, every output exists with the right sizes,
// the manifest matches the files, the files match what the source draws
// today, two runs give identical bytes, the mark reads at 16 px, and the
// formats hold up (including iconutil and actool on macOS).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TARGETS,
  REPO,
  MANIFEST,
  ICO_SIZES,
  TRAY_ICO_SIZES,
  contentHash,
  decode,
  expectedSizes,
  generate,
  imageSizes
} from './generate.mjs'
import { readICNS, ICNS_ORDER, packBits, unpackBits } from './lib/icns.mjs'
import { readICO, writeICO } from './lib/ico.mjs'
import { decodePNG, encodePNG } from './lib/png.mjs'
import { readBMP24, writeBMP24 } from './lib/bmp.mjs'
import { Bitmap, faceLandmarks, resample, dilate } from './lib/bitmap.mjs'
import { MASTERS, pip } from './art.mjs'
import { checkMaster, MASTER_SIZE } from './render-pip.mjs'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const GENERATOR = join(HERE, 'generate.mjs')
const inLane = TARGETS.filter((t) => !t.release)
const read = (p) => readFileSync(join(REPO, p))
const alphaAt = (img, x, y) => img.pixels[(y * img.width + x) * 4 + 3]
const pixelAt = (img, x, y) => Array.from(img.pixels.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4))
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

// ---------------------------------------------------------------------------
// Pip's masters (render-pip.mjs), which everything is drawn from.

test('the masters are 1024 px renders of Pip on a clear ground', () => {
  for (const p of Object.values(MASTERS)) {
    assert.ok(existsSync(join(REPO, p)), `${p} is missing: run node scripts/app-icons/render-pip.mjs`)
    checkMaster(read(p), MASTER_SIZE)
  }
  const { head, full } = pip()
  // The full body is taller for its width than the head alone.
  assert.ok(full.box.h / full.box.w > head.box.h / head.box.w)
})

test('the head master has two eyes either side of the middle, above the mouth', () => {
  const { head, face } = pip()
  const mid = head.box.x + head.box.w / 2
  assert.ok(face.leftEye.cx < mid && face.rightEye.cx > mid)
  assert.ok(Math.abs(face.mouth.cx - mid) < head.box.w * 0.1)
  assert.ok(face.leftEye.cy < face.mouth.cy && face.rightEye.cy < face.mouth.cy)
  assert.ok(Math.abs(face.leftEye.cy - face.rightEye.cy) < head.box.h * 0.03, 'the eyes are level')
  assert.deepEqual(faceLandmarks(head), face)
})

test('area resampling keeps coverage and colour', () => {
  // A 4×4 opaque square to 2×2 stays opaque; a 2×2 checker of clear and
  // red to 1×1 is half-covered red.
  const solid = new Bitmap(4, 4, new Uint8Array(64).map((_, i) => (i % 4 === 3 ? 255 : 200)))
  const a = resample(solid, 2, 2, 0, 0, 2, 2)
  for (let i = 3; i < a.length; i += 4) assert.ok(Math.abs(a[i] - 1) < 1e-6)
  const px = new Uint8Array(16)
  px.set([255, 0, 0, 255], 0)
  px.set([255, 0, 0, 255], 12)
  const half = resample(new Bitmap(2, 2, px), 1, 1, 0, 0, 1, 1, { x: 0, y: 0, w: 2, h: 2 })
  assert.ok(Math.abs(half[3] - 0.5) < 1e-6 && Math.abs(half[0] - 0.5) < 1e-6 && half[1] === 0)
  // Placed half a pixel off the grid, the coverage splits across two pixels.
  const off = resample(solid, 3, 1, 0.5, 0, 1, 1)
  assert.ok(Math.abs(off[3] - 0.5) < 1e-6 && Math.abs(off[7] - 0.5) < 1e-6 && off[11] === 0)
  // A grown mask reaches its radius, with a soft edge (half strength at the radius), and no further.
  const dot = new Float32Array(25)
  dot[12] = 1
  const grown = dilate(dot, 5, 5, 1)
  assert.equal(grown[12], 1)
  assert.equal(grown[11], 0.5)
  assert.equal(grown[10], 0)
  assert.equal(dilate(dot, 5, 5, 1.5)[11], 1)
})

// ---------------------------------------------------------------------------
// The committed set.

test('every output exists with the right sizes', () => {
  for (const t of inLane) {
    const abs = join(REPO, t.path)
    assert.ok(existsSync(abs), `${t.path} is missing: run node scripts/app-icons/generate.mjs`)
    const buf = readFileSync(abs)
    assert.ok(buf.length > 0, `${t.path} is empty`)
    assert.deepEqual(imageSizes(t.kind, buf), expectedSizes(t), `${t.path} sizes`)
  }
})

test('every icon path the build and the tray rely on is present', () => {
  const want = [
    'branding/official/icon.icns',
    'branding/official/icon.ico',
    'branding/official/icon.png',
    'branding/official/Atelier.icon/icon.json',
    'branding/official/art/pip-head.png',
    'branding/official/art/pip-full.png',
    ...[32, 64, 128].map((s) => `branding/official/renderer/mark-${s}.png`),
    'branding/official/renderer/app-icon-128.png',
    ...[32, 64, 128, 256, 512].map((s) => `branding/official/resources/icons/app-${s}.png`),
    'branding/official/resources/tray/trayTemplate.png',
    'branding/official/resources/tray/trayTemplate@2x.png',
    'branding/official/resources/tray/tray-light.ico',
    'branding/official/resources/tray/tray-dark.ico',
    'branding/official/resources/tray/tray.png'
  ]
  for (const p of want) assert.ok(existsSync(join(REPO, p)), `${p} is missing`)
  const linux = readdirSync(join(REPO, 'branding/official/icons')).filter((f) => /^\d+x\d+\.png$/.test(f))
  assert.ok(linux.length >= 8, 'branding/official/icons holds the Linux hicolor set')
})

test('the manifest matches the files on disk', () => {
  const manifest = JSON.parse(read(MANIFEST).toString('utf8'))
  const listed = Object.keys(manifest.files).sort()
  const present = TARGETS.filter((t) => existsSync(join(REPO, t.path))).map((t) => t.path).sort()
  assert.deepEqual(listed, present, 'manifest lists exactly the outputs present')
  for (const [p, e] of Object.entries(manifest.files)) {
    const buf = read(p)
    assert.equal(e.bytes, buf.length, `${p} byte count`)
    assert.equal(e.sha256, sha256(buf), `${p} sha256`)
    assert.equal(e.content, contentHash(e.kind, buf), `${p} content hash`)
  }
})

test('the files are current: the source draws exactly these pixels', () => {
  const r = generate({ check: true })
  assert.deepEqual(r.problems, [], 'run node scripts/app-icons/generate.mjs')
})

// ---------------------------------------------------------------------------
// Determinism, including the release art, in throwaway folders.

test('two runs in separate processes give byte-identical files', () => {
  const a = mkdtempSync(join(tmpdir(), 'atelier-icons-a-'))
  const b = mkdtempSync(join(tmpdir(), 'atelier-icons-b-'))
  try {
    for (const dir of [a, b]) {
      const r = spawnSync(process.execPath, [GENERATOR, '--out', dir, '--release-art', '--quiet'], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    }
    for (const t of TARGETS) {
      const x = readFileSync(join(a, t.path))
      const y = readFileSync(join(b, t.path))
      assert.ok(x.equals(y), `${t.path} differs between runs`)
      assert.deepEqual(imageSizes(t.kind, x), expectedSizes(t), `${t.path} sizes`)
    }
    // Same pixels as the committed files.
    for (const t of inLane) {
      assert.equal(contentHash(t.kind, readFileSync(join(a, t.path))), contentHash(t.kind, read(t.path)), `${t.path} pixels`)
    }
    // A second run over existing files writes nothing.
    const again = spawnSync(process.execPath, [GENERATOR, '--out', a, '--check'], { encoding: 'utf8' })
    assert.equal(again.status, 0, again.stderr)
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('release art has the shapes NSIS and the DMG expect', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-icons-r-'))
  try {
    generate({ out: dir, releaseArt: true })
    const bmp = readFileSync(join(dir, 'branding/official/installerSidebar.bmp'))
    const side = readBMP24(bmp)
    assert.deepEqual([side.width, side.height, side.bitCount], [164, 314, 24])
    const dmg = decodePNG(readFileSync(join(dir, 'branding/official/dmg-background.png')))
    const dmg2 = decodePNG(readFileSync(join(dir, 'branding/official/dmg-background@2x.png')))
    assert.deepEqual([dmg.width, dmg.height, dmg2.width, dmg2.height], [540, 380, 1080, 760])
    assert.equal(alphaAt(dmg, 0, 0), 255, 'DMG background is opaque')
    for (const p of ['branding/official/html-document.icns', 'branding/official/ateliercompanion.icns']) {
      assert.deepEqual(readICNS(readFileSync(join(dir, p))).map((e) => e.type), ICNS_ORDER, p)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Format details.

test('icon.icns holds every macOS size, ARGB at 16 and 32, PNG above', () => {
  const entries = readICNS(read('branding/official/icon.icns'))
  assert.deepEqual(entries.map((e) => e.type), ICNS_ORDER)
  for (const e of entries) {
    assert.equal(e.width, e.size)
    assert.equal(e.height, e.size)
  }
  const raw = read('branding/official/icon.icns')
  const at = (type) => raw.indexOf(Buffer.from(type, 'ascii'))
  assert.equal(raw.toString('ascii', at('ic04') + 8, at('ic04') + 12), 'ARGB')
  assert.equal(raw.toString('ascii', at('ic10') + 9, at('ic10') + 12), 'PNG')
})

test('icon.ico: 256 as PNG, smaller sizes as 32-bit DIBs', () => {
  const imgs = readICO(read('branding/official/icon.ico'))
  assert.deepEqual(imgs.map((i) => i.width), ICO_SIZES)
  for (const i of imgs) {
    assert.equal(i.bitCount, 32)
    assert.equal(i.png, i.width >= 256, `${i.width} px stored as ${i.png ? 'PNG' : 'DIB'}`)
  }
  assert.deepEqual(readICO(read('branding/official/resources/tray/tray-light.ico')).map((i) => i.width), TRAY_ICO_SIZES)
})

test('macOS tray images are templates: black, with alpha, the eyes cut out', () => {
  for (const [p, size] of [
    ['branding/official/resources/tray/trayTemplate.png', 18],
    ['branding/official/resources/tray/trayTemplate@2x.png', 36]
  ]) {
    const img = decodePNG(read(p))
    assert.equal(img.width, size)
    let clear = 0
    let solid = 0
    for (let i = 0; i < img.pixels.length; i += 4) {
      const a = img.pixels[i + 3]
      if (a > 0) assert.deepEqual([img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]], [0, 0, 0], `${p} has a non-black pixel`)
      if (a === 0) clear++
      if (a === 255) solid++
    }
    assert.ok(clear > img.width * 4, `${p} has a transparent ground`)
    assert.ok(solid > img.width * 4, `${p} has a solid head`)
    // The face: a row in the lower half where a clear run sits between solid
    // pixels, on each side of the middle (the eyes, cut through the head).
    let eyes = 0
    for (let y = Math.floor(size * 0.45); y < Math.floor(size * 0.75) && !eyes; y++) {
      const row = Array.from({ length: size }, (_, x) => alphaAt(img, x, y))
      const holes = []
      for (let x = 1; x < size - 1; x++) {
        if (row[x] < 128 && row.slice(0, x).some((a) => a === 255) && row.slice(x + 1).some((a) => a === 255)) holes.push(x)
      }
      if (holes.some((x) => x < size / 2) && holes.some((x) => x >= size / 2)) eyes = y
    }
    assert.ok(eyes > 0, `${p} shows two eyes`)
  }
})

test('Windows tray glyphs: dark ink for light taskbars, light ink for dark ones', () => {
  const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
  const glyphLum = (file) => {
    const img = readICO(read(file)).find((i) => i.width === 32)
    // Mean luminance of the solid head pixels (bottom half).
    let sum = 0
    let n = 0
    for (let y = 16; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const px = pixelAt(img, x, y)
        if (px[3] === 255) {
          sum += lum(px)
          n++
        }
      }
    }
    assert.ok(n > 40, `${file} has a glyph`)
    return sum / n
  }
  assert.ok(glyphLum('branding/official/resources/tray/tray-light.ico') < 60)
  assert.ok(glyphLum('branding/official/resources/tray/tray-dark.ico') > 200)
})

test('macOS icons leave the grid margin clear; flat icons fill the canvas', () => {
  // (The centre is Pip's head, opaque.)
  const mac = decodePNG(read('branding/official/resources/icons/app-512.png'))
  assert.equal(alphaAt(mac, 0, 0), 0, 'corner is clear')
  assert.equal(alphaAt(mac, 20, 256), 0, 'left margin is clear (824/1024 body)')
  assert.equal(alphaAt(mac, 256, 256), 255, 'centre is solid')
  const flat = decodePNG(read('branding/official/icon.png'))
  assert.equal(alphaAt(flat, 0, 0), 0, 'flat corner is clear')
  assert.equal(alphaAt(flat, 40, 512), 255, 'flat tile reaches near the edge')
})

test('the mark reads at 16 px: two eyes in the head, white on the violet tile and lavender in the app', () => {
  const lum = (q) => 0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2]
  const white = (q) => q[3] > 200 && lum(q) > 225
  const lavender = (q) => q[3] > 200 && q[2] > 200 && q[0] > 110 && q[0] < 190 && lum(q) > 105 && lum(q) < 200
  const violet = (q) => q[3] > 200 && q[2] > q[1] + 60 && q[0] > q[1]
  for (const [p, isHead] of [
    ['branding/official/icons/16x16.png', white],
    ['branding/official/renderer/mark-32.png', lavender]
  ]) {
    const img = decodePNG(read(p))
    const n = img.width
    const head = []
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (isHead(pixelAt(img, x, y))) head.push([x, y])
    assert.ok(head.length >= n * n * 0.15, `${p}: the head is there (${head.length} px)`)
    const y0 = Math.min(...head.map(([, y]) => y))
    const y1 = Math.max(...head.map(([, y]) => y))
    const mid = (Math.min(...head.map(([x]) => x)) + Math.max(...head.map(([x]) => x)) + 1) / 2
    // In the head's middle band, pixels of another colour between head pixels on the same row: the eyes, one each side.
    const eyes = []
    for (let y = Math.ceil(y0 + (y1 - y0) * 0.35); y <= Math.floor(y1 - (y1 - y0) * 0.15); y++) {
      const row = head.filter(([, hy]) => hy === y).map(([x]) => x)
      if (row.length < 2) continue
      for (let x = Math.min(...row) + 1; x < Math.max(...row); x++) if (!isHead(pixelAt(img, x, y))) eyes.push(x)
    }
    assert.ok(eyes.some((x) => x + 0.5 < mid) && eyes.some((x) => x + 0.5 > mid), `${p}: two eyes`)
  }
  // On the tile, the corners are violet; in the app, the sprout is.
  assert.ok(violet(pixelAt(decodePNG(read('branding/official/icons/16x16.png')), 2, 2)), 'the tile is violet')
  const mark = decodePNG(read('branding/official/renderer/mark-128.png'))
  const top = Array.from({ length: 128 * 30 }, (_, i) => pixelAt(mark, i % 128, Math.floor(i / 128)))
  assert.ok(top.filter(violet).length > 200, 'the sprout is violet')
})

test('Atelier.icon is a valid Icon Composer document', () => {
  const json = JSON.parse(read('branding/official/Atelier.icon/icon.json').toString('utf8'))
  assert.ok(Array.isArray(json.groups) && json.groups.length >= 1)
  const appearances = json['fill-specializations'].map((s) => s.appearance ?? 'light')
  assert.deepEqual(appearances, ['light', 'dark'])
  const names = []
  for (const g of json.groups) {
    for (const l of g.layers) {
      names.push(l['image-name'])
      const file = read(join('branding/official/Atelier.icon/Assets', l['image-name']))
      if (l['image-name'].endsWith('.png')) {
        const img = decodePNG(file)
        assert.deepEqual([img.width, img.height], [1024, 1024])
        assert.equal(alphaAt(img, 0, 0), 0, 'the layer is clear around the mark')
        assert.equal(alphaAt(img, 512, 640), 255, 'the mark is in the middle')
        assert.equal(alphaAt(img, 411, 593), 0, 'the eyes are cut out, so the fill shows through')
      } else {
        const svg = file.toString('utf8')
        assert.match(svg, /^<svg [^>]*viewBox="0 0 1024 1024"/)
        assert.match(svg, /<path d="M[^"]+"/)
      }
    }
  }
  assert.deepEqual(names, ['pip.png'], 'the mark, alone on the fill')
})

test('the SVG sources are standalone and use no external references', () => {
  for (const t of TARGETS.filter((x) => x.kind === 'svg' && !x.release)) {
    const svg = read(t.path).toString('utf8')
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, t.path)
    // The companions in the document icons are embedded as data: URLs; nothing points outside the file.
    assert.doesNotMatch(svg, /(href|src)=["'](?!#|data:image\/png;base64,)/, `${t.path} references something outside itself`)
  }
})

// ---------------------------------------------------------------------------
// Writers, round trips.

test('PNG, ICO, BMP and icns RLE round-trip', () => {
  const w = 7
  const h = 5
  const px = new Uint8Array(w * h * 4).map((_, i) => (i * 37 + (i >> 2) * 11) & 0xff)
  const back = decodePNG(encodePNG(w, h, px))
  assert.deepEqual([back.width, back.height], [w, h])
  assert.deepEqual(Buffer.from(back.pixels), Buffer.from(px))

  const sq = (s) => new Uint8Array(s * s * 4).map((_, i) => (i * 13) & 0xff)
  const icoImgs = readICO(writeICO([{ size: 16, pixels: sq(16) }, { size: 256, pixels: sq(256) }]))
  assert.deepEqual(Buffer.from(icoImgs[0].pixels), Buffer.from(sq(16)))
  assert.deepEqual(Buffer.from(icoImgs[1].pixels), Buffer.from(sq(256)))

  const rgb = new Uint8Array(5 * 3 * 3).map((_, i) => (i * 29) & 0xff)
  const bmp = readBMP24(writeBMP24(5, 3, rgb))
  for (let i = 0; i < 15; i++) assert.deepEqual(Array.from(bmp.pixels.subarray(i * 4, i * 4 + 3)), Array.from(rgb.subarray(i * 3, i * 3 + 3)))

  const data = Uint8Array.from([1, 1, 1, 1, 2, 3, 4, 4, 4, ...new Array(300).fill(9), 5, 6])
  const packed = packBits(data)
  assert.deepEqual(Buffer.from(unpackBits(packed, 0, data.length).bytes), Buffer.from(data))
})

test('decode() agrees with every committed file', () => {
  for (const t of inLane) {
    const imgs = decode(t.kind, read(t.path))
    for (const im of imgs) assert.equal(im.pixels.length, im.width * im.height * 4, t.path)
  }
})

// ---------------------------------------------------------------------------
// Apple's own tools, when present.

const onMac = process.platform === 'darwin'
const hasTool = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

test('iconutil reads icon.icns into a full iconset', { skip: !onMac && 'macOS only' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-iconset-'))
  try {
    const out = join(dir, 'Atelier.iconset')
    execFileSync('iconutil', ['-c', 'iconset', join(REPO, 'branding/official/icon.icns'), '-o', out])
    const files = readdirSync(out).sort()
    assert.deepEqual(files, [
      'icon_128x128.png',
      'icon_128x128@2x.png',
      'icon_16x16.png',
      'icon_16x16@2x.png',
      'icon_256x256.png',
      'icon_256x256@2x.png',
      'icon_32x32.png',
      'icon_32x32@2x.png',
      'icon_512x512.png',
      'icon_512x512@2x.png'
    ])
    const ours = readICNS(read('branding/official/icon.icns'))
    for (const f of files) {
      const m = /icon_(\d+)x\d+(@2x)?\.png/.exec(f)
      const px = Number(m[1]) * (m[2] ? 2 : 1)
      const img = decodePNG(readFileSync(join(out, f)))
      assert.deepEqual([img.width, img.height], [px, px], f)
      // Opaque pixels come back exactly (iconutil re-derives the colour of
      // nearly clear edge pixels, so those are left out).
      const mine = ours.find((e) => e.size === px && e.scale === (m[2] ? 2 : 1))
      for (let i = 0; i < img.pixels.length; i += 4) {
        if (mine.pixels[i + 3] === 255) {
          assert.deepEqual(Array.from(img.pixels.subarray(i, i + 4)), Array.from(mine.pixels.subarray(i, i + 4)), `${f} pixel ${i / 4}`)
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('actool compiles Atelier.icon into Assets.car', { skip: (!onMac || !hasTool('xcrun', ['--find', 'actool'])) && 'needs Xcode 26' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-actool-'))
  try {
    const out = execFileSync(
      'xcrun',
      [
        'actool',
        join(REPO, 'branding/official/Atelier.icon'),
        '--compile',
        dir,
        '--output-format',
        'human-readable-text',
        '--warnings',
        '--errors',
        '--output-partial-info-plist',
        join(dir, 'partial.plist'),
        '--app-icon',
        'Atelier',
        '--include-all-app-icons',
        '--enable-on-demand-resources',
        'NO',
        '--development-region',
        'en',
        '--target-device',
        'mac',
        '--minimum-deployment-target',
        '11.0',
        '--platform',
        'macosx'
      ],
      { encoding: 'utf8' }
    )
    assert.doesNotMatch(out, /error|warning/i, out)
    assert.ok(existsSync(join(dir, 'Assets.car')), 'Assets.car')
    assert.match(readFileSync(join(dir, 'partial.plist'), 'utf8'), /<key>CFBundleIconName<\/key>\s*<string>Atelier<\/string>/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
