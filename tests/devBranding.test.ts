/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readBranding, type Branding } from '../scripts/branding.mjs'
import { APP_NAME, brandDevApp, brandHelperPlist, brandInfoPlist, plistString, setPlistString } from '../scripts/dev-branding.mjs'

// scripts/dev-branding.mjs: the dev run's Electron.app says Atelier in the menu
// bar, Dock, About panel and notifications (predev and postinstall).

const plist = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`

const ELECTRON = plist(
  '\t<key>CFBundleDisplayName</key>\n\t<string>Electron</string>\n' +
    '\t<key>CFBundleExecutable</key>\n\t<string>Electron</string>\n' +
    '\t<key>CFBundleIconFile</key>\n\t<string>electron.icns</string>\n' +
    '\t<key>CFBundleIdentifier</key>\n\t<string>com.github.Electron</string>\n' +
    '\t<key>CFBundleName</key>\n\t<string>Electron</string>\n' +
    '\t<key>ElectronAsarIntegrity</key>\n\t<dict>\n\t\t<key>Resources/default_app.asar</key>\n\t\t<dict>\n\t\t\t<key>hash</key>\n\t\t\t<string>abc</string>\n\t\t</dict>\n\t</dict>\n',
)

describe('the Info.plist patch', () => {
  it('names the bundle Atelier and leaves the executable, identifier and the rest alone', () => {
    const out = brandInfoPlist(ELECTRON)
    expect(APP_NAME).toBe('Atelier')
    expect(plistString(out, 'CFBundleName')).toBe('Atelier')
    expect(plistString(out, 'CFBundleDisplayName')).toBe('Atelier')
    // electron-vite starts MacOS/Electron (path.txt), and the identifier keeps the dev run's permissions.
    expect(plistString(out, 'CFBundleExecutable')).toBe('Electron')
    expect(plistString(out, 'CFBundleIdentifier')).toBe('com.github.Electron')
    expect(plistString(out, 'CFBundleIconFile')).toBe('electron.icns')
    expect(out).toContain('<key>Resources/default_app.asar</key>')
    expect(out.replace(/<string>(Atelier|Electron)<\/string>/g, '')).toBe(ELECTRON.replace(/<string>(Atelier|Electron)<\/string>/g, ''))
  })

  it('is idempotent', () => {
    const once = brandInfoPlist(ELECTRON)
    expect(brandInfoPlist(once)).toBe(once)
  })

  it('adds a missing display name inside the top-level dict', () => {
    const noDisplay = plist('\t<key>CFBundleName</key>\n\t<string>Electron</string>\n\t<key>Nested</key>\n\t<dict>\n\t\t<key>x</key>\n\t\t<string>y</string>\n\t</dict>\n')
    const out = brandInfoPlist(noDisplay)
    expect(plistString(out, 'CFBundleDisplayName')).toBe('Atelier')
    expect(out.match(/<key>CFBundleDisplayName<\/key>/g)).toHaveLength(1)
    expect(out.trimEnd().endsWith('<string>Atelier</string>\n</dict>\n</plist>')).toBe(true)
    expect(brandInfoPlist(out)).toBe(out)
  })

  it('fills an empty self-closing string instead of adding a second key', () => {
    const out = setPlistString(plist('\t<key>CFBundleDisplayName</key>\n\t<string/>\n'), 'CFBundleDisplayName', 'Atelier')
    expect(out.match(/CFBundleDisplayName/g)).toHaveLength(1)
    expect(plistString(out, 'CFBundleDisplayName')).toBe('Atelier')
  })

  it('escapes XML in values and reads it back', () => {
    const out = setPlistString(ELECTRON, 'CFBundleName', 'A & <B>')
    expect(out).toContain('<string>A &amp; &lt;B&gt;</string>')
    expect(plistString(out, 'CFBundleName')).toBe('A & <B>')
  })

  it('refuses text that is not an XML plist', () => {
    expect(() => setPlistString('{"CFBundleName":"Electron"}', 'CFBundleName', 'Atelier')).toThrow()
  })

  it('renames helpers but keeps their role', () => {
    const helper = plist('\t<key>CFBundleName</key>\n\t<string>Electron Helper (Renderer)</string>\n\t<key>CFBundleExecutable</key>\n\t<string>Electron Helper (Renderer)</string>\n')
    const out = brandHelperPlist(helper)
    expect(plistString(out, 'CFBundleName')).toBe('Atelier Helper (Renderer)')
    expect(plistString(out, 'CFBundleExecutable')).toBe('Electron Helper (Renderer)')
    expect(plistString(out, 'CFBundleDisplayName')).toBeNull()
    expect(brandHelperPlist(out)).toBe(out)
  })
})

describe('brandDevApp', () => {
  const fixture = (): { repo: string; app: string } => {
    const repo = mkdtempSync(join(tmpdir(), 'atelier-dev-branding-'))
    const app = join(repo, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents')
    mkdirSync(join(app, 'Resources'), { recursive: true })
    mkdirSync(join(app, 'Frameworks', 'Electron Helper (GPU).app', 'Contents'), { recursive: true })
    mkdirSync(join(repo, 'branding', 'official'), { recursive: true })
    writeFileSync(join(app, 'Info.plist'), ELECTRON)
    writeFileSync(join(app, 'Frameworks', 'Electron Helper (GPU).app', 'Contents', 'Info.plist'), plist('\t<key>CFBundleName</key>\n\t<string>Electron Helper (GPU)</string>\n'))
    writeFileSync(join(app, 'Resources', 'electron.icns'), 'electron icon')
    writeFileSync(join(repo, 'branding', 'official', 'icon.icns'), 'atelier icon')
    return { repo, app }
  }
  const official = (repo: string): Branding => ({ ...readBranding('official'), dir: join(repo, 'branding', 'official') })

  it('renames the bundle, copies the icon and refreshes once; a second run changes nothing', () => {
    const { repo, app } = fixture()
    const refreshed: string[] = []
    const first = brandDevApp({ repo, platform: 'darwin', branding: official(repo), refresh: (b: string) => refreshed.push(b) })
    expect(first.changed).toHaveLength(3)
    expect(plistString(readFileSync(join(app, 'Info.plist'), 'utf8'), 'CFBundleName')).toBe('Atelier')
    expect(plistString(readFileSync(join(app, 'Frameworks', 'Electron Helper (GPU).app', 'Contents', 'Info.plist'), 'utf8'), 'CFBundleName')).toBe('Atelier Helper (GPU)')
    expect(readFileSync(join(app, 'Resources', 'electron.icns'), 'utf8')).toBe('atelier icon')
    expect(refreshed).toHaveLength(1)

    const second = brandDevApp({ repo, platform: 'darwin', branding: official(repo), refresh: (b: string) => refreshed.push(b) })
    expect(second.changed).toEqual([])
    expect(refreshed).toHaveLength(1)
  })

  it('picks up a new Atelier icon', () => {
    const { repo, app } = fixture()
    brandDevApp({ repo, platform: 'darwin', branding: official(repo), refresh: () => undefined })
    writeFileSync(join(repo, 'branding', 'official', 'icon.icns'), 'new atelier icon')
    expect(brandDevApp({ repo, platform: 'darwin', branding: official(repo), refresh: () => undefined }).changed).toHaveLength(1)
    expect(readFileSync(join(app, 'Resources', 'electron.icns'), 'utf8')).toBe('new atelier icon')
  })

  it('renames an Atelier dev bundle Summit, helpers too, when the branding switches', () => {
    const { repo, app } = fixture()
    brandDevApp({ repo, platform: 'darwin', branding: official(repo), refresh: () => undefined })
    mkdirSync(join(repo, 'branding', 'unofficial'))
    writeFileSync(join(repo, 'branding', 'unofficial', 'icon.icns'), 'summit icon')
    const summit = { ...readBranding('unofficial'), dir: join(repo, 'branding', 'unofficial') }
    expect(brandDevApp({ repo, platform: 'darwin', branding: summit, refresh: () => undefined }).changed).toHaveLength(3)
    expect(plistString(readFileSync(join(app, 'Info.plist'), 'utf8'), 'CFBundleName')).toBe('Summit')
    expect(plistString(readFileSync(join(app, 'Frameworks', 'Electron Helper (GPU).app', 'Contents', 'Info.plist'), 'utf8'), 'CFBundleName')).toBe('Summit Helper (GPU)')
    expect(readFileSync(join(app, 'Resources', 'electron.icns'), 'utf8')).toBe('summit icon')
  })

  it('skips other platforms and a missing Electron', () => {
    expect(brandDevApp({ repo: fixture().repo, platform: 'linux' }).skipped).toBe('not macOS')
    expect(brandDevApp({ repo: mkdtempSync(join(tmpdir(), 'atelier-dev-branding-')), platform: 'darwin' }).skipped).toBe('Electron is not installed')
  })
})
