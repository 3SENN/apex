/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'
import { afterAll, describe, expect, it } from 'vitest'
import { APPLE_PASSWORDS_EXTENSION_ID as ID, APPLE_PASSWORDS_HOST as HOST, applePasswordsState, iconSaysPaired, launchRefused, type ApplePasswordsInputs } from '@shared/applePasswords'
import type { AutofillSettings } from '@shared/autofill'
import { checkHelper, createApplePasswords, packageFacts } from '../src/main/extensions/applePasswords'
import type { ExtensionsHost, HostObservation, NativeSeen } from '../src/main/extensions/host'
import { stepAsideForPasswordExtension } from '../src/main/autofill/offers'

// Apple Passwords (iCloud Keychain) on macOS: the card's status comes only
// from what Atelier observes (Apple's helper on disk, the extension running,
// its toolbar icon, the helper's replies on the native port), turning it on
// installs from the Web Store with one confirmation, and Atelier's own password
// offers step aside while it holds password saving. Fakes only.

const dir = mkdtempSync(join(tmpdir(), 'atelier-apple-passwords-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const base = (over: Partial<ApplePasswordsInputs> = {}): ApplePasswordsInputs => ({
  mac: true,
  installing: false,
  helper: { manifest: true, binary: true, allowsExtension: true },
  extension: { installed: true, enabled: true, running: true },
  port: { open: true, replied: true, closedWithError: null },
  iconPath: 'images/PasswordsToolbarUnpaired_icon32.png',
  lastHelperCmd: 14,
  codeRequested: false,
  ...over,
})

describe('the status', () => {
  it('walks from helper missing to ready', () => {
    expect(applePasswordsState(base({ mac: false }))).toBe('unavailable')
    expect(applePasswordsState(base({ helper: { manifest: false, binary: false, allowsExtension: false } }))).toBe('helper-missing')
    expect(applePasswordsState(base({ helper: { manifest: true, binary: false, allowsExtension: true } }))).toBe('helper-missing')
    expect(applePasswordsState(base({ helper: { manifest: true, binary: true, allowsExtension: false } }))).toBe('helper-missing')
    expect(applePasswordsState(base({ extension: { installed: false, enabled: false, running: false } }))).toBe('off')
    expect(applePasswordsState(base({ installing: true }))).toBe('installing')
    expect(applePasswordsState(base({ port: null }))).toBe('starting')
    expect(applePasswordsState(base({ port: { open: true, replied: false, closedWithError: null } }))).toBe('starting')
    expect(applePasswordsState(base())).toBe('not-paired')
    expect(applePasswordsState(base({ codeRequested: true, lastHelperCmd: 2 }))).toBe('waiting-for-code')
    expect(applePasswordsState(base({ iconPath: 'images/PasswordsToolbar-darkmode_icon32.png' }))).toBe('ready')
  })

  it('says when the helper closed the connection, or iCloud Passwords are off on the Mac', () => {
    expect(applePasswordsState(base({ port: { open: false, replied: false, closedWithError: 'Native host has exited.' } }))).toBe('helper-closed')
    expect(applePasswordsState(base({ lastHelperCmd: 9 }))).toBe('icloud-off')
    expect(applePasswordsState(base({ lastHelperCmd: 10 }))).toBe('icloud-off')
  })

  it('asks for a signed Atelier when macOS refuses to launch the helper, and only then', () => {
    const refused = { open: false, replied: false, closedWithError: 'Native host has exited.', launchRefused: true }
    expect(applePasswordsState(base({ port: refused }))).toBe('needs-signed-atelier')
    // Signed with the browser passkey entitlement, the helper may start: a closed port is the helper's own doing.
    expect(applePasswordsState(base({ port: refused, signedAsBrowser: true }))).toBe('helper-closed')
    expect(applePasswordsState(base({ port: { ...refused, launchRefused: false } }))).toBe('helper-closed')
  })

  it('tells a launch refusal from a helper that ran', () => {
    expect(launchRefused(null)).toBe(false)
    // Killed at exec by the launch constraint: SIGKILL before a byte.
    expect(launchRefused({ code: null, signal: 'SIGKILL', ms: 12, output: false })).toBe(true)
    // Checked its parent and left at once, silently.
    expect(launchRefused({ code: 1, signal: null, ms: 40, output: false })).toBe(true)
    expect(launchRefused({ code: 0, signal: null, ms: 40, output: true })).toBe(false)
    expect(launchRefused({ code: 0, signal: null, ms: 30_000, output: false })).toBe(false)
    expect(launchRefused({ code: null, signal: 'SIGTERM', ms: 40, output: false })).toBe(false)
  })

  it('reads pairing from the extension’s own icon names', () => {
    expect(iconSaysPaired(null)).toBeNull()
    expect(iconSaysPaired('images/PasswordsToolbarUnpaired-darkmode_icon16.png')).toBe(false)
    expect(iconSaysPaired('images/PasswordsToolbar_icon32.png')).toBe(true)
    expect(iconSaysPaired('icon.png')).toBeNull()
  })
})

describe('Apple’s helper on disk', () => {
  const helperDir = join(dir, 'helper')
  const bin = join(helperDir, 'Helper')
  mkdirSync(helperDir, { recursive: true })
  writeFileSync(bin, '#!/bin/sh\n')
  chmodSync(bin, 0o755)
  const write = (folder: string, m: unknown): void => {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, `${HOST}.json`), JSON.stringify(m))
  }

  it('finds the manifest, the binary and the extension in allowed_origins, first folder first', () => {
    const own = join(dir, 'own')
    const chrome = join(dir, 'chrome')
    expect(checkHelper([own, chrome])).toEqual({ manifest: false, binary: false, allowsExtension: false, path: null })
    write(chrome, { name: HOST, path: bin, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`, 'chrome-extension://mfbcdcnpokpoajjciilocoachedjkima/'] })
    expect(checkHelper([own, chrome])).toEqual({ manifest: true, binary: true, allowsExtension: true, path: bin })
    // Atelier's own folder wins, as in the host lookup.
    write(own, { name: HOST, path: join(dir, 'gone'), type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`] })
    expect(checkHelper([own, chrome])).toMatchObject({ manifest: true, binary: false })
    write(own, { name: HOST, path: bin, type: 'stdio', allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'] })
    expect(checkHelper([own, chrome])).toMatchObject({ manifest: true, binary: true, allowsExtension: false })
  })
})

describe('the package facts the prompt shows', () => {
  it('reads the manifest, the localized name and the icon from the archive', () => {
    const archive = Buffer.from(
      zipSync({
        'manifest.json': strToU8(JSON.stringify({ manifest_version: 3, name: '__MSG_extName__', default_locale: 'en', version: '1.0', icons: { '128': 'images/icon128.png' } })),
        '_locales/en/messages.json': strToU8(JSON.stringify({ extName: { message: 'Password Helper' } })),
        'images/icon128.png': new Uint8Array([137, 80, 78, 71]),
      }),
    )
    const facts = packageFacts(archive)
    expect(facts.name).toBe('Password Helper')
    expect(JSON.parse(facts.manifestJson).version).toBe('1.0')
    expect(facts.icon).toBe(`data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString('base64')}`)
  })
})

/** Just the host calls Apple Passwords makes. */
function fakeHost() {
  let installed = true
  let enabled = false
  let loaded = false
  let icon: string | null = null
  let held: { extensionId: string; name: string } | null = null
  let port: NativeSeen | null = null
  const calls: string[] = []
  const observers = new Set<(o: HostObservation) => void>()
  const host = {
    list: () => (installed ? [{ id: ID, enabled }] : []),
    isLoaded: () => loaded,
    nativeState: () => port,
    actionIconPath: () => icon,
    passwordSavingHeldOff: () => held,
    observe: (fn: (o: HostObservation) => void) => {
      observers.add(fn)
      return () => observers.delete(fn)
    },
    allowNativeHost: (_p: string, id: string, h: string) => void calls.push(`allow ${id} ${h}`),
    setEnabled: async (_p: string, _id: string, on: boolean) => {
      calls.push(`enabled ${on}`)
      enabled = on
      loaded = on
    },
    pin: (_p: string, _id: string, on: boolean) => void calls.push(`pin ${on}`),
    reload: async () => void calls.push('reload'),
    beginStoreInstall: async () => ({ ok: true, unsupported: null }),
    installPackage: async () => 'iCloud Passwords',
  }
  return {
    host: host as unknown as ExtensionsHost,
    calls,
    set: (o: { installed?: boolean; icon?: string | null; held?: typeof held; port?: NativeSeen | null }) => {
      if (o.installed !== undefined) installed = o.installed
      if (o.icon !== undefined) icon = o.icon
      if (o.held !== undefined) held = o.held
      if (o.port !== undefined) port = o.port
    },
    observe: (o: HostObservation) => {
      for (const fn of observers) fn(o)
    },
  }
}

describe('turning it on, pairing and turning it off', () => {
  const helperDirs = (): string[] => {
    const folder = join(dir, `hosts-${Math.random().toString(36).slice(2)}`)
    const bin = join(folder, 'Helper')
    mkdirSync(folder, { recursive: true })
    writeFileSync(bin, '#!/bin/sh\n')
    writeFileSync(join(folder, `${HOST}.json`), JSON.stringify({ name: HOST, path: bin, type: 'stdio', allowed_origins: [`chrome-extension://${ID}/`] }))
    return [folder]
  }

  it('turns an installed copy on with its helper allowed, pins it and opens its popup', async () => {
    const f = fakeHost()
    const popups: string[] = []
    const apple = createApplePasswords({ host: f.host, mac: true, hostDirs: helperDirs(), fetchCrx: async () => Buffer.alloc(0), openPopup: (p) => void popups.push(p), yieldSetting: () => true, emit: () => {} })
    f.set({ port: { open: true, replied: true, closedWithError: null } })
    const status = await apple.setOn('default', true)
    expect(f.calls).toEqual([`allow ${ID} ${HOST}`, 'enabled true', 'pin true'])
    expect(status).toMatchObject({ state: 'not-paired', installed: true, enabled: true, atelierStepsAside: false })
    await new Promise((r) => setTimeout(r, 20))
    expect(popups).toEqual(['default'])
    apple.dispose()
  })

  it('follows the helper’s replies to “waiting for the code”, then the icon to “ready”, with Atelier stepping aside', async () => {
    const f = fakeHost()
    const emitted: string[] = []
    const apple = createApplePasswords({ host: f.host, mac: true, hostDirs: helperDirs(), fetchCrx: async () => Buffer.alloc(0), openPopup: () => {}, yieldSetting: () => true, emit: (_p, s) => void emitted.push(s.state) })
    await apple.setOn('default', true)
    f.set({ port: { open: true, replied: true, closedWithError: null }, held: { extensionId: ID, name: 'iCloud Passwords' } })
    f.observe({ type: 'native', profileId: 'default', extensionId: ID, host: HOST, event: 'open' })
    f.observe({ type: 'native', profileId: 'default', extensionId: ID, host: HOST, event: 'message', message: { cmd: 14, capabilities: {} } })
    expect(apple.status('default').state).toBe('not-paired')
    f.observe({ type: 'native', profileId: 'default', extensionId: ID, host: HOST, event: 'message', message: { cmd: 2, payload: { QID: 'm0', PAKE: 'x' } } })
    expect(apple.status('default')).toMatchObject({ state: 'waiting-for-code', atelierStepsAside: true, otherController: null })
    f.set({ icon: 'images/PasswordsToolbar_icon32.png' })
    f.observe({ type: 'native', profileId: 'default', extensionId: ID, host: HOST, event: 'message', message: { cmd: 2, payload: { QID: 'm2', PAKE: 'y' } } })
    expect(apple.status('default').state).toBe('ready')
    await new Promise((r) => setTimeout(r, 80))
    expect(emitted.at(-1)).toBe('ready')
    // Another extension's messages, or another host's, change nothing.
    f.observe({ type: 'native', profileId: 'default', extensionId: 'b'.repeat(32), host: HOST, event: 'message', message: { cmd: 9 } })
    expect(apple.status('default').state).toBe('ready')
    apple.dispose()
  })

  it('refuses without the helper or off a Mac, and clears “installing” when a download fails verification', async () => {
    const f = fakeHost()
    f.set({ installed: false })
    const noHelper = createApplePasswords({ host: f.host, mac: true, hostDirs: [join(dir, 'empty')], fetchCrx: async () => Buffer.alloc(0), openPopup: () => {}, yieldSetting: () => true, emit: () => {} })
    await expect(noHelper.setOn('default', true)).rejects.toThrow()
    expect(noHelper.status('default').state).toBe('helper-missing')
    noHelper.dispose()
    const notMac = createApplePasswords({ host: f.host, mac: false, hostDirs: helperDirs(), fetchCrx: async () => Buffer.alloc(0), openPopup: () => {}, yieldSetting: () => true, emit: () => {} })
    await expect(notMac.setOn('default', true)).rejects.toThrow()
    expect(notMac.status('default').state).toBe('unavailable')
    notMac.dispose()
    const broken = createApplePasswords({ host: f.host, mac: true, hostDirs: helperDirs(), fetchCrx: async () => Buffer.from('not a crx'), openPopup: () => {}, yieldSetting: () => true, emit: () => {} })
    await expect(broken.setOn('default', true)).rejects.toThrow()
    expect(broken.status('default').state).toBe('off')
    broken.dispose()
  })

  it('turns off by turning the extension off, and pairs again by restarting it', async () => {
    const f = fakeHost()
    const apple = createApplePasswords({ host: f.host, mac: true, hostDirs: helperDirs(), fetchCrx: async () => Buffer.alloc(0), openPopup: () => {}, yieldSetting: () => true, emit: () => {} })
    await expect(apple.pairAgain('default')).rejects.toThrow()
    await apple.setOn('default', true)
    await apple.pairAgain('default')
    expect(f.calls).toContain('reload')
    expect((await apple.setOn('default', false)).enabled).toBe(false)
    apple.dispose()
  })

  it('names another password extension that holds password saving', async () => {
    const f = fakeHost()
    f.set({ held: { extensionId: 'c'.repeat(32), name: 'Other Vault' } })
    const apple = createApplePasswords({ host: f.host, mac: true, hostDirs: helperDirs(), fetchCrx: async () => Buffer.alloc(0), openPopup: () => {}, yieldSetting: () => false, emit: () => {} })
    expect(apple.status('default')).toMatchObject({ otherController: 'Other Vault', atelierStepsAside: false })
    apple.dispose()
  })
})

describe('Atelier’s own password offers step aside', () => {
  const settings: AutofillSettings = { offerLogins: true, offerSave: true, offerGenerated: true, addresses: true, addressAuth: true, cards: true, cardAuth: true, importHintDismissed: false, passwordsImported: false, yieldToPasswordExtension: true }

  it('turns off fill, generated and save offers for passwords only, and only while the person lets it', () => {
    expect(stepAsideForPasswordExtension(settings, null)).toBe(settings)
    expect(stepAsideForPasswordExtension(settings, 'iCloud Passwords')).toEqual({ ...settings, offerLogins: false, offerSave: false, offerGenerated: false })
    expect(stepAsideForPasswordExtension({ ...settings, yieldToPasswordExtension: false }, 'iCloud Passwords')).toEqual({ ...settings, yieldToPasswordExtension: false })
    const aside = stepAsideForPasswordExtension(settings, 'iCloud Passwords')
    expect([aside.addresses, aside.cards]).toEqual([true, true])
  })
})
