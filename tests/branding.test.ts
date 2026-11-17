/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EN } from '../src/shared/i18n/en'
import { NL } from '../src/shared/i18n/nl'
import { APP_NAME, aboutPanelOptions } from '../src/main/branding'
import { BRANDING } from '../src/shared/branding'
import { brandingProblems, loadBranding, readBranding } from '../scripts/branding.mjs'
import { builderConfig } from '../scripts/release/builderConfig.mjs'
import { setCatalogue } from '../src/shared/i18n/core'
import { trademarkLine } from '../src/renderer/src/updates/logic/licenses'

// The person sees the app's name (Apex, or Summit for the unofficial
// branding; scripts/branding.mjs), never "Electron": the bundle names, the
// About panel, Settings › About and every string in the catalogues.

const root = resolve(__dirname, '..')

describe('the branding names the app', () => {
  it('in package.json, electron-builder.yml and the dev run', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { productName: string; scripts: Record<string, string> }
    expect(APP_NAME).toBe(BRANDING.name)
    expect(APP_NAME).toBe(loadBranding().name)
    // package.json and the yml are written for the official branding; the packaged config swaps in the active one.
    expect(pkg.productName).toBe('Apex')
    expect(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')).toMatch(/^productName: Apex$/m)
    for (const official of ['1', '0']) {
      const config = builderConfig({ APEX_OFFICIAL_BRANDING: official, APEX_INTERNAL: '0' }, { platform: 'linux' })
      const name = official === '1' ? 'Apex' : 'Summit'
      expect(config.productName).toBe(name)
      expect(config.extraMetadata).toMatchObject({ productName: name })
      expect(config.extraMetadata.description).toMatch(new RegExp(`^${name}, the browser`))
      expect(config.nsis.shortcutName).toBe(name)
    }
    expect(pkg.scripts.predev).toContain('node scripts/dev-branding.mjs')
    expect(pkg.scripts.postinstall).toContain('node scripts/dev-branding.mjs')
  })

  it('in the About panel, without a framework build number', () => {
    const mac = aboutPanelOptions({ version: '0.1.0', credits: 'Credits', platform: 'darwin', iconPath: '/x/app-512.png' })
    expect(mac).toEqual({ applicationName: APP_NAME, applicationVersion: '0.1.0', version: '', credits: 'Credits' })
    const linux = aboutPanelOptions({ version: '0.1.0', credits: 'Credits', platform: 'linux', iconPath: '/x/app-512.png' })
    expect(linux).toEqual({ applicationName: APP_NAME, applicationVersion: '0.1.0', credits: 'Credits', iconPath: '/x/app-512.png' })
    expect(aboutPanelOptions({ version: '1', credits: '', platform: 'win32', iconPath: null })).not.toHaveProperty('iconPath')
  })

  it('in Settings › About, whose runtime line names Chromium only', () => {
    const page = readFileSync(resolve(root, 'src/renderer/src/settings/pages/AboutPage.tsx'), 'utf8')
    const fn = page.slice(page.indexOf('export function runtimeLine'), page.indexOf('export function AboutPage'))
    expect(fn).toContain('Chromium')
    expect(fn).not.toMatch(/electron/i)
  })

  it('in every English and Dutch string', () => {
    const named = (catalogue: Readonly<Partial<Record<string, string>>>): string[] => Object.entries(catalogue).filter(([, v]) => /electron/i.test(v ?? '')).map(([k]) => k)
    expect(named(EN)).toEqual([])
    expect(named(NL)).toEqual([])
    expect(EN['updates.about.panelCredits']).toBeTruthy()
    expect(NL['updates.about.panelCredits']).toBeTruthy()
  })

  it('with its copyright, publisher and trademark line, as Brave and Firefox do', () => {
    const official = readBranding('official')
    const unofficial = readBranding('unofficial')
    for (const branding of [official, unofficial]) expect(branding.copyright).toBe('Copyright © 2026 The Apex Authors')
    // Only the official branding claims marks; Summit is a placeholder, not an Apex trademark.
    expect(official.trademarkInfo).toBe('{brand}, the {brand} logo and sprout mark, and the {brand} characters are trademarks of Chinnovations.')
    expect(unofficial.trademarkInfo).toBe('')
    expect(official.publisher).toBeTruthy()
    expect(unofficial.publisher).toBeTruthy()
    expect(brandingProblems({ ...official, trademarkInfo: undefined })).toContain('trademarkInfo must be a line of text, or "" for none')
    expect(brandingProblems({ ...official, copyright: '' })).toContain('copyright must be a line of 1 to 120 characters')
    expect(brandingProblems({ ...official, publisher: ' ' })).toContain('publisher must be a name of 1 to 80 characters')
    // electron-builder takes the copyright (Info.plist, the Windows file properties), the publisher and the Windows trademark line.
    for (const [flag, branding] of [['1', official], ['0', unofficial]] as const) {
      const config = builderConfig({ APEX_OFFICIAL_BRANDING: flag, APEX_INTERNAL: '0' }, { platform: 'linux' })
      expect(config.copyright).toBe(branding.copyright)
      expect(config.extraMetadata.author).toBe(branding.publisher)
      if (branding.trademarkInfo) expect(config.win.legalTrademarks).toBe('Apex, the Apex logo and sprout mark, and the Apex characters are trademarks of Chinnovations.')
      else expect(config.win.legalTrademarks).toBeUndefined()
    }
  })

  it('in Settings › About’s trademark line: translated for the official one, as written for another, none for Summit', () => {
    const official = readBranding('official').trademarkInfo
    // The catalogue's English line is the official branding's, so the Dutch one translates the same sentence.
    expect(EN['updates.about.trademarkInfo']).toBe(official)
    expect(NL['updates.about.trademarkInfo']).toMatch(/\{brand\}.*handelsmerken van Chinnovations/)
    const translate = (key: 'updates.about.trademarkInfo'): string => `[${key}]`
    expect(trademarkLine(official, translate)).toBe('[updates.about.trademarkInfo]')
    expect(trademarkLine('', translate)).toBe('')
    setCatalogue(EN, 'en')
    expect(trademarkLine('{brand} is a trademark of Someone Else.', translate)).toBe(`${BRANDING.shortName} is a trademark of Someone Else.`)
  })
})
