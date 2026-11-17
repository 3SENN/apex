/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SITE_SETTINGS, applySitePatch, countOverrides, normalizeSiteSettings } from '@shared/sites'
import { externalDecision, rememberExternal } from '../src/main/externalApps'
import { SiteStore, sites } from '../src/main/sites'

// The per-origin site store: what it keeps, where, and that a
// private window keeps nothing on disk.

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-sites-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the site store', () => {
  it('keys answers by origin, whatever page of the site asked', () => {
    const store = new SiteStore(null)
    store.set('https://Example.com/a/b?c', { permissions: { camera: 'allow' } })
    expect(store.permission('https://example.com', 'camera')).toBe('allow')
    expect(store.permission('https://example.com/other', 'camera')).toBe('allow')
    expect(store.permission('http://example.com', 'camera')).toBe('ask')
    expect(store.permission('https://www.example.com', 'camera')).toBe('ask')
  })

  it('ignores pages that are not sites', () => {
    const store = new SiteStore(null)
    expect(store.set('file:///tmp/x.html', { sound: 'block' })).toEqual(DEFAULT_SITE_SETTINGS)
    expect(store.list()).toEqual([])
  })

  it('combines camera and microphone into one decision', () => {
    const store = new SiteStore(null)
    store.set('https://meet.example', { permissions: { camera: 'allow' } })
    expect(store.decision('https://meet.example', ['camera', 'microphone'])).toBe('ask')
    store.set('https://meet.example', { permissions: { microphone: 'allow' } })
    expect(store.decision('https://meet.example', ['camera', 'microphone'])).toBe('allow')
    store.set('https://meet.example', { permissions: { microphone: 'block' } })
    expect(store.decision('https://meet.example', ['camera', 'microphone'])).toBe('block')
  })

  it('drops a site once it is back at every default, and setting ask clears an answer', () => {
    const store = new SiteStore(null)
    store.set('https://a.example', { permissions: { location: 'block' } })
    expect(store.list()).toHaveLength(1)
    store.set('https://a.example', { permissions: { location: 'ask' } })
    expect(store.list()).toEqual([])
  })

  it('lists sites with their override counts, sorted', () => {
    const store = new SiteStore(null)
    store.set('https://b.example', { sound: 'block', forceDark: true })
    store.set('https://a.example', { permissions: { notifications: 'allow' } })
    expect(store.list().map((e) => [e.origin, e.overrides])).toEqual([
      ['https://a.example', 1],
      ['https://b.example', 2],
    ])
  })

  it('announces every change with the origin key', () => {
    const store = new SiteStore(null)
    const seen: string[] = []
    store.on('changed', (origin) => seen.push(origin))
    store.set('https://A.example/x', { popups: 'allow' })
    store.forget('https://a.example')
    store.forget('https://never.example')
    expect(seen).toEqual(['https://a.example', 'https://a.example'])
  })

  it('returns copies, so callers cannot change what is stored', () => {
    const store = new SiteStore(null)
    store.set('https://a.example', { externalSchemes: ['zoommtg'] })
    store.get('https://a.example').externalSchemes.push('slack')
    expect(store.get('https://a.example').externalSchemes).toEqual(['zoommtg'])
  })

  it('persists to sites.json and reads it back', () => {
    const file = join(tempDir(), 'sites.json')
    const store = new SiteStore(file)
    expect(store.persistent).toBe(true)
    store.set('https://a.example', { permissions: { camera: 'allow' }, devices: [{ kind: 'usb', id: '1:2:', name: 'Key' }] })
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { version: number; sites: Record<string, unknown> }
    expect(saved.version).toBe(1)
    expect(Object.keys(saved.sites)).toEqual(['https://a.example'])
    const again = new SiteStore(file)
    expect(again.permission('https://a.example', 'camera')).toBe('allow')
    expect(again.get('https://a.example').devices).toEqual([{ kind: 'usb', id: '1:2:', name: 'Key' }])
  })

  it('survives a damaged or hand-edited file', () => {
    const dir = tempDir()
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ not json')
    expect(new SiteStore(broken).list()).toEqual([])
    const odd = join(dir, 'odd.json')
    writeFileSync(odd, JSON.stringify({ version: 1, sites: { 'file:///x': { sound: 'block' }, 'HTTPS://B.example': { sound: 'loud', permissions: { camera: 'maybe', location: 'block' } } } }))
    const store = new SiteStore(odd)
    expect(store.list().map((e) => e.origin)).toEqual(['https://b.example'])
    expect(store.get('https://b.example').sound).toBe('default')
    expect(store.get('https://b.example').permissions).toEqual({ location: 'block' })
  })
})

describe('private windows', () => {
  it('keep their answers in memory only, apart from the profile', () => {
    const dataDir = tempDir()
    const privateSession = {} as Electron.Session
    const profileSession = {} as Electron.Session
    const privateStore = sites.attach(privateSession, { private: true, dataDir })
    const profileStore = sites.attach(profileSession, { private: false, dataDir })
    expect(privateStore.persistent).toBe(false)
    expect(privateStore.file).toBeNull()
    expect(sites.attach(privateSession, { private: true, dataDir })).toBe(privateStore)
    privateStore.set('https://secret.example', { permissions: { camera: 'allow' }, sound: 'block' })
    expect(existsSync(join(dataDir, 'sites.json'))).toBe(false)
    expect(profileStore.permission('https://secret.example', 'camera')).toBe('ask')
    expect(sites.settingsFor(privateSession, 'https://secret.example').sound).toBe('block')
    expect(sites.settingsFor(profileSession, 'https://secret.example').sound).toBe('default')
  })

  it('never become the store the Settings pages show', () => {
    expect(sites.defaultStore()?.persistent).toBe(true)
  })

  it("honour the profile's blocks, live, but none of its allows", () => {
    const profile = sites.storeForDir(tempDir())
    const own = new SiteStore(null)
    own.inheritFrom(profile)
    const site = 'https://ads.example'
    profile.set(site, { permissions: { camera: 'block', location: 'allow' }, sound: 'block', popups: 'allow' })
    expect(own.permission(site, 'camera')).toBe('block')
    expect(own.decision(site, ['camera', 'microphone'])).toBe('block')
    expect(own.permission(site, 'location')).toBe('ask')
    expect(own.get(site)).toMatchObject({ sound: 'block', popups: 'default' })
    expect(own.list().map((e) => e.origin)).toEqual([site])
    const changes: string[] = []
    own.on('changed', (origin) => changes.push(origin))
    profile.set('https://other.example', { permissions: { notifications: 'block' } })
    expect(changes).toEqual(['https://other.example'])
    expect(own.permission('https://other.example', 'notifications')).toBe('block')
  })

  it('lift an inherited block for the window only, and never write back', () => {
    const dir = tempDir()
    const profile = sites.storeForDir(dir)
    const own = new SiteStore(null)
    own.inheritFrom(profile)
    const site = 'https://ads.example'
    profile.set(site, { permissions: { camera: 'block', microphone: 'block' }, sound: 'block' })
    const before = readFileSync(join(dir, 'sites.json'), 'utf8')
    own.set(site, { permissions: { camera: 'ask' }, sound: 'default' })
    expect(own.permission(site, 'camera')).toBe('ask')
    expect(own.permission(site, 'microphone')).toBe('block')
    expect(own.get(site).sound).toBe('default')
    // An answer of its own wins over the lift; Reset lifts everything the profile blocks.
    own.set(site, { permissions: { camera: 'block' } })
    expect(own.permission(site, 'camera')).toBe('block')
    own.forget(site)
    expect(own.get(site)).toEqual(DEFAULT_SITE_SETTINGS)
    expect(own.list()).toEqual([])
    expect(profile.permission(site, 'camera')).toBe('block')
    expect(profile.get(site).sound).toBe('block')
    expect(readFileSync(join(dir, 'sites.json'), 'utf8')).toBe(before)
  })

  it("share one store per profile folder, whether the profile's session opened first or not", () => {
    const dir = tempDir()
    const early = sites.storeForDir(dir)
    expect(sites.attach({} as Electron.Session, { private: false, dataDir: dir })).toBe(early)
    // A persistent store never inherits.
    early.inheritFrom(new SiteStore(null))
    expect(early.permission('https://x.example', 'camera')).toBe('ask')
  })
})

describe('certificate exceptions', () => {
  it('are marked and cleared per tab', () => {
    expect(sites.hasCertificateException('t1')).toBe(false)
    sites.setCertificateException('t1', true)
    expect(sites.hasCertificateException('t1')).toBe(true)
    sites.setCertificateException('t1', false)
    expect(sites.hasCertificateException('t1')).toBe(false)
  })
})

describe('site settings helpers', () => {
  it('fill in defaults field by field', () => {
    expect(normalizeSiteSettings(null)).toEqual(DEFAULT_SITE_SETTINGS)
    const s = normalizeSiteSettings({ forceDark: 'yes', cookies: 'block', externalSchemes: ['zoommtg', 'zoommtg', 'Bad Scheme', 4], devices: [{ kind: 'usb', id: '', name: 'x' }, { kind: 'hid', id: 'a', name: 'Pad' }] })
    expect(s.forceDark).toBe(false)
    expect(s.cookies).toBe('block')
    expect(s.externalSchemes).toEqual(['zoommtg'])
    expect(s.devices).toEqual([{ kind: 'hid', id: 'a', name: 'Pad' }])
  })

  it('merge permission patches instead of replacing them', () => {
    const one = applySitePatch(DEFAULT_SITE_SETTINGS, { permissions: { camera: 'allow' } })
    const two = applySitePatch(one, { permissions: { microphone: 'block' } })
    expect(two.permissions).toEqual({ camera: 'allow', microphone: 'block' })
    expect(countOverrides(two)).toBe(2)
  })
})

describe('external apps', () => {
  it('remember only an allow, per site and scheme', () => {
    const store = new SiteStore(null)
    const zoom = { url: 'zoommtg://join?id=1', scheme: 'zoommtg', app: 'Zoom' }
    expect(externalDecision(store, 'https://a.example', zoom)).toBe('ask')
    rememberExternal(store, 'https://a.example', 'zoommtg')
    rememberExternal(store, 'https://a.example', 'zoommtg')
    expect(store.get('https://a.example').externalSchemes).toEqual(['zoommtg'])
    expect(externalDecision(store, 'https://a.example', zoom)).toBe('allow')
    expect(externalDecision(store, 'https://b.example', zoom)).toBe('ask')
    expect(externalDecision(null, 'https://b.example', { url: 'mailto:x@y.z', scheme: 'mailto', app: 'Mail' })).toBe('allow')
  })
})
