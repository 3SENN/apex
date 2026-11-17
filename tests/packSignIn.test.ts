/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  session: { fromPartition: () => ({}) },
}))

import { NO_PACK_PERMISSIONS, PACK_MANIFEST_FILE, describePackPermissions, permissionDiff, type PackApp, type PackAuth, type PackManifest } from '@shared/packs'
import { OAuthError, type FetchFn } from '../src/main/connectors/oauth'
import { issuerAllowed, validatePack, type PackFiles } from '../src/main/packs/manifest'
import { parsePolicy } from '../src/main/packs/policy'
import { PackSecrets, type SecretCipher } from '../src/main/packs/secrets'
import { PackSignIns, effectiveAuth, userOf } from '../src/main/packs/signIns'

// Sign-ins for apps (docs/apps.md › Apps for organisations): what a manifest
// may declare, what an organisation can set, and the sign-in itself against a
// stand-in identity provider (PKCE, the loopback redirect, the ID token's
// name, refresh, and signing out), with the tokens never stored in clear.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'atelier-pack-signin-test-'))
  dirs.push(d)
  return d
}

const app = (over: Partial<PackApp> = {}): PackApp => ({ id: 'main', name: 'Dashboard', root: 'app', entry: 'index.html', build: 'kit', kind: 'tool', ...over })
const CORP: PackAuth = { id: 'corp', name: 'Contoso account', issuer: 'https://login.contoso.example', clientId: 'dashboard', scopes: ['openid', 'email', 'api.read'], hosts: ['api.contoso.example'] }
const manifest = (over: Partial<PackManifest> = {}): PackManifest => ({
  format: 'atelier-pack',
  manifestVersion: 2,
  id: 'dashboard',
  name: 'Dashboard',
  version: '1.0.0',
  description: 'The team’s numbers.',
  contributes: { apps: [app()] },
  permissions: { ...NO_PACK_PERMISSIONS, network: ['api.contoso.example', 'cdn.contoso.example'] },
  auth: [CORP],
  ...over,
})
const pack = (m: PackManifest): PackFiles =>
  new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(m))],
    ['app/index.html', Buffer.from('<!doctype html><script type="module" src="./main.js"></script>')],
    ['app/main.js', Buffer.from('export {}\n')],
  ])
const problems = (m: PackManifest): string => {
  const check = validatePack(pack(m))
  return check.ok ? '' : check.problems.join('\n')
}

describe('the manifest: auth', () => {
  it('takes a sign-in whose token goes to hosts the pack may reach', () => {
    expect(problems(manifest())).toBe('')
  })

  it('refuses a sign-in that would send its token anywhere else, or from an insecure provider', () => {
    expect(problems(manifest({ auth: [{ ...CORP, hosts: ['evil.example'] }] }))).toMatch(/evil\.example is not in permissions\.network/)
    expect(problems(manifest({ auth: [{ ...CORP, hosts: ['*'] }] }))).toMatch(/not allowed|not a host/)
    expect(problems(manifest({ auth: [{ ...CORP, issuer: 'http://login.contoso.example' }] }))).toMatch(/auth\.0\.issuer/)
    expect(problems(manifest({ auth: [{ ...CORP, issuer: 'https://login.contoso.example/?tenant=x' }] }))).toMatch(/auth\.0\.issuer/)
    expect(problems(manifest({ auth: [CORP, CORP] }))).toMatch(/used twice/)
    expect(problems(manifest({ auth: [{ ...CORP, id: 'Corp' }] }))).toMatch(/lowercase/)
    expect(problems(manifest({ auth: [{ ...CORP, scopes: ['api read'] }] }))).toMatch(/not a scope/)
    expect(problems(manifest({ manifestVersion: 1 }))).toMatch(/auth need "manifestVersion": 2/)
  })

  it('lets a developer sign in to a provider on this computer', () => {
    expect(issuerAllowed('http://127.0.0.1:8080')).toBe(true)
    expect(issuerAllowed('http://localhost:8080/realms/dev')).toBe(true)
    expect(issuerAllowed('http://10.0.0.5')).toBe(false)
  })

  it('never puts a key and a sign-in in the same Authorization header', () => {
    const key = { id: 'API_KEY', name: 'API key', hosts: ['api.contoso.example'], header: 'Authorization', prefix: 'Bearer ' }
    expect(problems(manifest({ secrets: [key] }))).toMatch(/also gets the secret API_KEY/)
    expect(problems(manifest({ secrets: [{ ...key, header: 'X-Api-Key', prefix: undefined }] }))).toBe('')
  })

  it('says on the review where the sign-in goes, and asks again when that changes', () => {
    const line = describePackPermissions(manifest()).find((l) => l.kind === 'signIn')
    expect(line?.vars).toMatchObject({ issuers: 'login.contoso.example', hosts: 'api.contoso.example', names: 'Contoso account' })
    const wider = manifest({ auth: [{ ...CORP, hosts: ['api.contoso.example', 'cdn.contoso.example'] }] })
    expect(permissionDiff(manifest(), wider).some((g) => g.kind === 'signIn')).toBe(true)
    const elsewhere = manifest({ auth: [{ ...CORP, issuer: 'https://login.other.example' }] })
    expect(permissionDiff(manifest(), elsewhere).some((g) => g.kind === 'signIn')).toBe(true)
  })
})

describe('the organisation’s AppConfig for sign-ins', () => {
  it('sets the issuer, client and scopes for its own tenant', () => {
    const { policy, problems: bad } = parsePolicy({ AppConfig: JSON.stringify({ dashboard: { auth: { corp: { issuer: 'https://login.microsoftonline.com/tenant-1/v2.0', clientId: 'contoso-dashboard' } } } }) }, 'test')
    expect(bad).toEqual([])
    const [a] = effectiveAuth([CORP], policy.appConfig.dashboard?.auth)
    expect(a).toMatchObject({ issuer: 'https://login.microsoftonline.com/tenant-1/v2.0', clientId: 'contoso-dashboard', scopes: CORP.scopes, hosts: CORP.hosts, managed: true })
    expect(effectiveAuth([CORP], undefined)[0]?.managed).toBe(false)
  })

  it('refuses an issuer that isn’t https, without voiding the rest of the policy', () => {
    const { policy, problems: bad } = parsePolicy({ PackAuditLog: 1, AppConfig: JSON.stringify({ dashboard: { auth: { corp: { issuer: 'http://login.example' } } } }) }, 'test')
    expect(bad.join()).toMatch(/AppConfig/)
    expect(policy.audit).toBe(true)
  })
})

describe('who signed in', () => {
  const jwt = (claims: object): string => ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')
  it('reads the email, username or name from the ID token', () => {
    expect(userOf(jwt({ email: 'ana@contoso.example', name: 'Ana' }))).toBe('ana@contoso.example')
    expect(userOf(jwt({ preferred_username: 'ana', name: 'Ana' }))).toBe('ana')
    expect(userOf(jwt({ name: 'Ana' }))).toBe('Ana')
    expect(userOf(jwt({ sub: '123' }))).toBeNull()
    expect(userOf('not-a-token')).toBeNull()
    expect(userOf(null)).toBeNull()
  })
})

describe('signing in', () => {
  const cipher: SecretCipher = {
    available: () => true,
    encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)),
    decrypt: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8'),
  }
  const ISSUER = 'https://login.contoso.example'
  const idToken = ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify({ email: 'ana@contoso.example' })).toString('base64url'), 'sig'].join('.')

  /** A stand-in identity provider: discovery, and a token endpoint that checks PKCE and hands out numbered tokens. */
  function provider(opts: { refuseRefresh?: boolean; down?: boolean } = {}): { fetchFn: FetchFn; tokens: () => number; challenges: string[]; bodies: URLSearchParams[] } {
    let issued = 0
    const challenges: string[] = []
    const bodies: URLSearchParams[] = []
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    const fetchFn: FetchFn = async (url, init) => {
      if (opts.down && url.endsWith('/token')) throw new Error('offline')
      if (url === `${ISSUER}/.well-known/oauth-authorization-server`) return json({}, 404)
      if (url === `${ISSUER}/.well-known/openid-configuration`) return json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token` })
      if (url === `${ISSUER}/token`) {
        const body = new URLSearchParams(String(init?.body))
        bodies.push(body)
        if (body.get('grant_type') === 'refresh_token' && opts.refuseRefresh) return json({ error: 'invalid_grant' }, 400)
        issued++
        return json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600, id_token: idToken, token_type: 'Bearer' })
      }
      return json({}, 404)
    }
    return { fetchFn, tokens: () => issued, challenges, bodies }
  }

  /** The browser: follows the authorization page straight back to Atelier's loopback redirect, as a provider that remembers you does. */
  const browser = (seen: string[]) => (url: string): (() => void) => {
    seen.push(url)
    const u = new URL(url)
    const back = new URL(u.searchParams.get('redirect_uri') as string)
    back.searchParams.set('code', 'the-code')
    back.searchParams.set('state', u.searchParams.get('state') as string)
    void fetch(back).catch(() => undefined)
    return () => undefined
  }

  it('signs in with PKCE, keeps the tokens encrypted, and sends the access token', async () => {
    const file = join(tmp(), 'pack-signins.bin')
    const idp = provider()
    const signIns = new PackSignIns(new PackSecrets(file, cipher), idp.fetchFn)
    const [auth] = effectiveAuth([{ ...CORP, issuer: ISSUER }], undefined)
    if (!auth) throw new Error('no auth')
    const opened: string[] = []
    const state = await signIns.signIn('dashboard', auth, browser(opened))
    expect(state).toEqual({ signedIn: true, user: 'ana@contoso.example' })

    const asked = new URL(opened[0] as string)
    expect(asked.origin + asked.pathname).toBe(`${ISSUER}/authorize`)
    expect(asked.searchParams.get('client_id')).toBe('dashboard')
    expect(asked.searchParams.get('code_challenge_method')).toBe('S256')
    expect(asked.searchParams.get('scope')).toBe('openid email api.read')
    expect(asked.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // An app's provider is named by its issuer: no MCP resource parameter.
    expect(asked.searchParams.has('resource')).toBe(false)
    const exchange = idp.bodies[0] as URLSearchParams
    expect(exchange.get('code')).toBe('the-code')
    expect(exchange.get('code_verifier')?.length).toBeGreaterThan(40)
    expect(exchange.get('client_id')).toBe('dashboard')
    expect(exchange.has('client_secret')).toBe(false)

    expect(signIns.token('dashboard', auth)).toBe('access-1')
    expect(readFileSync(file).toString('utf8')).not.toContain('access-1')
    // Another tenant's client counts for nothing.
    expect(signIns.token('dashboard', { ...auth, clientId: 'other' })).toBeNull()
    signIns.signOut('dashboard', 'corp')
    expect(signIns.state('dashboard', auth)).toEqual({ signedIn: false, user: null })
    expect(signIns.token('dashboard', auth)).toBeNull()
  })

  it('refreshes a token that is due, and signs out when the provider refuses', async () => {
    const file = join(tmp(), 'pack-signins.bin')
    const idp = provider()
    const store = new PackSecrets(file, cipher)
    const signIns = new PackSignIns(store, idp.fetchFn)
    const [auth] = effectiveAuth([{ ...CORP, issuer: ISSUER }], undefined)
    if (!auth) throw new Error('no auth')
    await signIns.signIn('dashboard', auth, browser([]))
    // Due in under a minute: status refreshes first.
    const stored = JSON.parse(store.get('dashboard', 'corp') as string)
    stored.secret.expiresAt = Date.now() + 10_000
    store.set('dashboard', 'corp', JSON.stringify(stored))
    await signIns.fresh('dashboard', auth)
    expect(signIns.token('dashboard', auth)).toBe('access-2')
    expect(idp.bodies[1]?.get('refresh_token')).toBe('refresh-1')
    expect(idp.bodies[1]?.has('resource')).toBe(false)

    const refusing = new PackSignIns(store, provider({ refuseRefresh: true }).fetchFn)
    const due = JSON.parse(store.get('dashboard', 'corp') as string)
    due.secret.expiresAt = Date.now() - 1000
    store.set('dashboard', 'corp', JSON.stringify(due))
    expect(await refusing.fresh('dashboard', auth)).toEqual({ signedIn: false, user: null })
    expect(store.get('dashboard', 'corp')).toBeNull()
  })

  it('keeps a sign-in when the provider can’t be reached, for the next try', async () => {
    const file = join(tmp(), 'pack-signins.bin')
    const store = new PackSecrets(file, cipher)
    const [auth] = effectiveAuth([{ ...CORP, issuer: ISSUER }], undefined)
    if (!auth) throw new Error('no auth')
    await new PackSignIns(store, provider().fetchFn).signIn('dashboard', auth, browser([]))
    const due = JSON.parse(store.get('dashboard', 'corp') as string)
    due.secret.expiresAt = Date.now() - 1000
    store.set('dashboard', 'corp', JSON.stringify(due))
    const offline = new PackSignIns(store, provider({ down: true }).fetchFn)
    expect((await offline.fresh('dashboard', auth)).signedIn).toBe(true)
    expect(offline.token('dashboard', auth)).toBeNull()
    expect(store.get('dashboard', 'corp')).not.toBeNull()
  })

  it('cancels when the person closes the sign-in page', async () => {
    const signIns = new PackSignIns(new PackSecrets(join(tmp(), 'pack-signins.bin'), cipher), provider().fetchFn)
    const [auth] = effectiveAuth([{ ...CORP, issuer: ISSUER }], undefined)
    if (!auth) throw new Error('no auth')
    const cancel = new AbortController()
    const run = signIns.signIn('dashboard', auth, () => {
      setTimeout(() => cancel.abort(), 10)
      return () => undefined
    }, cancel.signal)
    expect(signIns.signingIn('dashboard', 'corp')).toBe(true)
    await expect(run).rejects.toBeInstanceOf(OAuthError)
    expect(signIns.signingIn('dashboard', 'corp')).toBe(false)
  })
})
