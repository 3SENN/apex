/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectorsCore } from '../src/main/connectors/core'
import { FaviconCache } from '../src/main/connectors/favicons'
import { OAuthError, metadataUrls, needsRefresh, refresh, resourceMetadataFrom, signIn } from '../src/main/connectors/oauth'
import { ConnectorStore, type SecretCipher } from '../src/main/connectors/store'

// MCP sign-in against an in-process fake authorization server on
// 127.0.0.1: discovery, dynamic registration, PKCE S256, state and issuer
// checks, refresh, and the fallbacks when a server can't do it.

interface FakeOptions {
  registration?: boolean
  pkce?: boolean
  failRefresh?: boolean
}

interface Fake {
  base: string
  options: FakeOptions
  tokens: string[]
  close(): Promise<void>
}

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let text = ''
    req.on('data', (c: Buffer) => (text += c.toString()))
    req.on('end', () => resolve(text))
  })

async function fakeServer(options: FakeOptions = {}): Promise<Fake> {
  const challenges = new Map<string, string>()
  const tokens: string[] = []
  let base = ''
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base)
    const json = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify(value))
    }
    if (url.pathname === '/mcp') {
      const auth = req.headers.authorization ?? ''
      const token = auth.replace(/^Bearer /, '')
      if (!tokens.includes(token)) return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
      if (req.method !== 'POST') return res.writeHead(405).end()
      const msg = JSON.parse(await body(req)) as { id?: number; method: string; params?: { protocolVersion?: string } }
      if (msg.id === undefined) return res.writeHead(202).end()
      if (msg.method === 'initialize') return json(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
      if (msg.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'whoami', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } })
      return json(200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } })
    }
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [`${base}/auth`], scopes_supported: ['read'] })
    if (url.pathname === '/.well-known/oauth-authorization-server/auth') {
      return json(200, {
        issuer: `${base}/auth`,
        authorization_endpoint: `${base}/auth/authorize`,
        token_endpoint: `${base}/auth/token`,
        ...(options.registration === false ? {} : { registration_endpoint: `${base}/auth/register` }),
        ...(options.pkce === false ? {} : { code_challenge_methods_supported: ['S256'] }),
        authorization_response_iss_parameter_supported: true,
      })
    }
    if (url.pathname === '/auth/register') {
      const reg = JSON.parse(await body(req)) as { application_type?: string; redirect_uris?: string[] }
      if (reg.application_type !== 'native' || !reg.redirect_uris?.[0]?.startsWith('http://127.0.0.1:')) return json(400, { error: 'invalid_client_metadata' })
      return json(201, { client_id: 'client-1' })
    }
    if (url.pathname === '/auth/authorize') {
      const p = url.searchParams
      if (p.get('code_challenge_method') !== 'S256' || p.get('resource') !== `${base}/mcp` || p.get('client_id') !== 'client-1') return res.writeHead(400).end()
      challenges.set('code-1', p.get('code_challenge') ?? '')
      const back = new URL(p.get('redirect_uri') ?? '')
      back.searchParams.set('code', 'code-1')
      back.searchParams.set('state', p.get('state') ?? '')
      back.searchParams.set('iss', `${base}/auth`)
      return res.writeHead(302, { Location: back.href }).end()
    }
    if (url.pathname === '/auth/token') {
      const p = new URLSearchParams(await body(req))
      if (p.get('resource') !== `${base}/mcp`) return json(400, { error: 'invalid_target' })
      if (p.get('grant_type') === 'authorization_code') {
        const expected = challenges.get(p.get('code') ?? '')
        const actual = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url')
        if (!expected || expected !== actual) return json(400, { error: 'invalid_grant' })
        tokens.push('at-1')
        return json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' })
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (options.failRefresh || p.get('refresh_token') !== 'rt-1') return json(400, { error: 'invalid_grant' })
        tokens.push('at-2')
        return json(200, { access_token: 'at-2', expires_in: 3600 })
      }
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, options, tokens, close: () => new Promise((r) => server.close(() => r())) }
}

/** Plays the browser: follow the authorize redirect to the loopback, optionally tampering with it. */
const browser = (tamper: (u: URL) => void = () => undefined) => (url: string): (() => void) => {
  void (async () => {
    const res = await fetch(url, { redirect: 'manual' })
    const location = res.headers.get('location')
    if (!location) return
    const back = new URL(location)
    tamper(back)
    await fetch(back).catch(() => undefined)
  })()
  return () => undefined
}

const fakes: Fake[] = []
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close()
})

describe('OAuth sign-in', () => {
  it('completes discovery, registration, PKCE and the code exchange', async () => {
    const fake = await fakeServer()
    fakes.push(fake)
    const secret = await signIn({ resourceUrl: `${fake.base}/mcp`, fetchFn: fetch, open: browser() })
    expect(secret).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1', issuer: `${fake.base}/auth`, clientId: 'client-1', authMethod: 'none', resource: `${fake.base}/mcp` })
    expect(needsRefresh(secret)).toBe(false)
    const next = await refresh(secret, fetch)
    expect(next).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-1' })
  })

  it('ignores an answer whose state doesn’t match', async () => {
    const fake = await fakeServer()
    fakes.push(fake)
    await expect(signIn({ resourceUrl: `${fake.base}/mcp`, fetchFn: fetch, open: browser((u) => u.searchParams.set('state', 'forged')) })).rejects.toMatchObject({ code: 'state' })
  })

  it('refuses an answer from another issuer', async () => {
    const fake = await fakeServer()
    fakes.push(fake)
    await expect(signIn({ resourceUrl: `${fake.base}/mcp`, fetchFn: fetch, open: browser((u) => u.searchParams.set('iss', 'https://evil.example')) })).rejects.toMatchObject({ code: 'issuer' })
  })

  it('falls back to a token when the server has no registration, and refuses without S256', async () => {
    const noReg = await fakeServer({ registration: false })
    const noPkce = await fakeServer({ pkce: false })
    fakes.push(noReg, noPkce)
    await expect(signIn({ resourceUrl: `${noReg.base}/mcp`, fetchFn: fetch, open: browser() })).rejects.toMatchObject({ code: 'no-registration' })
    await expect(signIn({ resourceUrl: `${noPkce.base}/mcp`, fetchFn: fetch, open: browser() })).rejects.toMatchObject({ code: 'no-pkce' })
    await expect(signIn({ resourceUrl: `${noReg.base}/mcp`, fetchFn: fetch, open: browser() }).catch((e: OAuthError) => e.message)).resolves.toMatch(/token/)
  })

  it('times out when nobody comes back', async () => {
    const fake = await fakeServer()
    fakes.push(fake)
    await expect(signIn({ resourceUrl: `${fake.base}/mcp`, fetchFn: fetch, open: () => () => undefined, timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('reads metadata locations the RFC way', () => {
    expect(resourceMetadataFrom('Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource/mcp"')).toBe('https://a.example/.well-known/oauth-protected-resource/mcp')
    expect(resourceMetadataFrom(null)).toBeNull()
    expect(metadataUrls('https://auth.example/tenant')).toEqual([
      'https://auth.example/.well-known/oauth-authorization-server/tenant',
      'https://auth.example/.well-known/openid-configuration/tenant',
      'https://auth.example/tenant/.well-known/openid-configuration',
    ])
    expect(metadataUrls('https://auth.example')).toEqual(['https://auth.example/.well-known/oauth-authorization-server', 'https://auth.example/.well-known/openid-configuration'])
  })
})

describe('connectors with OAuth', () => {
  const cipher: SecretCipher = { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() }

  it('signs in, stores the token encrypted, and marks needs-reconnect when refresh fails', async () => {
    const fake = await fakeServer()
    fakes.push(fake)
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-oauth-'))
    const store = new ConnectorStore(dataDir, cipher)
    const notes: string[] = []
    const core = new ConnectorsCore({ store, dataDir, icons: new FaviconCache(dataDir, null), fetchFn: fetch, openSignIn: browser(), loginPath: async () => null, notify: (title) => notes.push(title) })
    const c = store.save({ name: 'Fake', transport: { kind: 'remote', url: `${fake.base}/mcp` }, auth: 'oauth', enabled: true })
    const connected = await core.reconnect(c.id)
    expect(connected).toMatchObject({ health: 'ok', hasSecret: true, execution: 'local' })
    expect(connected.tools.map((t) => t.name)).toEqual(['whoami'])
    expect(store.secretOf(c.id).oauth?.accessToken).toBe('at-1')

    // Expire the token and make refresh fail: the row needs reconnecting, once.
    fake.options.failRefresh = true
    store.setSecret(c.id, (s) => ({ ...s, oauth: s.oauth && { ...s.oauth, expiresAt: Date.now() - 1 } }))
    const failed = await core.check(c.id)
    expect(failed.health).toBe('needs-reconnect')
    expect(notes).toEqual(['Fake needs reconnecting'])

    // Reconnect signs in again and clears it.
    fake.options.failRefresh = false
    expect((await core.reconnect(c.id)).health).toBe('ok')
    await core.dispose()
  }, 20_000)

  it('offers sign-in when a server without auth answers 401', async () => {
    const fake = await fakeServer()
    fakes.push(fake)
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-oauth-'))
    const store = new ConnectorStore(dataDir, cipher)
    const core = new ConnectorsCore({ store, dataDir, icons: new FaviconCache(dataDir, null), fetchFn: fetch, openSignIn: browser(), loginPath: async () => null, notify: () => undefined })
    const c = store.save({ name: 'Plain', url: `${fake.base}/mcp`, enabled: true })
    expect((await core.check(c.id)).health).toBe('error')
    await expect.poll(() => store.view(c.id)?.health, { timeout: 5000 }).toBe('needs-reconnect')
    expect(store.view(c.id)?.auth).toBe('oauth')
    await core.dispose()
  }, 20_000)
})
