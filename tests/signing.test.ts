/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, verify } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DebugLogger } from 'builder-util'
import { validateConfiguration } from 'app-builder-lib/out/util/config/config'
import type { Configuration } from 'app-builder-lib'
import { describe, expect, it } from 'vitest'
import * as bundle from '../scripts/release/bundle.mjs'
import { loadBranding } from '../scripts/branding.mjs'
import { DEFAULT_BUNDLE_ID, bundleIdFrom, helperInfoPlist, requireTeamId, teamIdFrom, withBundleIdentifier } from '../scripts/release/bundle.mjs'
import { baseConfig, builderConfig, mergeConfig } from '../scripts/release/builderConfig.mjs'
import { RELEASE_ENV, loadReleaseEnv, parseReleaseEnv, releaseSettings, signingPlan, viteDefines } from '../scripts/release/config.mjs'
import {
  BROWSER_PASSKEY_ENTITLEMENT,
  decodeProfile,
  entitlementsFor,
  entitlementsXml,
  isRestricted,
  macSigningConfig,
  preflightProfile,
  profileAllowsKeychainGroup,
  profileProblems,
  readEntitlements,
  signingMode,
  type ProfileFacts,
} from '../scripts/release/entitlements.mjs'
import * as identity from '../scripts/release/identity.mjs'
import { parseIdentities, preferredIdentity, resolveIdentity, signingIdentity } from '../scripts/release/identity.mjs'
import { certificateHash, keyFrom, makeToken, pickCertificate, runAsc, type FetchLike } from '../scripts/release/asc.mjs'
import { grantsBrowserPasskeys, readCodeSignature, signedAsBrowser } from '../src/main/codeSignature'
import { BUNDLE_ID, DEFAULT_BUNDLE_ID as RUNTIME_DEFAULT_BUNDLE_ID } from '../src/shared/release'

// Signing (docs/release.md, "Browser passkeys and iCloud Passwords"): the app
// id, the identity, the three macOS signing modes and their entitlements, the
// provisioning profile preflight, electron-builder's assembled config, the App
// Store Connect helper against a fake API, the private release.env, and the
// app reading its own signature. Every team, name and hash here is made up.

const REPO = resolve(__dirname, '..')
const TEAM = 'ABCDE12345'
const OLD = '0123456789ABCDEF0123456789ABCDEF01234567'
const CURRENT = 'FEDCBA9876543210FEDCBA9876543210FEDCBA98'
const DEV = '00112233445566778899AABBCCDDEEFF00112233'
const NAME = 'Developer ID Application: Example Developer (ABCDE12345)'
const FIND_IDENTITY = `  1) ${OLD} "${NAME}"
  2) ${DEV} "Apple Development: Example Developer (FGHIJ67890)"
  3) ${CURRENT} "${NAME}"
     3 valid identities found`
const IDENTITIES = parseIdentities(FIND_IDENTITY)
const tmp = (): string => mkdtempSync(join(tmpdir(), 'apex-signing-'))

/** A Developer ID profile for com.sennechin.apex that grants everything the passkeys mode claims. */
const goodProfile = (over: Partial<ProfileFacts> = {}, entitlements: Record<string, unknown> = {}): ProfileFacts => ({
  name: 'Apex Developer ID',
  teamIds: [TEAM],
  entitlements: {
    'com.apple.application-identifier': `${TEAM}.com.sennechin.apex`,
    'com.apple.developer.team-identifier': TEAM,
    [BROWSER_PASSKEY_ENTITLEMENT]: true,
    'keychain-access-groups': [`${TEAM}.*`],
    ...entitlements,
  },
  expires: '2031-01-01T00:00:00Z',
  platforms: ['OSX'],
  allDevices: true,
  devices: false,
  ...over,
})

describe('the app id', () => {
  it('is the branding\'s (com.sennechin.apex when official) unless APEX_BUNDLE_ID says otherwise, everywhere', () => {
    const official = { APEX_OFFICIAL_BRANDING: '1' }
    expect(DEFAULT_BUNDLE_ID).toBe('com.sennechin.apex')
    expect(RUNTIME_DEFAULT_BUNDLE_ID).toBe(loadBranding().bundleId)
    expect(BUNDLE_ID).toBe(RUNTIME_DEFAULT_BUNDLE_ID) // no __APEX_BUNDLE_ID__ under vitest
    expect(bundleIdFrom(official)).toBe('com.sennechin.apex')
    expect(bundleIdFrom({ APEX_BUNDLE_ID: ' com.example.apex ' })).toBe('com.example.apex')
    expect(() => bundleIdFrom({ APEX_BUNDLE_ID: 'com.example.*' })).toThrow(/not a bundle id/)
    expect(releaseSettings({ APEX_BUNDLE_ID: 'com.example.apex' }, 'darwin').bundleId).toBe('com.example.apex')
    expect(viteDefines(releaseSettings(official, 'darwin')).__APEX_BUNDLE_ID__).toBe('"com.sennechin.apex"')
    expect(baseConfig().appId).toBe('com.sennechin.apex')
  })

  it('has no default team: APEX_TEAM_ID or nothing, checked when set', () => {
    expect(Object.keys(bundle)).not.toContain('DEFAULT_TEAM_ID')
    expect(teamIdFrom({})).toBeNull()
    expect(teamIdFrom({ APEX_TEAM_ID: ' ' })).toBeNull()
    expect(teamIdFrom({ APEX_TEAM_ID: ` ${TEAM} ` })).toBe(TEAM)
    expect(() => teamIdFrom({ APEX_TEAM_ID: 'short' })).toThrow(/Team ID/)
    expect(requireTeamId({ APEX_TEAM_ID: TEAM }, 'This')).toBe(TEAM)
    expect(() => requireTeamId({}, 'The thing')).toThrow(/^The thing needs your Apple Team ID: set APEX_TEAM_ID/)
  })

  it('names the native helpers under it', () => {
    for (const helper of ['speech', 'calendar', 'translate']) {
      const plist = join(REPO, 'native', helper, 'Info.plist')
      expect(readFileSync(plist, 'utf8')).toContain(`<string>com.sennechin.apex.${helper}</string>`)
      expect(helperInfoPlist(plist, tmp(), helper, { APEX_OFFICIAL_BRANDING: '1' })).toBe(plist)
      const copy = helperInfoPlist(plist, tmp(), helper, { APEX_OFFICIAL_BRANDING: '1', APEX_BUNDLE_ID: 'com.example.apex' })
      expect(readFileSync(copy, 'utf8')).toContain(`<string>com.example.apex.${helper}</string>`)
    }
    expect(() => withBundleIdentifier('<plist/>', 'x.y')).toThrow(/CFBundleIdentifier/)
  })
})

describe('the signing identity', () => {
  it('resolves an ambiguous name to the preferred certificate, and lists the hashes without one', () => {
    expect(IDENTITIES.map((i) => i.hash)).toEqual([OLD, DEV, CURRENT])
    expect(resolveIdentity('Example Developer (ABCDE12345)', IDENTITIES, { preferred: CURRENT }).hash).toBe(CURRENT)
    expect(resolveIdentity(NAME, IDENTITIES, { preferred: CURRENT.toLowerCase() }).hash).toBe(CURRENT)
    expect(() => resolveIdentity(NAME, IDENTITIES)).toThrow(`"${NAME}" is ambiguous: 2 identities carry it (${OLD}, ${CURRENT}). Set APEX_SIGN_IDENTITY`)
    expect(() => resolveIdentity(NAME, IDENTITIES, { preferred: 'F'.repeat(40) })).toThrow(/ambiguous.*APEX_SIGN_IDENTITY/)
    // A name only one identity carries needs no preference.
    expect(resolveIdentity(NAME, IDENTITIES.filter((i) => i.hash !== OLD)).hash).toBe(CURRENT)
  })

  it('takes a hash as given, when the keychain has it', () => {
    expect(resolveIdentity(OLD.toLowerCase(), IDENTITIES).hash).toBe(OLD)
    expect(() => resolveIdentity('A'.repeat(40), IDENTITIES)).toThrow(/isn't in the keychain/)
    expect(() => resolveIdentity(DEV, IDENTITIES)).toThrow(/not a Developer ID Application/)
    expect(() => resolveIdentity('Nobody (ZZZZZZZZZZ)', IDENTITIES)).toThrow(/no "Developer ID Application: Nobody/)
  })

  it('has no preferred certificate of its own: only APEX_SIGN_IDENTITY, when it is a hash', () => {
    expect(Object.keys(identity)).not.toContain('DEFAULT_SIGN_IDENTITY')
    expect(preferredIdentity({})).toBe('')
    expect(preferredIdentity({ APEX_SIGN_IDENTITY: ` ${CURRENT.toLowerCase()} ` })).toBe(CURRENT)
    expect(preferredIdentity({ APEX_SIGN_IDENTITY: NAME })).toBe('')
    expect(preferredIdentity({ CSC_NAME: CURRENT })).toBe('')
  })

  it('reads APEX_SIGN_IDENTITY, then CSC_NAME, and nothing when neither is set', () => {
    expect(signingIdentity({}, { identities: IDENTITIES })).toBeNull()
    expect(signingIdentity({ APEX_SIGN_IDENTITY: CURRENT }, { identities: IDENTITIES })).toBe(CURRENT)
    expect(signingIdentity({ APEX_SIGN_IDENTITY: CURRENT, CSC_NAME: NAME }, { identities: IDENTITIES })).toBe(CURRENT)
    expect(signingIdentity({ APEX_SIGN_IDENTITY: OLD, CSC_NAME: NAME }, { identities: IDENTITIES })).toBe(OLD)
    expect(() => signingIdentity({ CSC_NAME: 'Example Developer (ABCDE12345)' }, { identities: IDENTITIES })).toThrow(/ambiguous/)
    expect(() => signingIdentity({ APEX_SIGN_IDENTITY: NAME }, { identities: IDENTITIES })).toThrow(/ambiguous/)
    expect(signingIdentity({ CSC_NAME: NAME }, { identities: IDENTITIES, preferred: CURRENT })).toBe(CURRENT)
  })
})

describe('signing modes', () => {
  const ID = { APEX_SIGN_IDENTITY: CURRENT }
  it('picks unsigned by default, Developer ID with an identity, and passkeys with a profile', () => {
    expect(signingMode({})).toBe('unsigned')
    expect(signingMode(ID)).toBe('developer-id')
    expect(signingMode({ CSC_LINK: 'x' })).toBe('developer-id')
    expect(signingMode({ ...ID, APEX_PROVISIONING_PROFILE: '/p.provisionprofile' })).toBe('developer-id-passkeys')
    expect(() => signingMode({ APEX_PROVISIONING_PROFILE: '/p.provisionprofile' })).toThrow(/no Developer ID identity/)
  })

  it('notarizes with an API key, an Apple ID or a notarytool keychain profile', () => {
    expect(signingPlan({ ...ID }, 'darwin')).toEqual({ platform: 'darwin', identity: 'name', notarize: null })
    expect(signingPlan({ ...ID, APPLE_KEYCHAIN_PROFILE: 'example-notary' }, 'darwin').notarize).toBe('keychain-profile')
    expect(signingPlan({ APPLE_KEYCHAIN_PROFILE: 'example-notary' }, 'darwin').notarize).toBeNull()
  })

  it('keeps restricted keys out of the committed entitlements', () => {
    for (const file of ['build/entitlements.mac.plist', 'build/entitlements.mac.inherit.plist']) {
      const keys = Object.keys(readEntitlements(readFileSync(join(REPO, file), 'utf8')))
      expect(keys).toContain('com.apple.security.cs.allow-jit')
      expect(keys.filter(isRestricted)).toEqual([])
    }
    expect(isRestricted(BROWSER_PASSKEY_ENTITLEMENT)).toBe(true)
    expect(isRestricted('keychain-access-groups')).toBe(true)
    expect(isRestricted('com.apple.security.device.camera')).toBe(false)
  })

  it('adds the browser passkey keys only in the passkeys mode', () => {
    const base = { 'com.apple.security.cs.allow-jit': true }
    const opts = { base, teamId: TEAM, bundleId: 'com.sennechin.apex' }
    expect(entitlementsFor('unsigned', opts)).toEqual(base)
    expect(entitlementsFor('developer-id', opts)).toEqual(base)
    expect(entitlementsFor('developer-id-passkeys', opts)).toEqual({
      ...base,
      [BROWSER_PASSKEY_ENTITLEMENT]: true,
      'com.apple.application-identifier': `${TEAM}.com.sennechin.apex`,
      'com.apple.developer.team-identifier': TEAM,
      'keychain-access-groups': [`${TEAM}.com.sennechin.apex.webauthn`],
    })
    expect(entitlementsFor('developer-id-passkeys', { ...opts, keychainGroup: false })).not.toHaveProperty('keychain-access-groups')
    expect(() => entitlementsFor('unsigned', { ...opts, base: { [BROWSER_PASSKEY_ENTITLEMENT]: true } })).toThrow(/Restricted entitlements need a provisioning profile/)
    const xml = entitlementsXml(entitlementsFor('developer-id-passkeys', opts), 'a comment -- with dashes')
    expect(readEntitlements(xml)).toEqual(entitlementsFor('developer-id-passkeys', opts))
  })
})

describe('the provisioning profile preflight', () => {
  const opts = { teamId: TEAM, bundleId: 'com.sennechin.apex', now: new Date('2026-10-31T00:00:00Z') }
  it('passes a Developer ID profile that grants the entitlement, the team and the bundle id', () => {
    expect(profileProblems(goodProfile(), opts)).toEqual([])
    expect(profileAllowsKeychainGroup(goodProfile(), `${TEAM}.com.sennechin.apex.webauthn`)).toBe(true)
    expect(profileAllowsKeychainGroup(goodProfile({}, { 'keychain-access-groups': undefined }), `${TEAM}.com.sennechin.apex.webauthn`)).toBe(false)
  })

  it('names each thing a profile is missing', () => {
    const one = (facts: ProfileFacts): string => profileProblems(facts, opts).join('\n')
    expect(one(goodProfile({}, { [BROWSER_PASSKEY_ENTITLEMENT]: undefined }))).toMatch(/doesn't grant com\.apple\.developer\.web-browser\.public-key-credential/)
    expect(one(goodProfile({ teamIds: ['ZZZZZ99999'] }, { 'com.apple.developer.team-identifier': 'ZZZZZ99999' }))).toMatch(/belongs to team ZZZZZ99999, not ABCDE12345/)
    expect(one(goodProfile({}, { 'com.apple.application-identifier': `${TEAM}.com.apex.browser` }))).toMatch(/is for "ABCDE12345\.com\.apex\.browser", not ABCDE12345\.com\.sennechin\.apex/)
    expect(one(goodProfile({}, { 'com.apple.application-identifier': `${TEAM}.*` }))).toMatch(/wildcard profile/)
    expect(one(goodProfile({ expires: '2025-01-01T00:00:00Z' }))).toMatch(/expired on 2025-01-01/)
    expect(one(goodProfile({ allDevices: false, devices: true }))).toMatch(/development profile/)
    expect(one(goodProfile({ platforms: ['iOS'] }))).toMatch(/not a macOS profile/)
  })

  it.runIf(process.platform === 'darwin')('decodes a profile’s fields with plutil, data and dates included', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Name</key><string>Apex Developer ID</string>
<key>DeveloperCertificates</key><array><data>AAEC</data></array>
<key>Entitlements</key><dict><key>com.apple.application-identifier</key><string>${TEAM}.com.sennechin.apex</string><key>com.apple.developer.team-identifier</key><string>${TEAM}</string><key>${BROWSER_PASSKEY_ENTITLEMENT}</key><true/><key>keychain-access-groups</key><array><string>${TEAM}.*</string></array></dict>
<key>ExpirationDate</key><date>2031-01-01T00:00:00Z</date>
<key>Platform</key><array><string>OSX</string></array>
<key>ProvisionsAllDevices</key><true/>
<key>TeamIdentifier</key><array><string>${TEAM}</string></array>
</dict></plist>`
    const file = join(tmp(), 'fake.provisionprofile')
    writeFileSync(file, 'cms')
    const run = ((cmd: string, args: string[], options: object) => (cmd === 'security' ? xml : execFileSync(cmd, args, options))) as typeof execFileSync
    const facts = decodeProfile(file, run)
    expect(facts).toMatchObject({ name: 'Apex Developer ID', teamIds: [TEAM], platforms: ['OSX'], allDevices: true, devices: false })
    expect(facts.expires).toMatch(/^2031-01-01/)
    expect(profileProblems(facts, opts)).toEqual([])
    expect(() => decodeProfile(join(tmp(), 'missing.provisionprofile'))).toThrow(/doesn't exist/)
  })

  it('stops the build with every problem listed', () => {
    const decode = (): ProfileFacts => goodProfile({ teamIds: [] }, { [BROWSER_PASSKEY_ENTITLEMENT]: false })
    expect(() => preflightProfile('/x.provisionprofile', { ...opts, decode })).toThrow(/can't sign Apex with browser passkeys:\n {2}- .*team[\s\S]*- .*doesn't grant/)
  })
})

describe('electron-builder’s assembled config', () => {
  const logger = new DebugLogger(false)
  const ID = { APEX_SIGN_IDENTITY: CURRENT }
  const PASSKEYS = { ...ID, APEX_TEAM_ID: TEAM }
  // Without the private internal/ folder's resources, so these checks see electron-builder.yml as it is.
  const build = (env: Record<string, string>, extra: { decode?: () => ProfileFacts; out?: string; log?: (m: string) => void } = {}): Record<string, any> =>
    builderConfig({ APEX_INTERNAL: '0', APEX_OFFICIAL_BRANDING: '1', ...env }, { platform: 'darwin', identities: IDENTITIES, out: extra.out ?? join(tmp(), 'ents.plist'), ...(extra.decode ? { decode: extra.decode } : {}), ...(extra.log ? { log: extra.log } : {}) })

  it('builds unsigned by default: no identity, no notarization, no restricted keys', async () => {
    const config = build({})
    expect(config.appId).toBe('com.sennechin.apex')
    expect(config.mac.identity).toBeNull()
    expect(config.mac.notarize).toBe(false)
    expect(config.mac.entitlements).toBe('build/entitlements.mac.plist')
    expect(config.mac).not.toHaveProperty('provisioningProfile')
    expect(config.dmg.sign).toBeUndefined()
    // Arrays stay as the yml has them (electron-builder would concatenate them in a merge).
    expect(config.mac.extraResources).toEqual(baseConfig().mac.extraResources)
    await validateConfiguration(config as Configuration, logger)
  })

  it('signs Developer ID with the resolved hash, the hardened runtime and a signed dmg, with no team needed', async () => {
    const notes: string[] = []
    const config = build({ ...ID }, { log: (m) => notes.push(m) })
    expect(notes).toEqual([`developer-id for com.sennechin.apex, identity ${CURRENT}, notarization off`])
    expect(config.mac.identity).toBe(CURRENT)
    expect(config.mac.hardenedRuntime).toBe(true)
    expect(config.mac.notarize).toBe(false)
    expect(config.dmg.sign).toBe(true)
    expect(config.mac.sign).toBe(join(REPO, 'scripts', 'release', 'sign.mjs'))
    expect(build({}).mac.sign).toBeUndefined()
    expect(build({ ...ID, APPLE_KEYCHAIN_PROFILE: 'example-notary' }).mac.notarize).toBe(true)
    // A name two keychain identities carry, with no SHA-1 to prefer, stops the build.
    expect(() => build({ APEX_SIGN_IDENTITY: 'Example Developer (ABCDE12345)' })).toThrow(/ambiguous: 2 identities carry it/)
    // CSC_LINK's own certificate is found by electron-builder in its temporary keychain.
    expect(build({ CSC_LINK: 'base64', CSC_KEY_PASSWORD: 'p' }).mac.identity).toBe('')
    expect(build({ ...ID, APEX_BUNDLE_ID: 'com.example.apex' }).appId).toBe('com.example.apex')
    await validateConfiguration(config as Configuration, logger)
  })

  it('embeds the profile and signs with the generated passkeys entitlements', async () => {
    const out = join(tmp(), 'generated', 'ents.plist')
    const config = build({ ...PASSKEYS, APEX_PROVISIONING_PROFILE: '/profiles/apex.provisionprofile' }, { decode: () => goodProfile(), out })
    expect(config.mac.provisioningProfile).toBe('/profiles/apex.provisionprofile')
    expect(config.mac.entitlements).toBe(out)
    expect(config.mac.entitlementsInherit).toBe('build/entitlements.mac.inherit.plist')
    const ents = readEntitlements(readFileSync(out, 'utf8'))
    expect(ents[BROWSER_PASSKEY_ENTITLEMENT]).toBe(true)
    expect(ents['com.apple.application-identifier']).toBe(`${TEAM}.com.sennechin.apex`)
    expect(ents['keychain-access-groups']).toEqual([`${TEAM}.com.sennechin.apex.webauthn`])
    expect(ents['com.apple.security.cs.allow-jit']).toBe(true)
    await validateConfiguration(config as Configuration, logger)
  })

  it('refuses the passkeys mode without APEX_TEAM_ID, before anything is written', () => {
    const out = join(tmp(), 'never.plist')
    expect(() => build({ ...ID, APEX_PROVISIONING_PROFILE: '/p' }, { decode: () => goodProfile(), out })).toThrow(/passkeys signing mode .* needs your Apple Team ID: set APEX_TEAM_ID/)
    expect(existsSync(out)).toBe(false)
  })

  it('drops only the Touch ID keychain group when the profile doesn’t allow it, and refuses a bad profile', () => {
    const out = join(tmp(), 'ents.plist')
    const notes: string[] = []
    macSigningConfig({ ...PASSKEYS, APEX_PROVISIONING_PROFILE: '/p' }, { out, decode: () => goodProfile({}, { 'keychain-access-groups': undefined }), log: (m) => notes.push(m) })
    expect(readEntitlements(readFileSync(out, 'utf8'))).not.toHaveProperty('keychain-access-groups')
    expect(notes.join()).toMatch(/Touch ID passkeys stay off/)
    const bad = join(tmp(), 'never.plist')
    expect(() => build({ ...PASSKEYS, APEX_PROVISIONING_PROFILE: '/p' }, { decode: () => goodProfile({}, { [BROWSER_PASSKEY_ENTITLEMENT]: undefined }), out: bad })).toThrow(/doesn't grant/)
    expect(existsSync(bad)).toBe(false)
  })

  it('leaves other platforms’ configs without mac signing changes', () => {
    const config = builderConfig({ ...ID, APEX_PROVISIONING_PROFILE: '/p' }, { platform: 'linux' })
    expect(config.appId).toBe('com.sennechin.apex')
    expect(config.mac.identity).toBeNull()
    expect(mergeConfig({ a: [1], b: { c: 1 } }, { a: [2], b: { d: 2 } })).toEqual({ a: [2], b: { c: 1, d: 2 } })
  })
})

// ---------------------------------------------------------------------------
// The App Store Connect helper, against a fake API.

function fakeAsc(seed: { bundleIds?: any[]; capabilities?: string[]; certificates?: any[]; profiles?: any[] } = {}) {
  const state = { bundleIds: [...(seed.bundleIds ?? [])], capabilities: [...(seed.capabilities ?? [])], certificates: seed.certificates ?? [], profiles: [...(seed.profiles ?? [])] }
  const calls: Array<{ method: string; path: string; body?: any; auth?: string }> = []
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, text: async () => (body === null ? '' : JSON.stringify(body)) })
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, path: u.pathname, body, auth: init.headers.Authorization })
    const p = u.pathname
    if (init.method === 'GET' && p === '/v1/bundleIds') return json(200, { data: state.bundleIds.filter((b) => b.attributes.identifier.includes(u.searchParams.get('filter[identifier]') ?? '')) })
    if (init.method === 'POST' && p === '/v1/bundleIds') {
      const made = { id: 'B1', type: 'bundleIds', attributes: body.data.attributes }
      state.bundleIds.push(made)
      return json(201, { data: made })
    }
    if (init.method === 'GET' && /^\/v1\/bundleIds\/[^/]+\/bundleIdCapabilities$/.test(p)) return json(200, { data: state.capabilities.map((c) => ({ attributes: { capabilityType: c } })) })
    if (init.method === 'POST' && p === '/v1/bundleIdCapabilities') {
      state.capabilities.push(body.data.attributes.capabilityType)
      return json(201, { data: { id: 'C1' } })
    }
    if (init.method === 'GET' && p === '/v1/certificates') return json(200, { data: state.certificates })
    if (init.method === 'GET' && p === '/v1/profiles') return json(200, { data: state.profiles.filter((x) => x.attributes.name === u.searchParams.get('filter[name]')) })
    if (init.method === 'POST' && p === '/v1/profiles') {
      const made = { id: 'P2', attributes: { name: body.data.attributes.name, profileContent: Buffer.from('fresh profile').toString('base64') } }
      state.profiles.push(made)
      return json(201, { data: made })
    }
    if (init.method === 'DELETE' && p.startsWith('/v1/profiles/')) {
      state.profiles = state.profiles.filter((x) => x.id !== p.split('/').pop())
      return json(204, null)
    }
    return json(404, { errors: [{ detail: `no route ${init.method} ${p}` }] })
  }
  return { state, calls, fetch }
}

describe('scripts/release/asc.mjs', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const KEY = { APPLE_API_KEY: '/keys/AuthKey_TEST.p8', APPLE_API_KEY_ID: 'TESTKEY123', APPLE_API_ISSUER: '00000000-1111-2222-3333-444444444444' }
  const der = (s: string): string => Buffer.from(s).toString('base64')
  const CERTS = [
    { id: 'old', attributes: { certificateContent: der('old cert'), expirationDate: '2030-01-01' } },
    { id: 'new', attributes: { certificateContent: der('new cert'), expirationDate: '2031-06-01' } },
  ]
  const base = (fetch: FetchLike, argv: string[] = [], written: Array<[string, Buffer]> = []) => ({
    argv,
    // The official app id and name, whichever branding this run has.
    env: { ...KEY, APEX_TEAM_ID: TEAM, APEX_OFFICIAL_BRANDING: '1' } as Record<string, string>,
    fetch,
    readFile: () => pem,
    exists: () => true,
    write: (path: string, data: Buffer) => void written.push([path, data]),
    log: () => {},
    decode: null,
    repo: tmp(),
  })

  it('never runs without the person’s key, and sends nothing then', async () => {
    const api = fakeAsc()
    await expect(runAsc({ ...base(api.fetch), env: {} })).rejects.toThrow(/runs only with your App Store Connect API key: set APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER/)
    await expect(runAsc({ ...base(api.fetch), exists: () => false })).rejects.toThrow(/doesn't exist/)
    expect(api.calls).toEqual([])
    expect(() => keyFrom({ ...KEY, APPLE_API_ISSUER: ' ' }, () => true)).toThrow(/APPLE_API_ISSUER/)
  })

  it('needs APEX_TEAM_ID, and sends nothing without it', async () => {
    const api = fakeAsc({ certificates: CERTS })
    await expect(runAsc({ ...base(api.fetch), env: { ...KEY } })).rejects.toThrow(/asc\.mjs .*needs your Apple Team ID: set APEX_TEAM_ID/)
    expect(api.calls).toEqual([])
  })

  it('signs a short-lived ES256 token Apple accepts the shape of', () => {
    const token = makeToken({ privateKey, keyId: KEY.APPLE_API_KEY_ID, issuer: KEY.APPLE_API_ISSUER, now: 1_700_000_000_000 })
    const [h, p, s] = token.split('.') as [string, string, string]
    const decode = (part: string): any => JSON.parse(Buffer.from(part, 'base64url').toString())
    expect(decode(h)).toEqual({ alg: 'ES256', kid: 'TESTKEY123', typ: 'JWT' })
    expect(decode(p)).toEqual({ iss: KEY.APPLE_API_ISSUER, iat: 1_700_000_000, exp: 1_700_000_000 + 19 * 60, aud: 'appstoreconnect-v1' })
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true)
  })

  it('only reads in a dry run (the default), and says what --apply would do', async () => {
    const api = fakeAsc({ certificates: CERTS })
    const result = await runAsc({ ...base(api.fetch, ['--certificate', 'new', '--capability', 'ASSOCIATED_DOMAINS']) })
    expect(result.applied).toBe(false)
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(api.calls[0]?.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    expect(result.plan).toEqual([
      'register the App ID com.sennechin.apex ("Apex", macOS)',
      'enable ASSOCIATED_DOMAINS on com.sennechin.apex',
      'create the Developer ID profile "Apex Developer ID com.sennechin.apex" for com.sennechin.apex',
      expect.stringMatching(/^write the profile to .*com\.sennechin\.apex\.provisionprofile$/),
    ])
    expect(api.state.bundleIds).toEqual([])
  })

  it('with --apply registers the App ID, enables capabilities, makes the profile and writes it', async () => {
    const api = fakeAsc({ certificates: CERTS })
    const written: Array<[string, Buffer]> = []
    const result = await runAsc({ ...base(api.fetch, ['--apply', '--certificate', 'new', '--capability', 'ASSOCIATED_DOMAINS'], written) })
    expect(result.applied).toBe(true)
    expect(api.state.bundleIds[0]?.attributes).toEqual({ identifier: 'com.sennechin.apex', name: 'Apex', platform: 'MAC_OS' })
    expect(api.state.capabilities).toEqual(['ASSOCIATED_DOMAINS'])
    const made = api.calls.find((c) => c.method === 'POST' && c.path === '/v1/profiles')!.body.data
    expect(made.attributes).toEqual({ name: 'Apex Developer ID com.sennechin.apex', profileType: 'MAC_APP_DIRECT' })
    expect(made.relationships).toEqual({ bundleId: { data: { type: 'bundleIds', id: 'B1' } }, certificates: { data: [{ type: 'certificates', id: 'new' }] } })
    expect(written.map(([, d]) => d.toString())).toEqual(['fresh profile'])
  })

  it('reuses what exists, and remakes the profile only with --recreate', async () => {
    const seed = { bundleIds: [{ id: 'B0', attributes: { identifier: 'com.sennechin.apex', platform: 'MAC_OS' } }], certificates: [CERTS[1]!], profiles: [{ id: 'P1', attributes: { name: 'Apex Developer ID com.sennechin.apex', profileContent: der('old profile') } }] }
    const keep = fakeAsc(seed)
    const written: Array<[string, Buffer]> = []
    await runAsc({ ...base(keep.fetch, ['--apply'], written) })
    expect(keep.calls.filter((c) => c.method !== 'GET')).toEqual([])
    expect(written[0]?.[1].toString()).toBe('old profile')
    const remake = fakeAsc(seed)
    await runAsc({ ...base(remake.fetch, ['--apply', '--recreate']) })
    expect(remake.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE /v1/profiles/P1', 'POST /v1/profiles'])
  })

  it('picks the certificate whose SHA-1 is the signing identity', async () => {
    const hash = certificateHash(der('new cert'))
    expect(pickCertificate(CERTS, { id: null, hash }).id).toBe('new')
    expect(() => pickCertificate(CERTS, { id: null, hash: 'F'.repeat(40) })).toThrow(/pass --certificate/)
    expect(() => pickCertificate(CERTS, { id: null, hash: '' })).toThrow(/APEX_SIGN_IDENTITY names no SHA-1 to pick one: pass --certificate/)
    // APEX_SIGN_IDENTITY, as a hash, picks it without --certificate.
    const api = fakeAsc({ certificates: CERTS })
    await runAsc({ ...base(api.fetch, ['--apply']), env: { ...KEY, APEX_TEAM_ID: TEAM, APEX_SIGN_IDENTITY: hash.toLowerCase() } })
    expect(api.calls.find((c) => c.method === 'POST' && c.path === '/v1/profiles')!.body.data.relationships.certificates).toEqual({ data: [{ type: 'certificates', id: 'new' }] })
    expect(pickCertificate([CERTS[0]!], { id: null, hash: 'F'.repeat(40) }).id).toBe('old')
    expect(() => pickCertificate([], { id: null, hash })).toThrow(/no Developer ID Application certificate/)
  })
})

// ---------------------------------------------------------------------------
// The app's own signature (src/main/codeSignature.ts), from a built Mach-O.

/** A thin arm64 Mach-O whose only load command is LC_CODE_SIGNATURE. */
function machO({ team, identifier, entitlements }: { team?: string; identifier: string; entitlements?: string }): Buffer {
  const be = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  const ident = Buffer.from(`${identifier}\0`)
  const teamBuf = team ? Buffer.from(`${team}\0`) : Buffer.alloc(0)
  const cdHeader = 52
  const cd = Buffer.concat([
    be(0xfade0c02), be(cdHeader + ident.length + teamBuf.length), be(0x20400), be(0), be(0), be(cdHeader), be(0), be(0), be(0),
    Buffer.from([32, 2, 0, 12]), be(0), be(0), be(team ? cdHeader + ident.length : 0),
    ident, teamBuf,
  ])
  const ents = entitlements ? Buffer.concat([be(0xfade7171), be(8 + Buffer.byteLength(entitlements)), Buffer.from(entitlements)]) : null
  const blobs = ents ? [[0, cd], [5, ents]] as const : [[0, cd]] as const
  const head = 12 + blobs.length * 8
  let offset = head
  const index = blobs.map(([type, blob]) => {
    const entry = Buffer.concat([be(type), be(offset)])
    offset += blob.length
    return entry
  })
  const superBlob = Buffer.concat([be(0xfade0cc0), be(offset), be(blobs.length), ...index, ...blobs.map(([, b]) => b)])
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(0x0100000c, 4)
  header.writeUInt32LE(1, 16)
  header.writeUInt32LE(16, 20)
  const lc = Buffer.alloc(16)
  lc.writeUInt32LE(0x1d, 0)
  lc.writeUInt32LE(16, 4)
  lc.writeUInt32LE(48, 8)
  lc.writeUInt32LE(superBlob.length, 12)
  return Buffer.concat([header, lc, superBlob])
}

/** Wraps thin slices in a universal (fat) binary. */
function fat(slices: Array<[number, Buffer]>): Buffer {
  const head = Buffer.alloc(8 + slices.length * 20)
  head.writeUInt32BE(0xcafebabe, 0)
  head.writeUInt32BE(slices.length, 4)
  let offset = head.length
  slices.forEach(([cpu, slice], i) => {
    head.writeUInt32BE(cpu, 8 + i * 20)
    head.writeUInt32BE(offset, 16 + i * 20)
    head.writeUInt32BE(slice.length, 20 + i * 20)
    offset += slice.length
  })
  return Buffer.concat([head, ...slices.map(([, s]) => s)])
}

describe('the app reads its own signature', () => {
  const ENTS = `<?xml version="1.0"?><plist version="1.0"><dict><key>${BROWSER_PASSKEY_ENTITLEMENT}</key><true/></dict></plist>`

  it('finds the team, identifier and entitlements in the embedded signature', () => {
    const sig = readCodeSignature(machO({ team: TEAM, identifier: 'com.sennechin.apex', entitlements: ENTS }), 'arm64')
    expect(sig).toEqual({ identifier: 'com.sennechin.apex', teamId: TEAM, entitlements: ENTS })
    expect(signedAsBrowser(sig)).toBe(true)
  })

  it('treats ad hoc signatures and missing entitlements as not entitled', () => {
    const adhoc = readCodeSignature(machO({ identifier: 'Electron', entitlements: ENTS }), 'arm64')
    expect(adhoc).toEqual({ identifier: 'Electron', teamId: null, entitlements: ENTS })
    expect(signedAsBrowser(adhoc)).toBe(false)
    expect(signedAsBrowser(readCodeSignature(machO({ team: TEAM, identifier: 'com.sennechin.apex' }), 'arm64'))).toBe(false)
    expect(grantsBrowserPasskeys(ENTS.replace('<true/>', '<false/>'))).toBe(false)
    expect(readCodeSignature(Buffer.from('not a binary'), 'arm64')).toBeNull()
    expect(signedAsBrowser(null)).toBe(false)
  })

  it('reads the slice for this arch in a universal binary', () => {
    const arm = machO({ team: TEAM, identifier: 'arm', entitlements: ENTS })
    const intel = machO({ identifier: 'intel' })
    const both = fat([[0x01000007, intel], [0x0100000c, arm]])
    expect(readCodeSignature(both, 'arm64')?.identifier).toBe('arm')
    expect(readCodeSignature(both, 'x64')?.identifier).toBe('intel')
  })

  it.runIf(process.platform === 'darwin')('agrees with codesign on a real binary', () => {
    expect(readCodeSignature(readFileSync('/bin/ls'))).toMatchObject({ identifier: 'com.apple.ls', teamId: null })
  })
})

describe('the release scripts write nothing secret or personal', () => {
  it('commits no Team ID, certificate hash, key, password or profile', () => {
    const files = ['bundle', 'identity', 'entitlements', 'asc', 'config', 'builderConfig', 'verify', 'preflight', 'release'].map((f) => `scripts/release/${f}.mjs`)
    for (const f of [...files, 'electron-builder.config.mjs']) {
      const text = readFileSync(join(REPO, f), 'utf8')
      expect(text, f).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|APPLE_APP_SPECIFIC_PASSWORD\s*=\s*\S|[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}/)
      // No string literal that is a SHA-1 or a 10-character Apple Team ID.
      expect(text, f).not.toMatch(/['"`][0-9A-Fa-f]{40}['"`]|['"`][A-Z0-9]{10}['"`]/)
    }
  })
})

// ---------------------------------------------------------------------------
// The private values file (internal/release.env, scripts/release/config.mjs).

describe('internal/release.env', () => {
  const FILE = `# The maintainer's signing identity. Never committed.
APEX_TEAM_ID=${TEAM}
export APEX_SIGN_IDENTITY="${CURRENT}"

APPLE_KEYCHAIN_PROFILE=example-notary   # a notarytool profile
`
  const write = (text: string): string => {
    const dir = join(tmp(), 'internal')
    mkdirSync(dir)
    writeFileSync(join(dir, 'release.env'), text)
    return join(dir, 'release.env')
  }

  it('lives in the private internal/ folder', () => {
    expect(RELEASE_ENV).toBe(join(REPO, 'internal', 'release.env'))
  })

  it('reads KEY=VALUE lines, # comments, quotes and an optional export', () => {
    expect(parseReleaseEnv(FILE)).toEqual({ APEX_TEAM_ID: TEAM, APEX_SIGN_IDENTITY: CURRENT, APPLE_KEYCHAIN_PROFILE: 'example-notary' })
    expect(parseReleaseEnv("A='x # y'\nB=\n")).toEqual({ A: 'x # y', B: '' })
    expect(() => parseReleaseEnv('APEX_TEAM_ID\n', 'internal/release.env')).toThrow("internal/release.env:1 isn't a KEY=VALUE line")
  })

  it('goes under the environment: a variable that is set wins, even empty', () => {
    const file = write(FILE)
    const env: Record<string, string | undefined> = { APEX_TEAM_ID: 'ZZZZZ99999', APEX_SIGN_IDENTITY: '', APPLE_KEYCHAIN_PROFILE: undefined }
    expect(loadReleaseEnv(env, { file })).toEqual(['APPLE_KEYCHAIN_PROFILE'])
    expect(env).toEqual({ APEX_TEAM_ID: 'ZZZZZ99999', APEX_SIGN_IDENTITY: '', APPLE_KEYCHAIN_PROFILE: 'example-notary' })
    // Loading again changes nothing.
    expect(loadReleaseEnv(env, { file })).toEqual([])
  })

  it('changes nothing when there is no file', () => {
    const env = { APEX_CHANNEL: 'beta' }
    expect(loadReleaseEnv(env, { file: join(tmp(), 'internal', 'release.env') })).toEqual([])
    expect(env).toEqual({ APEX_CHANNEL: 'beta' })
  })

  it('gives the build its team, preferred identity and notarization', () => {
    const env: Record<string, string> = { CSC_NAME: NAME }
    expect(loadReleaseEnv(env, { file: write(FILE) })).toEqual(['APEX_TEAM_ID', 'APEX_SIGN_IDENTITY', 'APPLE_KEYCHAIN_PROFILE'])
    expect(teamIdFrom(env)).toBe(TEAM)
    expect(preferredIdentity(env)).toBe(CURRENT)
    // The ambiguous name in CSC_NAME is never the one used: the file's hash is.
    expect(signingIdentity(env, { identities: IDENTITIES })).toBe(CURRENT)
    const out = join(tmp(), 'ents.plist')
    const config = builderConfig({ ...env, APEX_PROVISIONING_PROFILE: '/p' }, { platform: 'darwin', identities: IDENTITIES, out, decode: () => goodProfile() })
    expect(config.mac).toMatchObject({ identity: CURRENT, notarize: true, entitlements: out })
    expect(readEntitlements(readFileSync(out, 'utf8'))['com.apple.application-identifier']).toBe(`${TEAM}.com.sennechin.apex`)
  })
})

describe('verify.mjs’s entitlement check', () => {
  it('fails restricted keys without their profile, and a passkeys build without the keys', async () => {
    const { entitlementProblems } = await import('../scripts/release/checks.mjs')
    const appId = `${TEAM}.com.sennechin.apex`
    const passkeys = { 'com.apple.security.cs.allow-jit': true, [BROWSER_PASSKEY_ENTITLEMENT]: true, 'com.apple.application-identifier': appId }
    expect(entitlementProblems({}, { mode: 'unsigned', embeddedProfile: false, appId })).toEqual([])
    expect(entitlementProblems({ 'com.apple.security.cs.allow-jit': true }, { mode: 'developer-id', embeddedProfile: false, appId })).toEqual([])
    expect(entitlementProblems(passkeys, { mode: 'developer-id', embeddedProfile: false, appId }).join()).toMatch(/claims com\.apple\.developer\.web-browser/)
    expect(entitlementProblems(passkeys, { mode: 'developer-id-passkeys', embeddedProfile: true, appId })).toEqual([])
    expect(entitlementProblems({}, { mode: 'developer-id-passkeys', embeddedProfile: false, appId })).toEqual([
      'Contents/embedded.provisionprofile is missing',
      `the app isn't signed with ${BROWSER_PASSKEY_ENTITLEMENT}`,
      `com.apple.application-identifier is null, not ${appId}`,
    ])
    // Without APEX_TEAM_ID the app id can't be known: verify.mjs says so instead of guessing a team.
    expect(entitlementProblems(passkeys, { mode: 'developer-id-passkeys', embeddedProfile: true, appId: null })).toEqual([
      "com.apple.application-identifier can't be checked without your Apple Team ID: set APEX_TEAM_ID",
    ])
    expect(entitlementProblems({}, { mode: 'developer-id', embeddedProfile: false, appId: null })).toEqual([])
  })
})
