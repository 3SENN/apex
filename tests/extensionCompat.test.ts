/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { badgeTextColor, extensionsSlot, filterExtensions, grantedOptional, hasClash, hostsSummary, isExtensionUrl, isWebStoreUrl, normalizeBadgeColor, storeSupportUrl, toolbarButtons, type ExtensionInfo } from '@shared/extensions'
import { NATIVE_APIS, classifyCompat } from '../src/main/extensions/compat'
import { iconDataUrl, insideExtension, localize, pickIcon, readManifest } from '../src/main/extensions/manifest'

// The compatibility classifier (OV-16's acknowledge-only notice), the
// manifest reader it leans on, and what the toolbar and settings show.

const FIXTURES = join(__dirname, 'fixtures/extensions')
const manifest = (name: string) => {
  const m = readManifest(join(FIXTURES, name))
  if (!m) throw new Error(`fixture ${name} has no manifest`)
  return m
}

describe('classifyCompat', () => {
  it('runs an MV3 extension whose APIs are all there (shims included)', () => {
    const c = classifyCompat(manifest('mv3-basic'))
    expect(c).toEqual({ supported: true, reason: null, missing: [] })
  })

  it('refuses Manifest V2, themes and apps with their own words', () => {
    expect(classifyCompat(manifest('mv2-legacy'))).toMatchObject({ supported: false, reason: expect.stringMatching(/Manifest V2/) })
    expect(classifyCompat(manifest('theme'))).toMatchObject({ supported: false, reason: `Chrome themes don’t change how ${BRAND_NAME} looks.` })
    expect(classifyCompat({ manifest_version: 3, app: { launch: {} } })).toMatchObject({ supported: false, reason: `Chrome apps don’t run in ${BRAND_NAME}.` })
  })

  it(`names the APIs ${BRAND_NAME} lacks, counting required permissions and UI keys only`, () => {
    const c = classifyCompat(manifest('needs-apis'))
    expect(c.supported).toBe(false)
    expect(c.missing.sort()).toEqual(['cookies', 'history', 'sidePanel'])
    expect(c.reason).toBe(`It relies on features ${BRAND_NAME} doesn’t have yet: sidePanel, history, cookies.`)
    // `downloads` is only optional, so it doesn't count.
    expect(c.missing).not.toContain('downloads')
  })

  it('uses the singular for one missing API', () => {
    expect(classifyCompat({ manifest_version: 3, permissions: ['cookies'] }).reason).toBe(`It relies on a feature ${BRAND_NAME} doesn’t have yet: cookies.`)
  })

  it('widens with the runtime: a library that provides an API makes it supported', () => {
    const wider = new Set([...NATIVE_APIS, 'cookies', 'history', 'sidePanel'])
    expect(classifyCompat(manifest('needs-apis'), wider).supported).toBe(true)
  })

  it('accepts dotted permissions when their namespace is there', () => {
    expect(classifyCompat({ manifest_version: 3, permissions: ['storage', 'declarativeNetRequestFeedback', 'activeTab'] }).supported).toBe(true)
  })
})

describe('manifest reading', () => {
  it('resolves __MSG_ names from _locales', () => {
    const dir = join(FIXTURES, 'localized')
    const m = manifest('localized')
    expect(localize(dir, m, m.name)).toBe('Localized Fixture')
    expect(localize(dir, m, m.description)).toBe('Says its name through _locales.')
    expect(localize(dir, m, '__MSG_missing__')).toBe('__MSG_missing__')
    expect(localize(dir, m, 'Plain')).toBe('Plain')
  })

  it('picks the icon nearest the size, and never reads outside the folder', () => {
    expect(pickIcon({ '16': 'a.png', '48': 'b.png', '128': 'c.png' }, 32)).toBe('b.png')
    expect(pickIcon({ '16': 'a.png' }, 48)).toBe('a.png')
    expect(pickIcon(undefined, 16)).toBeNull()
    const dir = join(FIXTURES, 'mv3-basic')
    expect(iconDataUrl(dir, 'icon.png')).toMatch(/^data:image\/png;base64,/)
    expect(insideExtension(dir, '../theme/manifest.json')).toBeNull()
    expect(iconDataUrl(dir, '../../../../package.json')).toBeNull()
  })

  it('returns null for a folder without a valid manifest', () => {
    expect(readManifest(join(FIXTURES, 'native-host'))).toBeNull()
  })
})

describe('urls and badges', () => {
  it('trusts the Web Store by exact origin only', () => {
    expect(isWebStoreUrl('https://chromewebstore.google.com/detail/x')).toBe(true)
    expect(isWebStoreUrl('https://chromewebstore.google.com.evil.test/')).toBe(false)
    expect(isWebStoreUrl('http://chromewebstore.google.com/')).toBe(false)
    expect(storeSupportUrl('a'.repeat(32))).toBe(`https://chromewebstore.google.com/detail/${'a'.repeat(32)}/support`)
  })

  it('marks extension pages, which the agent never acts on', () => {
    expect(isExtensionUrl('chrome-extension://abc/popup.html')).toBe(true)
    expect(isExtensionUrl('https://example.com')).toBe(false)
  })

  it('picks black or white badge text for contrast, and drops colours it cannot read', () => {
    expect(badgeTextColor('#ffeb3b')).toBe('#000000')
    expect(badgeTextColor('#1a237e')).toBe('#ffffff')
    expect(badgeTextColor('#2f6b4f')).toBe('#ffffff')
    expect(badgeTextColor('red')).toBeNull()
    expect(normalizeBadgeColor([255, 0, 128, 255])).toBe('#ff0080')
    expect(normalizeBadgeColor('#ABC')).toBe('#abc')
    expect(normalizeBadgeColor([300, 0, 0])).toBeNull()
  })
})

const info = (over: Partial<ExtensionInfo>): ExtensionInfo => ({
  id: 'a'.repeat(32),
  name: 'Notes',
  version: '1.0',
  description: 'Keeps notes',
  icon: null,
  enabled: true,
  pinned: false,
  permissions: [],
  optional: [],
  siteAccess: 'none',
  hosts: [],
  supported: true,
  unsupportedReason: null,
  hasPopup: true,
  badge: null,
  storeUrl: null,
  commands: [],
  popupOpen: false,
  title: 'Notes',
  source: 'store',
  ...over,
})

describe('toolbar and settings logic', () => {
  it('shows buttons on websites, the lone button on utility pages, and nothing elsewhere', () => {
    expect(extensionsSlot('https://example.com/')).toBe('website')
    expect(extensionsSlot('atelier://settings/extensions')).toBe('internal')
    expect(extensionsSlot('atelier://history')).toBe('internal')
    expect(extensionsSlot('atelier://chats')).toBeNull()
    expect(extensionsSlot('about:blank')).toBeNull()
    expect(extensionsSlot('chrome-extension://abc/options.html')).toBeNull()
    expect(extensionsSlot(null)).toBeNull()
  })

  it('makes buttons of pinned extensions, plus an unpinned one while its popup is open', () => {
    const items = [info({ id: 'a'.repeat(32), pinned: true }), info({ id: 'b'.repeat(32) }), info({ id: 'c'.repeat(32), popupOpen: true }), info({ id: 'd'.repeat(32), pinned: true, enabled: false }), info({ id: 'e'.repeat(32), pinned: true, supported: false })]
    expect(toolbarButtons(items).map((e) => e.id[0])).toEqual(['a', 'c'])
  })

  it('searches names and descriptions without case', () => {
    const items = [info({ name: 'Grammar Pal' }), info({ name: 'Dark Reader', description: 'Night mode for pages' })]
    expect(filterExtensions(items, 'NIGHT').map((e) => e.name)).toEqual(['Dark Reader'])
    expect(filterExtensions(items, '  ')).toHaveLength(2)
    expect(filterExtensions(items, 'zzz')).toEqual([])
  })

  it('summarizes some-sites access and finds granted extras and clashes', () => {
    expect(hostsSummary(['https://*.a.test/*', 'http://a.test/*', 'https://b.test/*', 'https://c.test/*', 'https://d.test/*', 'file:///*'])).toEqual({ hosts: ['a.test', 'b.test', 'c.test'], more: 1 })
    const ext = info({ optional: [{ id: 'bookmarks', label: 'x', granted: true }, { id: 'history', label: 'y', granted: false }], commands: [{ name: 'Open', shortcut: 'Command+T', clash: 'new-tab' }] })
    expect(grantedOptional(ext)).toEqual(['bookmarks'])
    expect(hasClash(ext)).toBe(true)
    expect(hasClash(info({}))).toBe(false)
  })
})
