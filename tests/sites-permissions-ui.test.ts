/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SITE_SETTINGS, NO_CAPTURE, type ScreenSource, type SiteSettingsEntry } from '@shared/sites'
import { deviceEntry, deviceKey } from '../src/main/devices'
import { cookieInDomain, groupCookies } from '../src/main/siteData'
import {
  askPhrase,
  capturingKinds,
  cookieExceptions,
  filterData,
  filterDevices,
  filterSites,
  formatFingerprint,
  mediaNoun,
  parseSiteInput,
  pickerGroup,
  rememberApplies,
  rememberLabel,
  revokePatch,
  sharingMessage,
  sizeLabel,
  splitHost,
  splitPermissions,
  switchPatch,
  switchStates,
  validPin,
} from '../src/renderer/src/overlay/surfaces/sites/logic'
import { PROMPT_INPUT_DELAY_MS, inputArmed, macosNouns, macosPane, permissionChips, promptKeyAction, promptOrigin } from '../src/renderer/src/overlay/surfaces/sites/promptLogic'
import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionPromptProps } from '@shared/overlay/sites'
import type { PermissionActivity } from '@shared/sites'

// What the site permission surfaces show (SH-37, OV-14, OV-15).

const globals = { adblock: true, popupBlocking: true }

describe('site info', () => {
  it('lists answered and in-use permissions first and folds the rest away', () => {
    const settings = { ...DEFAULT_SITE_SETTINGS, permissions: { location: 'block' as const } }
    const { set, unset } = splitPermissions(settings, { ...NO_CAPTURE, camera: true })
    expect(set).toEqual([
      { perm: 'camera', decision: 'ask' },
      { perm: 'location', decision: 'block' },
    ])
    expect(unset).not.toContain('camera')
    expect(unset).not.toContain('location')
    expect(unset).toContain('microphone')
  })

  it('shows switches against the global settings', () => {
    expect(switchStates({ settings: DEFAULT_SITE_SETTINGS, globals })).toEqual({ adblock: true, sound: true, popups: false })
    expect(switchStates({ settings: { ...DEFAULT_SITE_SETTINGS, adblock: 'allow', sound: 'block', popups: 'allow' }, globals })).toEqual({ adblock: false, sound: false, popups: true })
  })

  it('stores a switch as an exception only when it differs from the default', () => {
    expect(switchPatch('adblock', true, globals)).toEqual({ adblock: 'default' })
    expect(switchPatch('adblock', false, globals)).toEqual({ adblock: 'allow' })
    expect(switchPatch('adblock', true, { ...globals, adblock: false })).toEqual({ adblock: 'block' })
    expect(switchPatch('popups', true, globals)).toEqual({ popups: 'allow' })
    expect(switchPatch('popups', false, globals)).toEqual({ popups: 'default' })
    expect(switchPatch('sound', false, globals)).toEqual({ sound: 'block' })
    expect(switchPatch('sound', true, globals)).toEqual({ sound: 'default' })
  })

  it('highlights the registrable domain', () => {
    expect(splitHost('mail.example.co.uk', 'example.co.uk')).toEqual({ before: 'mail.', registrable: 'example.co.uk' })
    expect(splitHost('localhost', '')).toEqual({ before: '', registrable: 'localhost' })
  })

  it('formats certificate fingerprints and storage sizes', () => {
    expect(formatFingerprint('ab01ff')).toBe('AB:01:FF')
    expect(formatFingerprint('AB:01:ff')).toBe('AB:01:FF')
    expect(sizeLabel(0)).toBe('0 KB')
    expect(sizeLabel(512)).toBe('512 B')
    expect(sizeLabel(1536)).toBe('1.5 KB')
    expect(sizeLabel(50 * 1024 * 1024)).toBe('50 MB')
  })
})

describe('the permission prompt', () => {
  it('names camera and microphone together', () => {
    expect(askPhrase(['camera', 'microphone'])).toEqual([['sites.ask.cameraAndMicrophone']])
    expect(askPhrase(['location'])).toEqual([['sites.ask.location']])
  })

  it('labels the remember choice by what may be kept', () => {
    expect(rememberLabel({ remember: null, host: 'a.com', scheme: null })).toBeNull()
    expect(rememberLabel({ remember: 'both', host: 'a.com', scheme: null })).toEqual(['sites.prompt.remember'])
    expect(rememberLabel({ remember: 'deny', host: 'a.com', scheme: null })).toEqual(['sites.prompt.rememberDeny'])
    expect(rememberLabel({ remember: 'allow', host: 'a.com', scheme: 'zoommtg' })).toEqual(['sites.prompt.rememberApp', { host: 'a.com', scheme: 'zoommtg' }])
  })

  it('applies the remember choice only to answers it may keep', () => {
    expect(rememberApplies('both', true)).toBe(true)
    expect(rememberApplies('deny', true)).toBe(false)
    expect(rememberApplies('deny', false)).toBe(true)
    expect(rememberApplies('allow', false)).toBe(false)
    expect(rememberApplies(null, true)).toBe(false)
  })
})

describe('the sharing bar', () => {
  it('says what is shared, screen and tab first', () => {
    expect(sharingMessage('meet.example', { camera: true, microphone: true, screen: true }, 'Docs')).toEqual({ key: 'sites.sharing.tab', host: 'meet.example', tab: 'Docs' })
    expect(sharingMessage('meet.example', { ...NO_CAPTURE, screen: true }, null)).toEqual({ key: 'sites.sharing.screen', host: 'meet.example' })
    expect(sharingMessage('meet.example', { ...NO_CAPTURE, microphone: true }, null)).toEqual({ key: 'sites.sharing.using', host: 'meet.example', what: 'sites.noun.microphone' })
    expect(sharingMessage('meet.example', NO_CAPTURE, null)).toBeNull()
    expect(mediaNoun(true, true)).toBe('sites.noun.cameraAndMicrophone')
    expect(capturingKinds({ camera: true, microphone: false, screen: true })).toEqual(['camera', 'screen'])
  })

  it('revokes only what is live', () => {
    expect(revokePatch({ camera: true, microphone: false, screen: true })).toEqual({ permissions: { camera: 'ask' } })
    expect(revokePatch({ ...NO_CAPTURE, screen: true })).toBeNull()
  })
})

describe('the screen picker and device chooser', () => {
  const source = (id: string, kind: ScreenSource['kind']): ScreenSource => ({ id, kind, name: id, thumbnail: null, icon: null, detail: null })

  it('opens on tabs, and falls back to the first group with sources', () => {
    expect(pickerGroup([source('tab:1', 'tab'), source('screen:1', 'screen')], 'tab')).toBe('tab')
    expect(pickerGroup([source('screen:1', 'screen')], 'tab')).toBe('screen')
    expect(pickerGroup([], 'window')).toBe('window')
  })

  it('searches devices by name and detail', () => {
    const devices = [
      { id: '1', name: 'Keyboard', detail: '046d:c31c' },
      { id: '2', name: 'Arduino', detail: null },
    ]
    expect(filterDevices(devices, ' ardu ').map((d) => d.id)).toEqual(['2'])
    expect(filterDevices(devices, '046d').map((d) => d.id)).toEqual(['1'])
    expect(filterDevices(devices, '')).toHaveLength(2)
    expect(filterDevices(devices, 'mouse')).toEqual([])
  })

  it('accepts Bluetooth PINs without spaces', () => {
    expect(validPin('123456')).toBe(true)
    expect(validPin(' 0000 ')).toBe(true)
    expect(validPin('')).toBe(false)
    expect(validPin('12 34')).toBe(false)
    expect(validPin('x'.repeat(17))).toBe(false)
  })

  it('keys devices so a remembered one is known after a restart', () => {
    expect(deviceKey('hid', { deviceId: 'session-1', vendorId: 0x46d, productId: 0xc31c, name: 'Kbd', serialNumber: 'S1' } as unknown as Electron.HIDDevice)).toBe(`${0x46d}:${0xc31c}:S1`)
    expect(deviceKey('serial', { portId: 'p', portName: 'COM3' } as unknown as Electron.SerialPort)).toBe('port:COM3')
    expect(deviceKey('bluetooth', { deviceId: 'AA:BB', deviceName: 'Buds' } as unknown as Electron.BluetoothDevice)).toBe('AA:BB')
  })

  it('names devices, with a fallback for nameless ones', () => {
    expect(deviceEntry('hid', { deviceId: 'h1', vendorId: 0x46d, productId: 0xc31c, name: '' } as unknown as Electron.HIDDevice, 'Unnamed device')).toEqual({ id: 'h1', name: 'Unnamed device', detail: '046d:c31c' })
    expect(deviceEntry('usb', { deviceId: 'u1', vendorId: 1, productId: 2, productName: 'Key', manufacturerName: 'Acme' } as unknown as Electron.USBDevice, 'x')).toEqual({ id: 'u1', name: 'Key', detail: 'Acme' })
    expect(deviceEntry('bluetooth', { deviceId: 'b1', deviceName: '' } as unknown as Electron.BluetoothDevice, 'Unnamed device')).toEqual({ id: 'b1', name: 'Unnamed device', detail: null })
  })
})

describe('site settings', () => {
  const entry = (origin: string, cookies: 'allow' | 'block' | 'default'): SiteSettingsEntry => ({ origin, settings: { ...DEFAULT_SITE_SETTINGS, cookies }, overrides: cookies === 'default' ? 0 : 1 })

  it('turns typed sites into origins', () => {
    expect(parseSiteInput('example.com')).toBe('https://example.com')
    expect(parseSiteInput('http://localhost:3000/x')).toBe('http://localhost:3000')
    expect(parseSiteInput('https://Example.com/path')).toBe('https://example.com')
    expect(parseSiteInput('intranet')).toBeNull()
    expect(parseSiteInput('two words')).toBeNull()
    expect(parseSiteInput('')).toBeNull()
  })

  it('searches sites and site data', () => {
    expect(filterSites([entry('https://a.example', 'block'), entry('https://b.test', 'allow')], 'B.T').map((e) => e.origin)).toEqual(['https://b.test'])
    const data = [
      { domain: 'example.com', cookies: 3, hosts: ['mail.example.com'] },
      { domain: 'other.org', cookies: 1, hosts: ['other.org'] },
    ]
    expect(filterData(data, 'mail').map((d) => d.domain)).toEqual(['example.com'])
  })

  it('lists cookie exceptions', () => {
    expect(cookieExceptions([entry('https://a.example', 'block'), entry('https://b.example', 'default'), entry('https://c.example', 'allow')])).toEqual([
      { origin: 'https://a.example', cookies: 'block' },
      { origin: 'https://c.example', cookies: 'allow' },
    ])
  })

  it('groups cookies by registrable domain, most first', () => {
    const groups = groupCookies([{ domain: '.example.com' }, { domain: 'mail.example.com' }, { domain: 'other.org' }, { domain: '' }])
    expect(groups).toEqual([
      { domain: 'example.com', cookies: 2, hosts: ['example.com', 'mail.example.com'] },
      { domain: 'other.org', cookies: 1, hosts: ['other.org'] },
    ])
    expect(cookieInDomain({ domain: '.mail.example.com' }, 'Example.com')).toBe(true)
    expect(cookieInDomain({ domain: 'example.org' }, 'example.com')).toBe(false)
  })
})

// The permissions pass: a prompt that can't be answered by accident, the asker shown by its origin, and the pill's chips.
describe('the permission prompt can’t be answered by accident', () => {
  it('ignores presses until it has been on screen for the delay', () => {
    expect(PROMPT_INPUT_DELAY_MS).toBeGreaterThanOrEqual(500)
    expect(inputArmed(null, 10_000)).toBe(false)
    expect(inputArmed(1000, 1000)).toBe(false)
    expect(inputArmed(1000, 1000 + PROMPT_INPUT_DELAY_MS - 1)).toBe(false)
    expect(inputArmed(1000, 1000 + PROMPT_INPUT_DELAY_MS)).toBe(true)
    // Shown again (back from another tab): the clock restarts from the new time.
    expect(inputArmed(5000, 5100)).toBe(false)
  })

  it('lets no key allow; Esc puts it away undecided', () => {
    for (const key of ['Enter', ' ', 'y', 'Tab', 'ArrowRight']) expect(promptKeyAction(key)).toBeNull()
    expect(promptKeyAction('Escape')).toBe('dismiss')
  })

  it('shows the asking origin with its scheme off https, its port off the default, and marks plain http', () => {
    expect(promptOrigin('https://example.com')).toEqual({ text: 'example.com', notSecure: false })
    expect(promptOrigin('https://example.com:443')).toEqual({ text: 'example.com', notSecure: false })
    expect(promptOrigin('https://www.example.com:8443')).toEqual({ text: 'www.example.com:8443', notSecure: false })
    expect(promptOrigin('http://example.com')).toEqual({ text: 'http://example.com', notSecure: true })
    expect(promptOrigin('http://example.com:8080')).toEqual({ text: 'http://example.com:8080', notSecure: true })
    // This computer isn't "not secure", but its scheme still shows.
    expect(promptOrigin('http://localhost:3000')).toEqual({ text: 'http://localhost:3000', notSecure: false })
    expect(promptOrigin('http://127.0.0.1')).toEqual({ text: 'http://127.0.0.1', notSecure: false })
    expect(promptOrigin('http://[::1]:5173')).toEqual({ text: 'http://[::1]:5173', notSecure: false })
    // Punycode stays as it is, so a lookalike can't pass for the real name.
    expect(promptOrigin('https://xn--pple-43d.com').text).toBe('xn--pple-43d.com')
    expect(promptOrigin('not a url')).toEqual({ text: 'not a url', notSecure: false })
  })
})

describe('the permission prompt’s markup', async () => {
  // The ui kit reads window.apex as it loads; the prompt's effects never run in a static render.
  vi.stubGlobal('window', { apex: { platform: 'darwin', onAppEvent: () => () => undefined } })
  afterAll(() => vi.unstubAllGlobals())
  const promptModule = '../src/renderer/src/overlay/surfaces/sites/PermissionPrompt'
  const { PermissionPrompt } = (await import(/* @vite-ignore */ promptModule)) as { PermissionPrompt: FunctionComponent<Record<string, unknown>> }
  const base: PermissionPromptProps = { requestId: 'r1', tabId: 't1', origin: 'https://meet.example', host: 'meet.example', perms: ['camera'], app: null, scheme: null, remember: 'both', systemBlocked: [] }
  const render = (props: Partial<PermissionPromptProps>): string =>
    renderToStaticMarkup(createElement(PermissionPrompt, { instanceId: 'i1', props: { ...base, ...props }, resolve: () => undefined, close: () => undefined, reportBounds: () => undefined, exiting: false, shown: true, anchor: { kind: 'point', x: 0, y: 0 }, windowId: 1 }))

  it('names the embedded frame that asks, under the site the answer is kept for', () => {
    expect(render({ embedded: 'maps.vendor.com' })).toContain('maps.vendor.com')
    expect(render({})).not.toContain('st-prompt__embedded')
  })

  it('puts first focus on the card, never on Allow or Open System Settings', () => {
    for (const html of [render({}), render({ systemBlocked: ['camera'] })]) {
      expect(html).toMatch(/^<div[^>]*role="alertdialog"[^>]*tabindex="-1"[^>]*data-autofocus="true"/)
      expect(html.match(/data-autofocus/g)).toHaveLength(1)
      expect(html).not.toMatch(/<button[^>]*autofocus/i)
    }
  })

  it('names an http asker with its scheme and a Not secure marker, and no longer says Enter allows', () => {
    const html = render({ origin: 'http://cam.example:8080', host: 'cam.example' })
    expect(html).toContain('Not secure')
    expect(html).toContain('http://cam.example:8080')
    expect(html).not.toContain('Enter allows')
    expect(render({})).not.toContain('Not secure')
  })

  it('names Location Services when macOS turned it off', () => {
    expect(render({ perms: ['location'], systemBlocked: ['location'], remember: null })).toContain('Location Services')
  })
})

describe('the address bar’s permission chips', () => {
  const at = (permission: PermissionActivity['permission'], outcome: PermissionActivity['outcome']): PermissionActivity => ({ tabId: 't1', origin: 'https://a.example', permission, outcome })

  it('shows nothing for a quiet page', () => {
    expect(permissionChips([])).toEqual([])
  })

  it('puts a held-back request first, then what macOS turned off, then what was refused, one chip each', () => {
    const chips = permissionChips([at('location', 'blocked'), at('camera', 'blocked-by-macos'), at('notifications', 'quiet'), at('midi', 'blocked'), at('location', 'blocked')])
    expect(chips.map((c) => [c.kind, c.perms])).toEqual([
      ['quiet', ['notifications']],
      ['macos', ['camera']],
      ['blocked', ['location', 'midi']],
    ])
    expect(chips[0]!.origin).toBe('https://a.example')
  })

  it('lists a permission macOS blocked only once, under macOS', () => {
    expect(permissionChips([at('camera', 'blocked-by-macos'), at('camera', 'blocked')]).map((c) => c.kind)).toEqual(['macos'])
  })

  it('opens the right System Settings pane and names what is off', () => {
    expect(macosPane(['microphone', 'camera'])).toBe('microphone')
    expect(macosPane(['location'])).toBe('location')
    expect(macosPane(['midi'])).toBeNull()
    expect(macosNouns(['camera', 'microphone'])).toEqual(['sites.noun.cameraAndMicrophone'])
    expect(macosNouns(['location', 'camera'])).toEqual(['sites.noun.camera', 'sites.noun.location'])
  })
})
