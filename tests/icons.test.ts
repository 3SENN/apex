/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getConfig } from 'app-builder-lib/out/util/config/config'
import { describe, expect, it } from 'vitest'
import { missingBrandingFiles, readBranding } from '../scripts/branding.mjs'
import { builderConfig } from '../scripts/release/builderConfig.mjs'

// The committed icon set against its hash manifest
// (scripts/app-icons/manifest.json), and every icon path the packaging and the
// app read. `node scripts/app-icons/generate.mjs --check` (in CI) proves the
// files are what the generator draws; this proves nothing drifted since.

const REPO = resolve(__dirname, '..')
const read = (p: string): Buffer => readFileSync(join(REPO, p))

interface Entry {
  kind: 'png' | 'icns' | 'ico' | 'bmp' | 'svg' | 'json'
  bytes: number
  sha256: string
  sizes: Array<[number, number]>
  release?: boolean
}
const MANIFEST = JSON.parse(read('scripts/app-icons/manifest.json').toString('utf8')) as { files: Record<string, Entry> }
/** The unofficial branding's icons (scripts/app-icons/unofficial.mjs). */
const UNOFFICIAL = JSON.parse(read('scripts/app-icons/unofficial.manifest.json').toString('utf8')) as { files: Record<string, Entry> }
const FILES = Object.entries(MANIFEST.files)

/** [width, height] of every image in a file, smallest first, from the headers alone. */
function sizes(kind: Entry['kind'], buf: Buffer): Array<[number, number]> {
  const sort = (list: Array<[number, number]>): Array<[number, number]> => list.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  switch (kind) {
    case 'png':
      expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG')
      return [[buf.readUInt32BE(16), buf.readUInt32BE(20)]]
    case 'bmp':
      expect(buf.subarray(0, 2).toString('latin1')).toBe('BM')
      return [[buf.readInt32LE(18), Math.abs(buf.readInt32LE(22))]]
    case 'ico': {
      const count = buf.readUInt16LE(4)
      const out: Array<[number, number]> = []
      for (let i = 0; i < count; i++) {
        const w = buf[6 + i * 16]!
        const h = buf[7 + i * 16]!
        out.push([w || 256, h || 256])
      }
      return sort(out)
    }
    case 'icns': {
      expect(buf.subarray(0, 4).toString('latin1')).toBe('icns')
      expect(buf.readUInt32BE(4)).toBe(buf.length)
      // Pixel sizes of the icon types the generator writes (Apple's icns type codes).
      const TYPES: Record<string, number> = { ic04: 16, ic11: 32, ic05: 32, ic12: 64, ic07: 128, ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024 }
      const out: Array<[number, number]> = []
      for (let at = 8; at < buf.length; at += buf.readUInt32BE(at + 4)) {
        const px = TYPES[buf.subarray(at, at + 4).toString('latin1')]
        if (px) out.push([px, px])
      }
      return sort(out)
    }
    default:
      return []
  }
}

describe('the committed icon set', () => {
  it('matches the manifest byte for byte', () => {
    expect(FILES.length).toBeGreaterThan(30)
    for (const [path, entry] of FILES) {
      expect(existsSync(join(REPO, path)), `${path}: run npm run icons`).toBe(true)
      const buf = read(path)
      expect(buf.length, path).toBe(entry.bytes)
      expect(createHash('sha256').update(buf).digest('hex'), path).toBe(entry.sha256)
    }
  })

  it('holds the sizes the manifest lists', () => {
    for (const [path, entry] of FILES) {
      if (entry.kind === 'svg' || entry.kind === 'json') continue
      expect(sizes(entry.kind, read(path)), path).toEqual(entry.sizes)
    }
  })

  it('covers every icon electron-builder packages', async () => {
    const config = await getConfig(REPO, null, null)
    const icons = [
      config.mac?.icon,
      config.win?.icon,
      config.nsis?.installerIcon,
      config.nsis?.uninstallerIcon,
      config.nsis?.installerSidebar,
      config.nsis?.uninstallerSidebar,
      config.dmg?.background,
      'branding/official/dmg-background@2x.png',
      // Document icons: fileAssociations name them; electron-builder adds the extension.
      ...(config.mac?.fileAssociations as Array<{ icon?: string }>).flatMap((a) => (a.icon ? [`${a.icon}.icns`] : [])),
      'branding/official/html-document.ico',
      'branding/official/ateliercompanion.ico',
    ]
    for (const icon of icons) expect(MANIFEST.files[icon as string], String(icon)).toBeDefined()
    // The Linux hicolor set is a folder of NxN.png.
    expect(config.linux?.icon).toBe('branding/official/icons')
    for (const s of [16, 32, 48, 64, 128, 256, 512]) expect(MANIFEST.files[`branding/official/icons/${s}x${s}.png`]?.sizes).toEqual([[s, s]])
  })

  it('has every file of the unofficial branding the packaging takes, drawn from its one SVG', () => {
    const config = builderConfig({ ATELIER_OFFICIAL_BRANDING: '0', ATELIER_INTERNAL: '0' }, { platform: 'linux' })
    const files = [
      config.mac.icon,
      config.win.icon,
      config.nsis.installerIcon,
      config.nsis.installerSidebar,
      config.dmg.background,
      ...(config.mac.fileAssociations as Array<{ icon?: string }>).flatMap((a) => (a.icon ? [`${a.icon}.icns`] : [])),
      ...(config.win.extraResources as Array<{ from: string }>).map((r) => r.from).filter((f) => f.startsWith('branding/')),
    ]
    expect(files.length).toBeGreaterThan(8)
    for (const file of files) {
      expect(file, file).toMatch(/^branding\/unofficial\//)
      expect(UNOFFICIAL.files[file], file).toBeDefined()
      expect(existsSync(join(REPO, file)), file).toBe(true)
    }
    expect(config.linux.icon).toBe('branding/unofficial/icons')
    expect(config.extraResources).toContainEqual({ from: 'branding/unofficial/resources', to: 'resources' })
    // The same file names and sizes as the official set, apart from what only the official one has.
    const official = Object.entries(MANIFEST.files).filter(([path, e]) => e.kind !== 'svg' && !/\/(Atelier\.icon|art)\//.test(path))
    for (const [path, entry] of official) expect(UNOFFICIAL.files[path.replace('branding/official/', 'branding/unofficial/')]?.sizes, path).toEqual(entry.sizes)
    for (const [path, entry] of Object.entries(UNOFFICIAL.files)) {
      const buf = read(path)
      expect(createHash('sha256').update(buf).digest('hex'), path).toBe(entry.sha256)
    }
    expect(Object.keys(UNOFFICIAL.files).every((path) => path.startsWith('branding/unofficial/'))).toBe(true)
  })

  it('names each branding\'s files in its branding.json', () => {
    for (const id of ['official', 'unofficial']) expect(missingBrandingFiles(readBranding(id)), id).toEqual([])
  })

  it('has the runtime icons and tray images the app reads (resourcePath)', () => {
    for (const s of [32, 64, 128, 256, 512]) expect(MANIFEST.files[`branding/official/resources/icons/app-${s}.png`]?.sizes).toEqual([[s, s]])
    expect(MANIFEST.files['branding/official/resources/tray/trayTemplate.png']?.sizes).toEqual([[18, 18]])
    expect(MANIFEST.files['branding/official/resources/tray/trayTemplate@2x.png']?.sizes).toEqual([[36, 36]])
    for (const f of ['tray-light.ico', 'tray-dark.ico']) expect(MANIFEST.files[`branding/official/resources/tray/${f}`]?.sizes).toContainEqual([16, 16])
    expect(MANIFEST.files['branding/official/resources/tray/tray.png']).toBeDefined()
  })

  it('has the DMG and NSIS art at the sizes their windows use', () => {
    expect(MANIFEST.files['branding/official/dmg-background.png']?.sizes).toEqual([[540, 380]])
    expect(MANIFEST.files['branding/official/dmg-background@2x.png']?.sizes).toEqual([[1080, 760]])
    expect(MANIFEST.files['branding/official/installerSidebar.bmp']?.sizes).toEqual([[164, 314]])
  })

  it('ships a valid Icon Composer document for macOS 26', () => {
    const doc = JSON.parse(read('branding/official/Atelier.icon/icon.json').toString('utf8')) as Record<string, unknown>
    const text = JSON.stringify(doc)
    for (const m of text.matchAll(/"image-name":"([^"]+)"/g)) expect(existsSync(join(REPO, 'branding/official/Atelier.icon/Assets', m[1]!)), m[1]).toBe(true)
    expect(text).toMatch(/"image-name"/)
  })
})
