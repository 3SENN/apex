/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  DEVICE_PERMISSIONS,
  SILENT_ALLOW,
  SILENT_DENY,
  canRemember,
  classifyPermission,
  combineDecisions,
  decisionOptions,
  externalScheme,
  isApexOrigin,
  isSilentExternal,
  mediaPerms,
  promptKey,
  rememberable,
  siteKey,
} from '@shared/permissions'
import {
  EMBARGO_DISMISSALS,
  EMBARGO_MS,
  QUERY_NAMES,
  afterAnswer,
  afterDismissal,
  asksQuietly,
  frameScope,
  isEmbargoed,
  isSecureOrigin,
  oneOffAnswer,
  oneOffKey,
  queryState,
  secureEnough,
  siteVerdict,
} from '@shared/permissions'
import { SITE_PERMISSIONS } from '@shared/sites'
import { rememberChoice } from '../src/main/permissions'
import { permissionPolicy } from '../src/main/permissionPolicy'

// OV-10: the permission policy table, the remember rules and origin keys.

describe('the permission policy table', () => {
  it('allows the harmless ones without a word', () => {
    for (const p of ['clipboard-sanitized-write', 'pointerLock', 'keyboardLock', 'persistent-storage', 'mediaKeySystem', 'screen-wake-lock', 'sensors', 'fullscreen']) {
      expect(classifyPermission(p)).toEqual({ action: 'allow' })
    }
  })

  it('refuses what Apex does not offer, without asking', () => {
    for (const p of ['ar', 'vr', 'background-fetch', 'background-sync', 'periodic-background-sync', 'web-app-installation', 'system-wake-lock']) {
      expect(classifyPermission(p)).toEqual({ action: 'deny' })
    }
  })

  it('refuses full screen without a click, and keeps full screen after one', () => {
    expect(classifyPermission('automatic-fullscreen')).toEqual({ action: 'deny' })
    expect(SILENT_ALLOW.has('automatic-fullscreen')).toBe(false)
    expect(classifyPermission('fullscreen')).toEqual({ action: 'allow' })
  })

  it('never lets a permission sit in both silent lists', () => {
    for (const p of SILENT_ALLOW) expect(SILENT_DENY.has(p)).toBe(false)
  })

  it('refuses permissions it has never heard of', () => {
    expect(classifyPermission('some-future-permission')).toEqual({ action: 'deny' })
  })

  it('asks for the capabilities a person should decide, mapped to site permissions', () => {
    const cases: [string, string][] = [
      ['geolocation', 'location'],
      ['notifications', 'notifications'],
      ['clipboard-read', 'clipboard-read'],
      ['local-fonts', 'local-fonts'],
      ['idle-detection', 'idle-detection'],
      ['speaker-selection', 'speaker-selection'],
      ['local-network-access', 'local-network'],
      ['midi', 'midi'],
      ['midiSysex', 'midi'],
      ['display-capture', 'screen'],
      ['fileSystem', 'file-system'],
      ['openExternal', 'external-app'],
      ['hid', 'hid'],
      ['usb', 'usb'],
      ['serial', 'serial'],
      // The person is asked before a site places windows across displays.
      ['window-management', 'window-management'],
    ]
    for (const [electron, perm] of cases) expect(classifyPermission(electron)).toEqual({ action: 'ask', perms: [perm] })
  })

  it('asks for camera, microphone or both from a media request', () => {
    expect(classifyPermission('media', { mediaTypes: ['video'] })).toEqual({ action: 'ask', perms: ['camera'] })
    expect(classifyPermission('media', { mediaTypes: ['audio'] })).toEqual({ action: 'ask', perms: ['microphone'] })
    expect(classifyPermission('media', { mediaTypes: ['video', 'audio'] })).toEqual({ action: 'ask', perms: ['camera', 'microphone'] })
    // A media request that names neither asks for both, so nothing slips through.
    expect(mediaPerms([])).toEqual(['camera', 'microphone'])
    expect(mediaPerms(undefined)).toEqual(['camera', 'microphone'])
  })

  it('opens mail links without asking, and asks for other apps', () => {
    expect(classifyPermission('openExternal', { url: 'mailto:hi@example.com' })).toEqual({ action: 'allow' })
    expect(classifyPermission('openExternal', { url: 'MAILTO:hi@example.com' })).toEqual({ action: 'allow' })
    expect(classifyPermission('openExternal', { url: 'zoommtg://join?id=1' })).toEqual({ action: 'ask', perms: ['external-app'] })
    expect(isSilentExternal('slack://open')).toBe(false)
  })

  it('gives Apex pages the clipboard, and only Apex pages', () => {
    expect(classifyPermission('clipboard-read', { origin: 'app://apex' })).toEqual({ action: 'allow' })
    expect(classifyPermission('clipboard-read', { origin: 'apex://settings' })).toEqual({ action: 'allow' })
    expect(classifyPermission('clipboard-read', { origin: 'https://example.com' })).toEqual({ action: 'ask', perms: ['clipboard-read'] })
    expect(isApexOrigin('https://apex.example')).toBe(false)
  })

  it('treats the device classes as the chooser’s', () => {
    expect([...DEVICE_PERMISSIONS].sort()).toEqual(['bluetooth', 'hid', 'serial', 'usb'])
    for (const p of DEVICE_PERMISSIONS) expect(SITE_PERMISSIONS).toContain(p)
  })

  it('reads the scheme of an external link', () => {
    expect(externalScheme('ZoomMtg://join')).toBe('zoommtg')
    expect(externalScheme('not a link')).toBeNull()
  })
})

describe('what an answer may be remembered as', () => {
  it('keeps only a deny for MIDI, screen capture and the file system', () => {
    for (const p of ['midi', 'screen', 'file-system'] as const) {
      expect(rememberable(p)).toBe('deny-only')
      expect(canRemember([p], false)).toBe(true)
      expect(canRemember([p], true)).toBe(false)
      expect(decisionOptions(p)).toEqual(['ask', 'block'])
    }
  })

  it('keeps only an allow for external apps', () => {
    expect(rememberable('external-app')).toBe('allow-only')
    expect(canRemember(['external-app'], true)).toBe(true)
    expect(canRemember(['external-app'], false)).toBe(false)
    expect(decisionOptions('external-app')).toEqual(['ask', 'allow'])
  })

  it('keeps either answer for everything else', () => {
    for (const p of ['camera', 'microphone', 'location', 'notifications', 'clipboard-read'] as const) {
      expect(rememberable(p)).toBe('both')
      expect(decisionOptions(p)).toEqual(['ask', 'allow', 'block'])
    }
    expect(canRemember([], true)).toBe(false)
  })

  it('offers the prompt only the remember choice the rules allow', () => {
    expect(rememberChoice(['camera', 'microphone'])).toBe('both')
    expect(rememberChoice(['midi'])).toBe('deny')
    expect(rememberChoice(['external-app'])).toBe('allow')
    // Mixed rules: only a deny is safe to keep for both.
    expect(rememberChoice(['camera', 'midi'])).toBe('deny')
    expect(rememberChoice(['external-app', 'midi'])).toBeNull()
  })

  it('folds several stored answers into one', () => {
    expect(combineDecisions([])).toBe('ask')
    expect(combineDecisions(['allow', 'allow'])).toBe('allow')
    expect(combineDecisions(['allow', 'ask'])).toBe('ask')
    expect(combineDecisions(['allow', 'block'])).toBe('block')
  })
})

describe('origin keys', () => {
  it('keys web pages by scheme, host and port, lowercased', () => {
    expect(siteKey('https://Example.COM/path?q=1#x')).toBe('https://example.com')
    expect(siteKey('http://localhost:3000/a')).toBe('http://localhost:3000')
    expect(siteKey('https://example.com:443/')).toBe('https://example.com')
    expect(siteKey('https://example.com:8443/')).toBe('https://example.com:8443')
  })

  it('gives non-web pages no key', () => {
    for (const url of ['file:///tmp/a.html', 'data:text/html,hi', 'about:blank', 'apex://settings', 'chrome-extension://abc/page.html', 'not a url']) {
      expect(siteKey(url)).toBeNull()
    }
  })

  it('shares one prompt between identical requests, whatever the order of permissions', () => {
    expect(promptKey('t1', 'https://a.com', ['microphone', 'camera'])).toBe(promptKey('t1', 'https://a.com', ['camera', 'microphone']))
    expect(promptKey('t1', 'https://a.com', ['camera'])).not.toBe(promptKey('t2', 'https://a.com', ['camera']))
    expect(promptKey('t1', 'https://a.com', ['external-app'], 'zoommtg')).not.toBe(promptKey('t1', 'https://a.com', ['external-app'], 'slack'))
  })
})

describe('permission overrides', () => {
  it('lets overrides decide first, and removes them cleanly', () => {
    const request = { origin: 'chrome-extension://abc', permission: 'notifications', session: {} as never, webContents: null }
    expect(permissionPolicy.override(request)).toBeNull()
    const off = permissionPolicy.addOverride((r) => (r.origin.startsWith('chrome-extension://') ? 'allow' : null))
    expect(permissionPolicy.override(request)).toBe('allow')
    expect(permissionPolicy.override({ ...request, origin: 'https://a.com' })).toBeNull()
    off()
    expect(permissionPolicy.override(request)).toBeNull()
  })
})

describe('whose question a request is (permission delegation)', () => {
  const top = 'https://meet.example'
  it('keys a same-origin frame, and an about:blank one, on the top-level page', () => {
    expect(frameScope(top, top, true, ['camera'])).toEqual({ key: top, embedded: null })
    expect(frameScope('https://meet.example', top, false, ['camera'])).toEqual({ key: top, embedded: null })
    expect(frameScope('about:blank', top, false, ['location'])).toEqual({ key: top, embedded: null })
  })

  it('keys a delegated cross-origin frame on the top-level page, and names the frame', () => {
    expect(frameScope('https://video.vendor.com', top, false, ['camera', 'microphone'])).toEqual({ key: top, embedded: 'https://video.vendor.com' })
  })

  it('refuses what a cross-origin frame can never be given, and opaque frames', () => {
    expect(frameScope('https://ads.example.net', top, false, ['notifications'])).toBeNull()
    expect(frameScope('data:text/html,hi', top, false, ['camera'])).toBeNull()
    expect(frameScope(top, 'file:///tmp/a.html', true, ['camera'])).toBeNull()
  })
})

describe('secure contexts', () => {
  it('counts https and this computer as secure, and other http as not', () => {
    for (const o of ['https://a.com', 'http://localhost:3000', 'http://app.localhost', 'http://127.0.0.1:8080', 'http://[::1]:5173']) expect(isSecureOrigin(o)).toBe(true)
    for (const o of ['http://a.com', 'http://192.168.1.4', 'ftp://a.com', 'not a url']) expect(isSecureOrigin(o)).toBe(false)
  })

  it('keeps powerful features from insecure pages and insecure frames', () => {
    for (const p of ['camera', 'microphone', 'location', 'notifications', 'clipboard-read', 'midi', 'screen', 'hid', 'usb', 'serial', 'bluetooth', 'local-fonts', 'idle-detection', 'window-management'] as const) {
      expect(secureEnough({ key: 'http://a.com', embedded: null }, [p])).toBe(false)
      expect(secureEnough({ key: 'https://a.com', embedded: null }, [p])).toBe(true)
      expect(secureEnough({ key: 'https://a.com', embedded: 'http://b.com' }, [p])).toBe(false)
    }
    // Opening an app from an http page is still a question.
    expect(secureEnough({ key: 'http://a.com', embedded: null }, ['external-app'])).toBe(true)
  })
})

describe('the site verdict before a prompt', () => {
  const base = { stored: {}, once: undefined, defaults: {}, embargoed: () => false }
  it('reads a stored answer first, then the tab’s one-off answer', () => {
    expect(siteVerdict({ ...base, perms: ['camera'], stored: { camera: 'block' }, once: true })).toEqual({ verdict: 'block', reason: 'stored' })
    expect(siteVerdict({ ...base, perms: ['camera'], stored: { camera: 'allow' }, once: false })).toEqual({ verdict: 'allow' })
    expect(siteVerdict({ ...base, perms: ['camera'], once: true })).toEqual({ verdict: 'allow' })
    expect(siteVerdict({ ...base, perms: ['camera'], once: false })).toEqual({ verdict: 'block', reason: 'once' })
  })

  it('applies a Block default only where the site has no answer of its own', () => {
    const defaults = { notifications: 'block' as const, camera: 'block' as const }
    expect(siteVerdict({ ...base, perms: ['notifications'], defaults })).toEqual({ verdict: 'block', reason: 'default' })
    expect(siteVerdict({ ...base, perms: ['notifications'], defaults, stored: { notifications: 'allow' } })).toEqual({ verdict: 'allow' })
    expect(siteVerdict({ ...base, perms: ['location'], defaults })).toEqual({ verdict: 'ask' })
    // Camera and microphone together: the microphone has no answer, the camera's default blocks.
    expect(siteVerdict({ ...base, perms: ['camera', 'microphone'], defaults, stored: { microphone: 'allow' } })).toEqual({ verdict: 'block', reason: 'default' })
  })

  it('blocks an embargoed question without asking', () => {
    expect(siteVerdict({ ...base, perms: ['location'], embargoed: (p) => p === 'location' })).toEqual({ verdict: 'block', reason: 'embargo' })
    expect(siteVerdict({ ...base, perms: ['location'], stored: { location: 'allow' }, embargoed: () => true })).toEqual({ verdict: 'allow' })
  })

  it('keeps one-off answers per permission, so a camera-and-microphone answer answers a camera check', () => {
    const answers = new Map([
      [oneOffKey('https://a.com', 'camera'), true],
      [oneOffKey('https://a.com', 'microphone'), true],
    ])
    expect(oneOffAnswer(answers, 'https://a.com', ['camera'])).toBe(true)
    expect(oneOffAnswer(answers, 'https://a.com', ['camera', 'microphone'])).toBe(true)
    expect(oneOffAnswer(answers, 'https://a.com', ['camera', 'location'])).toBeUndefined()
    answers.set(oneOffKey('https://a.com', 'location'), false)
    expect(oneOffAnswer(answers, 'https://a.com', ['camera', 'location'])).toBe(false)
    expect(oneOffAnswer(answers, 'https://b.com', ['camera'])).toBeUndefined()
  })

  it('reports never asked as prompt, not denied', () => {
    expect(queryState('ask')).toBe('prompt')
    expect(queryState('allow')).toBe('granted')
    expect(queryState('block')).toBe('denied')
    expect(QUERY_NAMES.geolocation).toBe('location')
    expect(QUERY_NAMES.push).toBe('notifications')
    for (const perm of Object.values(QUERY_NAMES)) expect(SITE_PERMISSIONS).toContain(perm)
  })
})

describe('dismissals and the embargo', () => {
  it('blocks a question for a week after the third dismissal in a row, then lets it ask again', () => {
    let h = afterDismissal(undefined, 0)
    expect(h.dismissals).toBe(1)
    for (let i = 1; i < EMBARGO_DISMISSALS; i++) h = afterDismissal(h, 1000)
    expect(isEmbargoed(h, 1000)).toBe(true)
    expect(isEmbargoed(h, 1000 + EMBARGO_MS - 1)).toBe(true)
    expect(isEmbargoed(h, 1000 + EMBARGO_MS)).toBe(false)
    // After the embargo the count starts over.
    expect(afterDismissal(h, 1000 + EMBARGO_MS).dismissals).toBe(1)
  })

  it('ends the count with an answer, and remembers a refusal', () => {
    const twice = afterDismissal(afterDismissal(undefined, 0), 0)
    expect(afterAnswer(twice, true)).toEqual({ dismissals: 0 })
    expect(afterAnswer(twice, false)).toEqual({ dismissals: 0, refused: true })
  })

  it('asks quietly for notifications when turned on, or once the prompt was put away or refused', () => {
    expect(asksQuietly(['notifications'], false, undefined)).toBe(false)
    expect(asksQuietly(['notifications'], true, undefined)).toBe(true)
    expect(asksQuietly(['notifications'], false, { dismissals: 1 })).toBe(true)
    expect(asksQuietly(['notifications'], false, { dismissals: 0, refused: true })).toBe(true)
    expect(asksQuietly(['camera'], true, { dismissals: 2 })).toBe(false)
  })
})
