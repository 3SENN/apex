/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { commandLine: { getSwitchValue: () => '', appendSwitch: () => undefined } }, webContents: { fromFrame: () => undefined }, dialog: {} }))

import { SYSTEM_PASSKEYS_ARG, cappedTimeout, honestCapabilities, webAuthnDecision, WEBAUTHN_MAX_TIMEOUT_MS, type WebAuthnCall } from '@shared/webauthnPolicy'
import { cookiesBlocked } from '../src/main/privacy'
import {
  accountLabel,
  applySignInSwitches,
  configurePasskeys,
  mergeFeatureList,
  pagePasskeyArguments,
  passkeyPlan,
  storageAccessAnswer,
  touchIdGroup,
  webAuthnKeychainGroup,
  webAuthnOptions,
} from '../src/main/signInCompat'
import { chosenAccount, passkeyChooserSpec } from '../src/main/features/signInCompat'

// Sign-in compatibility (docs/architecture.md): FedCM's switch, WebAuthn's
// fail-fast table and capabilities, the Touch ID entitlement check, the
// Storage Access answer, the passkey chooser and the cookie exemption for
// sign-in providers.

const call = (c: Partial<WebAuthnCall> & Pick<WebAuthnCall, 'kind'>): WebAuthnCall => ({ platform: false, ...c })

describe('FedCM switch', () => {
  it('merges FedCm into --disable-features without dropping or doubling names', () => {
    expect(mergeFeatureList('', ['FedCm'])).toBe('FedCm')
    expect(mergeFeatureList('A, B', ['FedCm'])).toBe('A,B,FedCm')
    expect(mergeFeatureList('FedCm,A', ['FedCm'])).toBe('FedCm,A')
  })

  it('appends the merged value to the command line', () => {
    const appended: [string, string | undefined][] = []
    applySignInSwitches({ getSwitchValue: () => 'Foo', appendSwitch: (k: string, v?: string) => void appended.push([k, v]) })
    expect(appended).toEqual([['disable-features', 'Foo,FedCm']])
  })
})

describe('WebAuthn without a passkey sheet', () => {
  it('refuses at once what only a platform authenticator, a phone or a PIN sheet could answer', () => {
    expect(webAuthnDecision(call({ kind: 'create', attachment: 'platform' }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'create', residentKey: 'required' }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'create', requireResidentKey: true }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'create', userVerification: 'required' }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'get', allow: null }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'get', allow: [] }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'get', allow: [['internal'], ['hybrid']] }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'get', allow: [['usb']], hints: ['hybrid'] }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'get', allow: [['usb']], userVerification: 'required' }))).toBe('reject')
  })

  it('hands security-key calls to Chromium and holds conditional (autofill) ones', () => {
    expect(webAuthnDecision(call({ kind: 'create', residentKey: 'discouraged', userVerification: 'discouraged' }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'create', residentKey: 'preferred', attachment: 'cross-platform' }))).toBe('pass')
    // residentKey wins over the older requireResidentKey.
    expect(webAuthnDecision(call({ kind: 'create', residentKey: 'discouraged', requireResidentKey: true }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'get', allow: [['usb', 'nfc']] }))).toBe('pass')
    // A credential without transports may be a key.
    expect(webAuthnDecision(call({ kind: 'get', allow: [['internal'], []] }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'get', allow: [['usb']], hints: ['security-key', 'hybrid'] }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'get', mediation: 'conditional', allow: null }))).toBe('hold')
    expect(webAuthnDecision(call({ kind: 'get', mediation: 'conditional', platform: true }))).toBe('hold')
  })

  it('lets passkey calls through once Touch ID is configured, but never phone-only ones', () => {
    expect(webAuthnDecision(call({ kind: 'create', platform: true, attachment: 'platform', residentKey: 'required', userVerification: 'required' }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'get', platform: true, allow: null }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'get', platform: true, allow: [['internal']] }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'get', platform: true, allow: [['hybrid']] }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'get', platform: true, hints: ['hybrid'] }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'get', platform: true, hints: ['client-device'] }))).toBe('pass')
  })

  it('reports only what Atelier can do in getClientCapabilities', () => {
    const native = { conditionalGet: true, conditionalCreate: true, hybridTransport: true, passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: false, immediateGet: true, relatedOrigins: true, 'extension:prf': true }
    expect(honestCapabilities(native, false)).toEqual({ ...native, conditionalGet: false, conditionalCreate: false, hybridTransport: false, passkeyPlatformAuthenticator: false, immediateGet: false })
    expect(honestCapabilities(native, true)).toMatchObject({ passkeyPlatformAuthenticator: true, userVerifyingPlatformAuthenticator: true, hybridTransport: false })
  })

  it('caps a pass-through call’s timeout so it settles', () => {
    expect(cappedTimeout(30_000)).toBe(30_000)
    expect(cappedTimeout(300_000)).toBe(WEBAUTHN_MAX_TIMEOUT_MS)
    expect(cappedTimeout(undefined)).toBe(WEBAUTHN_MAX_TIMEOUT_MS)
    expect(cappedTimeout(-5)).toBe(WEBAUTHN_MAX_TIMEOUT_MS)
  })
})

describe('passkeys follow the signature', () => {
  const plist = (groups: string[], browser = false): string =>
    `<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/>${browser ? '<key>com.apple.developer.web-browser.public-key-credential</key><true/>' : ''}<key>keychain-access-groups</key><array>${groups.map((g) => `<string>${g}</string>`).join('')}</array></dict></plist>`
  const GROUP = 'ABCDE12345.com.sennechin.atelier.webauthn'

  it('finds the .webauthn group', () => {
    expect(webAuthnKeychainGroup(plist(['ABCDE12345.com.sennechin.atelier.shared', GROUP]))).toBe(GROUP)
    expect(webAuthnKeychainGroup(plist(['ABCDE12345.com.sennechin.atelier']))).toBeNull()
    expect(webAuthnKeychainGroup('<plist><dict></dict></plist>')).toBeNull()
    expect(webAuthnKeychainGroup(null)).toBeNull()
  })

  it('turns Touch ID on only for a group of the team that signed the app', () => {
    expect(touchIdGroup(plist([GROUP]), 'ABCDE12345')).toBe(GROUP)
    expect(touchIdGroup(plist(['ZZZZZ99999.com.sennechin.atelier.webauthn']), 'ABCDE12345')).toBeNull()
    expect(touchIdGroup(plist([GROUP]), null)).toBeNull()
  })

  it('offers the system passkey sheet only with the browser entitlement, and nothing unsigned', () => {
    expect(passkeyPlan(null)).toEqual({ on: false, reason: 'unsigned' })
    expect(passkeyPlan({ teamId: null, entitlements: plist([GROUP], true) })).toEqual({ on: false, reason: 'unsigned' })
    expect(passkeyPlan({ teamId: 'ABCDE12345', entitlements: plist([]) })).toEqual({ on: false, reason: 'no-entitlement' })
    expect(passkeyPlan({ teamId: 'ABCDE12345', entitlements: plist([GROUP]) })).toEqual({ on: true, touchIdGroup: GROUP, platformPasskeys: false })
    expect(passkeyPlan({ teamId: 'ABCDE12345', entitlements: plist([], true) })).toEqual({ on: true, touchIdGroup: null, platformPasskeys: true })
    const both = passkeyPlan({ teamId: 'ABCDE12345', entitlements: plist([GROUP], true) })
    expect(both).toEqual({ on: true, touchIdGroup: GROUP, platformPasskeys: true })
    expect(webAuthnOptions(both as Extract<typeof both, { on: true }>)).toEqual({ touchID: { keychainAccessGroup: GROUP }, platformPasskeys: true })
    expect(webAuthnOptions({ on: true, touchIdGroup: null, platformPasskeys: true })).toEqual({ platformPasskeys: true })
  })

  it('leaves an unsigned or unpackaged Atelier exactly as it was, and tells pages about the sheet only when it is on', () => {
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      expect(configurePasskeys({ packaged: false })).toEqual({ on: false, reason: 'not-packaged' })
      expect(pagePasskeyArguments()).toEqual([])
      expect(configurePasskeys({ packaged: true, signature: { identifier: 'Electron', teamId: null, entitlements: null } })).toEqual({ on: false, reason: 'unsigned' })
      expect(pagePasskeyArguments()).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: real })
    }
  })
})

describe('WebAuthn with the system passkey sheet', () => {
  it('passes every call the sheet can show, and still holds autofill requests', () => {
    const sheet = { platform: true, sheet: true }
    expect(webAuthnDecision(call({ kind: 'get', ...sheet }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'get', ...sheet, hints: ['hybrid'] }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'get', ...sheet, allow: [['hybrid']] }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'create', ...sheet, attachment: 'platform', residentKey: 'required', userVerification: 'required' }))).toBe('pass')
    expect(webAuthnDecision(call({ kind: 'get', ...sheet, mediation: 'conditional' }))).toBe('hold')
  })

  it('keeps the fail-fast table without it', () => {
    expect(webAuthnDecision(call({ kind: 'get', hints: ['hybrid'] }))).toBe('reject')
    expect(webAuthnDecision(call({ kind: 'get', platform: true, sheet: false, hints: ['hybrid'] }))).toBe('reject')
    expect(SYSTEM_PASSKEYS_ARG).toMatch(/^--atelier-/)
  })
})

describe('the passkey account chooser', () => {
  const accounts = [{ credentialId: 'c1', name: 'ann@example.com' }, { credentialId: 'c2', displayName: 'Bo' }, { credentialId: 'c3' }]

  it('labels each account with the site’s own name for it', () => {
    expect(accountLabel(accounts[0]!, 'Account 1')).toBe('ann@example.com')
    expect(accountLabel(accounts[1]!, 'Account 2')).toBe('Bo')
    expect(accountLabel(accounts[2]!, 'Account 3')).toBe('Account 3')
  })

  it('offers a button per account and maps the answer back to its credential', () => {
    const spec = passkeyChooserSpec('example.com', accounts)
    expect(spec.buttons.map((b) => b.id)).toEqual(['account:0', 'account:1', 'account:2', 'cancel'])
    expect(spec.buttons.find((b) => b.id === 'cancel')?.escape).toBe(true)
    expect(chosenAccount('account:1', accounts)).toBe('c2')
    expect(chosenAccount('cancel', accounts)).toBeNull()
    expect(chosenAccount(null, accounts)).toBeNull()
    expect(chosenAccount('account:9', accounts)).toBeNull()
  })
})

describe('third-party cookies and storage access for sign-in providers', () => {
  const rules = (map: Record<string, 'allow' | 'block'> = {}) => (origin: string) => map[origin] ?? 'default'
  const site = 'https://shop.example/checkout'

  it('keeps a provider’s cookies in its embedded widgets while blocking others', () => {
    expect(cookiesBlocked('https://accounts.google.com/gsi/iframe/select', site, true, rules())).toBe(false)
    expect(cookiesBlocked('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?prompt=none', site, true, rules())).toBe(false)
    expect(cookiesBlocked('https://appleid.apple.com/auth/authorize', site, true, rules())).toBe(false)
    expect(cookiesBlocked('https://tracker.example/p', site, true, rules())).toBe(true)
    // A provider's main site outside its sign-in pages is an ordinary third party.
    expect(cookiesBlocked('https://www.facebook.com/plugins/like.php', site, true, rules())).toBe(true)
    // A sign-in page's own cross-site requests keep theirs.
    expect(cookiesBlocked('https://accounts.youtube.com/accounts/CheckConnection', 'https://accounts.google.com/v3/signin/identifier', true, rules())).toBe(false)
    // A site you blocked stays blocked.
    expect(cookiesBlocked('https://accounts.google.com/gsi/iframe/select', site, true, rules({ 'https://accounts.google.com': 'block' }))).toBe(true)
  })

  it('answers requestStorageAccess: always while cookies are allowed, only for providers while blocked', () => {
    expect(storageAccessAnswer('storage-access', 'https://widget.example', false)).toBe('allow')
    expect(storageAccessAnswer('storage-access', 'https://widget.example', true)).toBeNull()
    expect(storageAccessAnswer('storage-access', 'https://accounts.google.com', true)).toBe('allow')
    expect(storageAccessAnswer('top-level-storage-access', 'https://accounts.google.com', false)).toBeNull()
    expect(storageAccessAnswer('geolocation', 'https://accounts.google.com', false)).toBeNull()
  })
})
