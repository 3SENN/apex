/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readManifest } from '../src/main/extensions/manifest'
import { describePermissions, hostLabel, hostsPhrase, isAllHosts, phraseFor, requestedIds, siteAccessOf } from '../src/main/extensions/permissions'

// OV-16, ST-40: what an extension can do, in Atelier's own plain words.

const FIXTURES = join(__dirname, 'fixtures/extensions')

describe('permission phrases', () => {
  it('says something plain for the permissions people weigh', () => {
    expect(phraseFor('tabs')).toBe('See the address and title of your tabs')
    expect(phraseFor('bookmarks')).toBe('See and change your bookmarks')
    expect(phraseFor('history')).toBe('See the pages you visit')
    expect(phraseFor('clipboardRead')).toBe('See what you copy')
    expect(phraseFor('nativeMessaging')).toBe('Talk to apps installed on this Mac')
    expect(phraseFor('debugger')).toMatch(/what you type/)
    expect(phraseFor('system.cpu')).toBe(phraseFor('system.memory'))
  })

  it('stays quiet for permissions that change nothing a person needs to weigh', () => {
    for (const quiet of ['storage', 'alarms', 'contextMenus', 'activeTab', 'scripting', 'offscreen', 'unlimitedStorage']) expect(phraseFor(quiet)).toBeNull()
  })

  it('names an unknown permission instead of hiding it', () => {
    expect(phraseFor('fancyNewApi')).toBe('Use fancyNewApi')
  })
})

describe('host patterns', () => {
  it('recognizes every spelling of all websites', () => {
    for (const p of ['<all_urls>', '*://*/*', 'https://*/*', 'http://*/', 'https://*/path/*']) expect(isAllHosts(p)).toBe(true)
    expect(isAllHosts('https://*.example.com/*')).toBe(false)
  })

  it('reads a pattern as the site behind it', () => {
    expect(hostLabel('https://*.example.com/*')).toBe('example.com')
    expect(hostLabel('*://mail.example.org:8443/inbox/*')).toBe('mail.example.org')
    expect(hostLabel('file:///*')).toBe('files on this Mac')
  })

  it('folds a list of patterns into one line', () => {
    expect(hostsPhrase([])).toBeNull()
    expect(hostsPhrase(['<all_urls>', 'https://a.test/*'])).toBe('Read and change everything on every website')
    expect(hostsPhrase(['https://*.example.com/*', 'http://example.com/*'])).toBe('Read and change your data on example.com')
    expect(hostsPhrase(['https://a.test/*', 'https://b.test/*'])).toBe('Read and change your data on a.test, b.test')
    expect(hostsPhrase(['https://a.test/*', 'https://b.test/*', 'https://c.test/*', 'https://d.test/*'])).toBe('Read and change your data on 4 websites')
  })
})

describe('describePermissions', () => {
  it('lists site access first, then each API line once, and keeps optional ones one per id', () => {
    const m = readManifest(join(FIXTURES, 'mv3-basic'))
    expect(m).not.toBeNull()
    const d = describePermissions(m!)
    expect(d.permissions.map((p) => p.id)).toEqual(['hosts', 'tabs', 'nativeMessaging'])
    expect(d.permissions[0]?.label).toBe('Read and change your data on example.com')
    expect(d.optional.map((p) => p.id)).toEqual(['bookmarks', 'history', 'https://notes.example.org/*'])
    expect(d.optional[2]?.label).toBe('Read and change your data on notes.example.org')
    expect(d.siteAccess).toBe('some')
    expect(d.hosts).toEqual(['https://*.example.com/*'])
  })

  it('needs nothing extra when only quiet permissions are asked for', () => {
    const d = describePermissions({ manifest_version: 3, permissions: ['storage', 'alarms'] })
    expect(d.permissions).toEqual([])
    expect(d.siteAccess).toBe('none')
  })

  it('collapses permissions that read the same', () => {
    const d = describePermissions({ manifest_version: 3, permissions: ['history', 'webNavigation'] })
    expect(d.permissions).toHaveLength(1)
  })

  it('counts content-script matches as site access, and activeTab as on-click', () => {
    expect(siteAccessOf({ manifest_version: 3, content_scripts: [{ matches: ['<all_urls>'] }] })).toBe('all')
    expect(siteAccessOf({ manifest_version: 3, permissions: ['activeTab'] })).toBe('on-click')
    expect(siteAccessOf({ manifest_version: 2, permissions: ['tabs', 'https://x.test/*'] })).toBe('some')
  })

  it('splits a chrome.permissions request into ids', () => {
    expect(requestedIds({ permissions: ['bookmarks'], origins: ['https://x.test/*'] })).toEqual(['bookmarks', 'https://x.test/*'])
    expect(requestedIds({})).toEqual([])
  })
})

describe('optional permissions at run time (OV-16, ST-40)', () => {
  it('asks again for optional access, grants it, and revokes one or all', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { ExtensionsHost } = await import('../src/main/extensions/host')
    const { fakeAdapter, fakeSession } = await import('./fixtures/extensions/fakeAdapter')
    const dir = mkdtempSync(join(tmpdir(), 'atelier-ext-perm-'))
    const prompts: { kind: string; permissions: { label: string }[] }[] = []
    let answer = true
    const host = new ExtensionsHost({
      adapter: fakeAdapter(),
      preloads: null,
      extensionsDir: (p) => join(dir, p),
      nativeHostDirs: [],
      windows: () => [],
      openTab: () => null,
      changed: () => {},
      askInstall: async (_p, prompt) => (prompts.push(prompt), answer),
      askNative: async () => 'deny',
      toast: () => {},
      registerShortcut: () => ({ ok: true, dispose: () => {} }),
      clashesWith: () => null,
      chromeVersion: '140.0.0.0',
    })
    try {
      host.attach(fakeSession(), 'default')
      const id = await host.loadUnpacked('default', join(FIXTURES, 'mv3-basic'))
      await expect(host.requestPermissions('default', id, { permissions: ['downloads'] })).rejects.toThrow(/Only permissions specified in the manifest/)
      expect(await host.requestPermissions('default', id, { permissions: ['bookmarks'], origins: ['https://notes.example.org/*'] })).toBe(true)
      expect(prompts[0]).toMatchObject({ kind: 'optional', permissions: [{ label: 'Read and change your data on notes.example.org' }, { label: 'See and change your bookmarks' }] })
      // Already granted: no second question.
      expect(await host.requestPermissions('default', id, { permissions: ['bookmarks'] })).toBe(true)
      expect(prompts).toHaveLength(1)
      answer = false
      expect(await host.requestPermissions('default', id, { permissions: ['history'] })).toBe(false)
      const granted = () => host.list('default')[0]!.optional.filter((p) => p.granted).map((p) => p.id)
      expect(granted()).toEqual(['bookmarks', 'https://notes.example.org/*'])
      await host.revoke('default', id, 'bookmarks')
      expect(granted()).toEqual(['https://notes.example.org/*'])
      await host.revoke('default', id, 'all')
      expect(granted()).toEqual([])
      expect(host.isLoaded('default', id)).toBe(true)
    } finally {
      host.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
