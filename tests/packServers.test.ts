/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  session: { fromPartition: () => ({}) },
}))

import { NO_PACK_PERMISSIONS, PACK_MANIFEST_FILE, describePackPermissions, packDirectAllowed, permissionDiff, type PackApp, type PackManifest, type PackSecret } from '@shared/packs'
import { packFetch } from '../src/main/packs/bridge'
import { findSecrets, readPackFolder } from '../src/main/packs/files'
import { validatePack, type PackFiles } from '../src/main/packs/manifest'
import { appCsp, hostSources, proxyBypass } from '../src/main/packs/sandbox'
import { DevEnv, PackSecrets, SecretsUnavailable, keyIn, packEnv, parseDotEnv, withSecretHeaders, type SecretCipher } from '../src/main/packs/secrets'

// Apps and their own servers (docs/apps.md › Your own servers): which hosts an
// app's pages may reach straight, the keys the person enters (never in the
// pack, never readable by its code, only on requests to their hosts), public
// env values, a linked folder's .env, and the keys a pack must not carry.

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'apex-pack-servers-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const app = (over: Partial<PackApp> = {}): PackApp => ({ id: 'main', name: 'Board', root: 'app', entry: 'index.html', build: 'kit', kind: 'tool', ...over })
const KEY: PackSecret = { id: 'ACME_KEY', name: 'Acme API key', description: 'From acme.example › Settings.', hosts: ['api.acme.example'], header: 'Authorization', prefix: 'Bearer ' }
const manifest = (over: Partial<PackManifest> = {}): PackManifest => ({
  format: 'apex-pack',
  manifestVersion: 2,
  id: 'board',
  name: 'Board',
  version: '1.0.0',
  description: 'A board for your team.',
  contributes: { apps: [app()] },
  permissions: { ...NO_PACK_PERMISSIONS, network: ['api.acme.example', 'cdn.other.example'] },
  ...over,
})
const pack = (m: PackManifest, files: Record<string, string> = {}): PackFiles =>
  new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(m))], ['app/index.html', Buffer.from('<!doctype html><script type="module" src="./main.js"></script>')], ['app/main.js', Buffer.from('export {}\n')], ...Object.entries(files).map(([p, d]) => [p, Buffer.from(d)] as [string, Buffer])])
const problems = (files: PackFiles): string => {
  const check = validatePack(files)
  return check.ok ? '' : check.problems.join('\n')
}

// Key-shaped text for the tests, put together here so no real-looking key sits in the source.
const fake = {
  stripe: ['sk', 'live', 'a1b2c3d4e5f6g7h8i9j0k1l2'].join('_'),
  aws: `AKIA${'ABCDEFGHIJKLMNOP'}`,
  pem: `-----BEGIN ${'PRIVATE KEY'}-----\\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(3)}`,
  jwt: (payload: object): string => ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'c2lnbmF0dXJlLXNpZ25hdHVyZQ'].join('.'),
}

describe('the manifest: secrets and env', () => {
  it('takes keys for hosts the pack may reach, and public env values', () => {
    const check = validatePack(pack(manifest({ secrets: [KEY], env: { SERVER_URL: 'https://api.acme.example' } })))
    expect(check.ok ? '' : check.problems.join('\n')).toBe('')
    if (check.ok) expect(check.pack.manifest.secrets?.[0]?.hosts).toEqual(['api.acme.example'])
  })

  it('sends a key only where the pack may send requests, in a header the browser leaves alone', () => {
    expect(problems(pack(manifest({ secrets: [{ ...KEY, hosts: ['evil.example'] }] })))).toMatch(/evil\.example is not in permissions\.network/)
    expect(problems(pack(manifest({ secrets: [{ ...KEY, header: 'Cookie' }] })))).toMatch(/can't go in Cookie/)
    expect(problems(pack(manifest({ secrets: [{ ...KEY, prefix: 'Bearer\r\nX: y' }] })))).toMatch(/control character/)
    expect(problems(pack(manifest({ secrets: [KEY, KEY] })))).toMatch(/used twice/)
    expect(problems(pack(manifest({ secrets: [{ ...KEY, id: 'acme' }] })))).toMatch(/capitals/)
    // An optional host counts, and a wildcard covers the names under it.
    expect(problems(pack(manifest({ secrets: [{ ...KEY, hosts: ['eu.acme.example'] }], permissions: { ...NO_PACK_PERMISSIONS, network: ['*.acme.example'] } })))).toBe('')
    expect(problems(pack(manifest({ secrets: [{ ...KEY, hosts: ['opt.example'] }], optionalPermissions: { network: ['opt.example'] } })))).toBe('')
  })

  it('keeps env public: no keys in it, no name shared with a secret, manifest version 2', () => {
    expect(problems(pack(manifest({ env: { STRIPE: fake.stripe } })))).toMatch(/env\.STRIPE: looks like a Stripe secret key/)
    expect(problems(pack(manifest({ secrets: [KEY], env: { ACME_KEY: 'x' } })))).toMatch(/is also a secret/)
    expect(problems(pack(manifest({ manifestVersion: 1, contributes: { panels: [{ id: 'p', title: 'P', html: 'p.html' }] }, env: { A: 'b' } }), { 'p.html': '<p>hi</p>' }))).toMatch(/secrets, env and auth need "manifestVersion": 2/)
  })

  it('refuses a .env file in a pack', () => {
    expect(problems(pack(manifest(), { 'app/.env': 'ACME_KEY=abc' }))).toMatch(/app\/\.env: a \.env file holds keys/)
  })

  it('shows a key on the review with where it goes, and asks again when that changes', () => {
    const m = manifest({ secrets: [KEY] })
    const line = describePackPermissions(m).find((l) => l.kind === 'secrets')
    expect(line).toMatchObject({ key: 'packs.perm.secrets', vars: { names: 'Acme API key', hosts: 'api.acme.example', count: 1 } })
    expect(permissionDiff(m, m)).toEqual([])
    const moved = manifest({ secrets: [{ ...KEY, hosts: ['cdn.other.example'] }] })
    expect(permissionDiff(m, moved).map((l) => l.kind)).toEqual(['secrets'])
  })
})

describe('direct connections from an app', () => {
  it('lets an app reach its hosts over https and wss, and this computer over http and ws', () => {
    expect(packDirectAllowed(['api.acme.example'], 'https://api.acme.example/v1')).toBe(true)
    expect(packDirectAllowed(['api.acme.example'], 'wss://api.acme.example:8443/socket')).toBe(true)
    expect(packDirectAllowed(['api.acme.example'], 'http://api.acme.example/')).toBe(false)
    expect(packDirectAllowed(['api.acme.example'], 'ws://api.acme.example/')).toBe(false)
    expect(packDirectAllowed(['localhost'], 'ws://localhost:8787/')).toBe(true)
    expect(packDirectAllowed(['api.acme.example'], 'https://evil.example/')).toBe(false)
    expect(packDirectAllowed(['api.acme.example'], 'https://user:pw@api.acme.example/')).toBe(false)
    expect(packDirectAllowed(['*.acme.example'], 'https://acme.example/')).toBe(true)
  })

  it('names the hosts in an app’s CSP for connections, images and media, and never for code', () => {
    const csp = appCsp({ eval: false }, [], ['api.acme.example', 'localhost'])
    const part = (name: string): string => csp.split('; ').find((p) => p.startsWith(`${name} `)) ?? ''
    expect(part('connect-src')).toContain('https://api.acme.example:*')
    expect(part('connect-src')).toContain('wss://api.acme.example:*')
    expect(part('connect-src')).toContain('ws://localhost:*')
    expect(part('connect-src')).not.toContain('ws://api.acme.example')
    expect(part('img-src')).toContain('https://api.acme.example:*')
    expect(part('media-src')).toContain('https://api.acme.example:*')
    expect(part('script-src')).not.toContain('acme')
    expect(part('frame-src')).not.toContain('acme')
    expect(appCsp({ eval: false }, [])).toBe(appCsp({ eval: false }, [], []))
    expect(hostSources(['*.acme.example'], true)).toEqual(['https://*.acme.example:*', 'wss://*.acme.example:*', 'https://acme.example:*', 'wss://acme.example:*'])
  })

  it('sends only the hosts it may reach now past the dead-end proxy', () => {
    expect(proxyBypass([])).toBe('<-loopback>')
    expect(proxyBypass(['api.acme.example', '*.cdn.example'])).toBe('<-loopback>,api.acme.example,*.cdn.example,cdn.example')
  })
})

describe('keys on requests', () => {
  const valueOf = (id: string): string | null => (id === 'ACME_KEY' ? 'k-123456789' : null)

  it('puts a key in its header on requests to its hosts, over whatever the page set', () => {
    expect(withSecretHeaders([KEY], valueOf, 'https://api.acme.example/v1', { Accept: 'application/json', authorization: 'Bearer guess' })).toEqual({ Accept: 'application/json', Authorization: 'Bearer k-123456789' })
    expect(withSecretHeaders([KEY], valueOf, 'wss://api.acme.example/socket', {})).toEqual({ Authorization: 'Bearer k-123456789' })
  })

  it('never carries a key anywhere else, and changes nothing without one', () => {
    expect(withSecretHeaders([KEY], valueOf, 'https://cdn.other.example/', { Accept: '*/*' })).toBeNull()
    expect(withSecretHeaders([KEY], valueOf, 'https://cdn.other.example/', { Authorization: 'Bearer k-123456789' })).toEqual({})
    expect(withSecretHeaders([KEY], valueOf, 'http://api.acme.example/', {})).toBeNull()
    expect(withSecretHeaders([KEY], () => null, 'https://api.acme.example/', {})).toBeNull()
    expect(withSecretHeaders(undefined, valueOf, 'https://api.acme.example/', {})).toBeNull()
  })

  it('adds the key on apex.fetch hop by hop, so a redirect to another host goes without it', async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = []
    const doFetch = vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string> })
      if (url === 'https://api.acme.example/start') return new Response(null, { status: 302, headers: { location: 'https://cdn.other.example/file' } })
      return new Response('ok')
    }) as unknown as typeof fetch
    const refuse = (why: string): never => {
      throw new Error(why)
    }
    const res = await packFetch({ url: 'https://api.acme.example/start', init: { headers: { 'X-App': '1' } }, network: ['api.acme.example', 'cdn.other.example'], doFetch, refuse, headersFor: (url, h) => withSecretHeaders([KEY], valueOf, url, h) })
    expect(res.body).toBe('ok')
    expect(sent[0]?.headers).toEqual({ 'X-App': '1', Authorization: 'Bearer k-123456789' })
    expect(sent[1]?.headers).toEqual({ 'X-App': '1' })
  })
})

describe('where keys are kept', () => {
  // Stands in for the keychain: what's on disk is not the text that went in.
  const cipher: SecretCipher = {
    available: () => true,
    encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map((b) => b ^ 0x5a)),
    decrypt: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString('utf8'),
  }

  it('keeps keys per pack, encrypted, and forgets a removed pack’s', () => {
    const file = join(tmp(), 'pack-keys.bin')
    const store = new PackSecrets(file, cipher)
    store.set('board', 'ACME_KEY', 'k-123456789')
    store.set('other', 'TOKEN', 't-1')
    expect(readFileSync(file).toString('utf8')).not.toContain('k-123456789')
    const again = new PackSecrets(file, cipher)
    expect(again.get('board', 'ACME_KEY')).toBe('k-123456789')
    again.clear('board', 'ACME_KEY')
    expect(again.get('board', 'ACME_KEY')).toBeNull()
    again.forget('other')
    expect(new PackSecrets(file, cipher).get('other', 'TOKEN')).toBeNull()
  })

  it('keeps nothing without a keychain', () => {
    const store = new PackSecrets(join(tmp(), 'pack-keys.bin'), { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' })
    expect(() => store.set('board', 'ACME_KEY', 'x')).toThrow(SecretsUnavailable)
    expect(store.get('board', 'ACME_KEY')).toBeNull()
  })
})

describe('a linked folder’s .env', () => {
  it('reads .env as dotenv does', () => {
    expect(parseDotEnv('# a comment\nexport SERVER_URL=http://localhost:8787 # dev\nACME_KEY="a b\\nc"\nQUOTED=\'x # y\'\nEMPTY=\n﻿bad line\n')).toEqual({ SERVER_URL: 'http://localhost:8787', ACME_KEY: 'a b\nc', QUOTED: 'x # y', EMPTY: '' })
  })

  it('overrides only the names the manifest declares, with .env.local last', () => {
    const dir = tmp()
    writeFileSync(join(dir, '.env'), 'SERVER_URL=http://localhost:8787\nDATABASE_URL=postgres://secret\n')
    writeFileSync(join(dir, '.env.local'), 'SERVER_URL=http://127.0.0.1:9000\n')
    const env = new DevEnv()
    expect(packEnv({ SERVER_URL: 'https://api.acme.example', MODE: 'live' }, env.values(dir))).toEqual({ SERVER_URL: 'http://127.0.0.1:9000', MODE: 'live' })
    expect(packEnv({ SERVER_URL: 'https://api.acme.example' }, null)).toEqual({ SERVER_URL: 'https://api.acme.example' })
  })

  it('never reads .env or .npmrc into a pack', () => {
    const dir = tmp()
    mkdirSync(join(dir, 'app'))
    writeFileSync(join(dir, PACK_MANIFEST_FILE), JSON.stringify(manifest()))
    writeFileSync(join(dir, 'app', 'index.html'), '<p>hi</p>')
    for (const name of ['.env', '.env.local', '.env.production', '.npmrc']) writeFileSync(join(dir, name), 'X=1')
    writeFileSync(join(dir, 'app', '.env'), 'X=1')
    expect([...readPackFolder(dir).keys()].sort()).toEqual([PACK_MANIFEST_FILE, 'app/index.html'])
  })
})

describe('keys a pack must not carry', () => {
  it('finds real key formats, and leaves keys meant to be public alone', () => {
    expect(keyIn(`const stripe = "${fake.stripe}"`, false)).toBe('a Stripe secret key')
    expect(keyIn(`aws = "${fake.aws}"`, false)).toBe('an AWS access key')
    expect(keyIn(`const pem = "${fake.pem}"`, false)).toBe('a private key')
    expect(keyIn(`const k = "${fake.jwt({ role: 'service_role', iss: 'supabase' })}"`, false)).toBe('a Supabase service key')
    // A library's PEM parser, Firebase's web config, a Supabase anon key and Stripe's publishable key are all fine.
    expect(keyIn('if (line === "-----BEGIN PRIVATE KEY-----") parse()', true)).toBeNull()
    expect(keyIn(`firebase.initializeApp({ apiKey: "AIza${'SyA1234567890abcdefghijklmnopqrstu'}" })`, true)).toBeNull()
    expect(keyIn(`createClient(url, "${fake.jwt({ role: 'anon' })}")`, true)).toBeNull()
    expect(keyIn(`Stripe("pk_live_${'a1b2c3d4e5f6g7h8i9j0'}")`, true)).toBeNull()
  })

  it('reads password-like assignments only in code a person wrote, and skips placeholders', () => {
    expect(keyIn('const config = { password: "hunter2hunter2hunter2" }', true)).toBe('what looks like a password or key')
    expect(keyIn('const config = { password: "hunter2hunter2hunter2" }', false)).toBeNull()
    expect(keyIn('const config = { apiKey: "YOUR_API_KEY_GOES_HERE" }', true)).toBeNull()
  })

  it('checks text files only, a build’s output without the password check, and names .env files', () => {
    const m = manifest({ contributes: { apps: [app({ build: 'bundled', root: 'dist' })] } })
    const files: PackFiles = new Map([
      [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(m))],
      ['dist/index.js', Buffer.from('var o={password:"hunter2hunter2hunter2"};')],
      ['dist/art.png', Buffer.from(`\x89PNG ${fake.stripe}`)],
      ['notes.md', Buffer.from(`key: ${fake.aws}`)],
      ['.env', Buffer.from('X=1')],
    ])
    expect(findSecrets(files)).toEqual([
      { path: 'notes.md', what: 'an AWS access key' },
      { path: '.env', what: 'a .env file' },
    ])
  })
})
