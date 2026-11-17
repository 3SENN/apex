/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isPrivateHost } from '@shared/connectors'
import { mainT } from '../i18n/mainT'
import type { OAuthSecret } from './store'

// MCP authorization for remote connectors, per the 2026 spec: Protected Resource Metadata (RFC 9728), then the
// authorization server's metadata (RFC 8414, or OIDC discovery), PKCE S256
// (refused when the server doesn't list it), `state`, the RFC 8707
// `resource` on both requests, and the RFC 9207 `iss` check. Registration
// order: a pre-registered client (Google's setup) → dynamic registration as a
// native app → none, which falls back to pasting a token. Sign-in runs in a
// tab and redirects to a loopback server on 127.0.0.1 that lives only for
// the sign-in.

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export type OAuthErrorCode = 'no-metadata' | 'no-pkce' | 'no-registration' | 'state' | 'issuer' | 'denied' | 'token' | 'timeout' | 'cancelled' | 'insecure' | 'expired'

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly detail = '',
  ) {
    super(mainT(`connectors.oauth.${code}`, { detail }))
  }
}

export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  authorization_response_iss_parameter_supported?: boolean
  scopes_supported?: string[]
}

export interface Discovery {
  resource: string
  metadata: AuthServerMetadata
  scopes: string[]
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** https, or http only for loopback and private addresses (local fixtures, dev servers). */
function checkEndpoint(url: string): string {
  const u = new URL(url)
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isPrivateHost(u.hostname))) return u.href
  throw new OAuthError('insecure', u.host)
}

async function getJson(fetchFn: FetchFn, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchFn(url, { headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-11-25' } })
    if (!res.ok) return null
    const body: unknown = await res.json()
    return isObject(body) ? body : null
  } catch {
    return null
  }
}

/** `resource_metadata="…"` from a 401's WWW-Authenticate header. */
export function resourceMetadataFrom(header: string | null): string | null {
  if (!header) return null
  return /resource_metadata="([^"]+)"/i.exec(header)?.[1] ?? null
}

/** RFC 8414 path-insertion order, then OIDC's two placements. */
export function metadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/+$/, '')
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
}

export async function discover(resourceUrl: string, fetchFn: FetchFn): Promise<Discovery> {
  const resource = new URL(resourceUrl)
  // The server names its metadata in a 401; otherwise try the well-known spots.
  let prmUrl: string | null = null
  try {
    const res = await fetchFn(resource.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: BRAND_NAME, version: '1.0.0' } } }),
    })
    if (res.status === 401) prmUrl = resourceMetadataFrom(res.headers.get('www-authenticate'))
    await res.body?.cancel().catch(() => undefined)
  } catch {
    // Unreachable now; the well-known lookups below report it.
  }
  const path = resource.pathname.replace(/\/+$/, '')
  const candidates = [prmUrl, path ? `${resource.origin}/.well-known/oauth-protected-resource${path}` : null, `${resource.origin}/.well-known/oauth-protected-resource`].filter((u): u is string => !!u)
  let prm: Record<string, unknown> | null = null
  for (const url of candidates) {
    prm = await getJson(fetchFn, checkEndpoint(url))
    if (prm) break
  }
  const servers = prm && Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter((s): s is string => typeof s === 'string') : []
  // Older servers have no resource metadata: their own origin is the authorization server.
  const issuer = servers[0] ?? resource.origin
  let metadata: AuthServerMetadata | null = null
  for (const url of metadataUrls(issuer)) {
    const body = await getJson(fetchFn, checkEndpoint(url))
    if (body && typeof body.authorization_endpoint === 'string' && typeof body.token_endpoint === 'string') {
      metadata = body as unknown as AuthServerMetadata
      break
    }
  }
  if (!metadata) throw new OAuthError('no-metadata')
  if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new OAuthError('no-pkce')
  checkEndpoint(metadata.authorization_endpoint)
  checkEndpoint(metadata.token_endpoint)
  const prmResource = prm && typeof prm.resource === 'string' ? prm.resource : resource.href
  const scopes = prm && Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((s): s is string => typeof s === 'string') : (metadata.scopes_supported ?? [])
  return { resource: prmResource, metadata: { ...metadata, issuer: typeof metadata.issuer === 'string' ? metadata.issuer : issuer }, scopes }
}

export interface OAuthClient {
  clientId: string
  clientSecret: string | null
  authMethod: OAuthSecret['authMethod']
}

/** A pre-registered client when you gave one, else dynamic registration as a native app. */
export async function registerClient(metadata: AuthServerMetadata, redirectUri: string, fetchFn: FetchFn, preRegistered?: { clientId: string; clientSecret: string | null }): Promise<OAuthClient> {
  const methods = metadata.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
  if (preRegistered) {
    const authMethod = !preRegistered.clientSecret ? 'none' : methods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic'
    return { clientId: preRegistered.clientId, clientSecret: preRegistered.clientSecret, authMethod }
  }
  if (!metadata.registration_endpoint) throw new OAuthError('no-registration')
  const res = await fetchFn(checkEndpoint(metadata.registration_endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: BRAND_NAME,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  }).catch(() => null)
  const body: unknown = res && res.ok ? await res.json().catch(() => null) : null
  if (!isObject(body) || typeof body.client_id !== 'string') throw new OAuthError('no-registration')
  const secret = typeof body.client_secret === 'string' ? body.client_secret : null
  const method = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : secret ? 'client_secret_basic' : 'none'
  return { clientId: body.client_id, clientSecret: secret, authMethod: method === 'client_secret_post' ? 'client_secret_post' : method === 'none' ? 'none' : 'client_secret_basic' }
}

const b64url = (buf: Buffer): string => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authorizeUrl(d: Discovery, client: OAuthClient, redirectUri: string, state: string, challenge: string, scope: string | null): string {
  const url = new URL(d.metadata.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  if (d.resource) url.searchParams.set('resource', d.resource)
  if (scope) url.searchParams.set('scope', scope)
  return url.href
}

async function tokenRequest(endpoint: string, client: OAuthClient, params: Record<string, string>, fetchFn: FetchFn): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  if (client.authMethod === 'client_secret_basic' && client.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`
  } else {
    body.set('client_id', client.clientId)
    if (client.authMethod === 'client_secret_post' && client.clientSecret) body.set('client_secret', client.clientSecret)
  }
  const res = await fetchFn(checkEndpoint(endpoint), { method: 'POST', headers, body: body.toString() }).catch(() => null)
  const json: unknown = res ? await res.json().catch(() => null) : null
  if (!res?.ok || !isObject(json) || typeof json.access_token !== 'string') {
    const detail = isObject(json) && typeof json.error === 'string' ? json.error : res ? `HTTP ${res.status}` : 'unreachable'
    throw new OAuthError('token', detail)
  }
  return json
}

function toSecret(json: Record<string, unknown>, d: Pick<Discovery, 'resource'> & { metadata: Pick<AuthServerMetadata, 'issuer' | 'token_endpoint'> }, client: OAuthClient, previous?: OAuthSecret, now = Date.now()): OAuthSecret {
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : typeof json.expires_in === 'string' ? Number(json.expires_in) : NaN
  return {
    accessToken: json.access_token as string,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : (previous?.refreshToken ?? null),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    issuer: d.metadata.issuer,
    tokenEndpoint: d.metadata.token_endpoint,
    resource: d.resource,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    authMethod: client.authMethod,
    scope: typeof json.scope === 'string' ? json.scope : (previous?.scope ?? null),
  }
}

/** Whether a token should be refreshed before use (a minute of margin). */
export function needsRefresh(secret: OAuthSecret, now = Date.now()): boolean {
  return secret.expiresAt !== null && secret.expiresAt - now < 60_000
}

export async function refresh(secret: OAuthSecret, fetchFn: FetchFn): Promise<OAuthSecret> {
  if (!secret.refreshToken) throw new OAuthError('expired')
  const client: OAuthClient = { clientId: secret.clientId, clientSecret: secret.clientSecret, authMethod: secret.authMethod }
  const json = await tokenRequest(secret.tokenEndpoint, client, { grant_type: 'refresh_token', refresh_token: secret.refreshToken, ...(secret.resource ? { resource: secret.resource } : {}) }, fetchFn)
  return toSecret(json, { resource: secret.resource, metadata: { issuer: secret.issuer, token_endpoint: secret.tokenEndpoint } }, client, secret)
}

export interface SignInOptions {
  resourceUrl: string
  fetchFn: FetchFn
  /** Opens the authorization page (a tab of the current profile); returns how to close it. */
  open(url: string): () => void
  preRegistered?: { clientId: string; clientSecret: string | null }
  /** Extra scopes a directory entry asks for (Google's), else the server's own list. */
  scopes?: string[]
  timeoutMs?: number
  signal?: AbortSignal
}

const DONE_PAGE = (ok: boolean): string =>
  `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${BRAND_NAME}</title><body style="font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0"><p>${mainT(ok ? 'connectors.oauth.donePage' : 'connectors.oauth.failedPage')}</p></body>`

/** One full sign-in: discovery, registration, the browser step on a loopback redirect, and the code exchange. */
export async function signIn(options: SignInOptions): Promise<OAuthSecret> {
  const discovery = await discover(options.resourceUrl, options.fetchFn)
  const done = await codeFlow({
    discovery,
    client: (redirectUri) => registerClient(discovery.metadata, redirectUri, options.fetchFn, options.preRegistered),
    scopes: options.scopes?.length ? options.scopes : discovery.scopes,
    open: options.open,
    fetchFn: options.fetchFn,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
  return toSecret(done.json, discovery, done.client)
}

/** An identity provider's metadata from its issuer (RFC 8414, or OpenID discovery). */
export async function discoverIssuer(issuer: string, fetchFn: FetchFn): Promise<AuthServerMetadata> {
  checkEndpoint(issuer)
  for (const url of metadataUrls(issuer)) {
    const body = await getJson(fetchFn, checkEndpoint(url))
    if (!body || typeof body.authorization_endpoint !== 'string' || typeof body.token_endpoint !== 'string') continue
    const metadata = body as unknown as AuthServerMetadata
    // A provider that lists its PKCE methods must list S256; many OpenID providers support it without saying so.
    if (metadata.code_challenge_methods_supported && !metadata.code_challenge_methods_supported.includes('S256')) throw new OAuthError('no-pkce')
    checkEndpoint(metadata.authorization_endpoint)
    checkEndpoint(metadata.token_endpoint)
    return { ...metadata, issuer: typeof metadata.issuer === 'string' ? metadata.issuer : issuer }
  }
  throw new OAuthError('no-metadata')
}

export interface IssuerSignInOptions {
  issuer: string
  /** A public client: no secret, the loopback redirect on any port. */
  clientId: string
  scopes: string[]
  fetchFn: FetchFn
  open(url: string): () => void
  timeoutMs?: number
  signal?: AbortSignal
}

/** A sign-in to a named identity provider (an app's `auth`), with the ID token when the provider gives one. */
export async function signInToIssuer(options: IssuerSignInOptions): Promise<{ secret: OAuthSecret; idToken: string | null }> {
  const metadata = await discoverIssuer(options.issuer, options.fetchFn)
  const discovery: Discovery = { resource: '', metadata, scopes: options.scopes }
  const client: OAuthClient = { clientId: options.clientId, clientSecret: null, authMethod: 'none' }
  const done = await codeFlow({ discovery, client: async () => client, scopes: options.scopes, open: options.open, fetchFn: options.fetchFn, timeoutMs: options.timeoutMs, signal: options.signal })
  return { secret: toSecret(done.json, discovery, client), idToken: typeof done.json.id_token === 'string' ? done.json.id_token : null }
}

/** The browser step on a loopback redirect, then the code exchange. */
async function codeFlow(options: {
  discovery: Discovery
  client(redirectUri: string): Promise<OAuthClient>
  scopes: string[]
  open(url: string): () => void
  fetchFn: FetchFn
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<{ json: Record<string, unknown>; client: OAuthClient }> {
  const { discovery, scopes } = options
  const { verifier, challenge } = pkcePair()
  const state = b64url(randomBytes(24))
  const loopback = await startLoopback()
  let close: (() => void) | null = null
  try {
    const redirectUri = `http://127.0.0.1:${loopback.port}/callback`
    const client = await options.client(redirectUri)
    close = options.open(authorizeUrl(discovery, client, redirectUri, state, challenge, scopes.length ? scopes.join(' ') : null))
    const params = await loopback.wait(options.timeoutMs ?? 5 * 60_000, options.signal)
    const fail = (err: OAuthError): never => {
      loopback.respond(false)
      throw err
    }
    if (params.get('state') !== state) fail(new OAuthError('state'))
    const iss = params.get('iss')
    if ((iss || discovery.metadata.authorization_response_iss_parameter_supported) && iss !== discovery.metadata.issuer) fail(new OAuthError('issuer'))
    const error = params.get('error')
    if (error) fail(error === 'access_denied' ? new OAuthError('cancelled') : new OAuthError('denied', error.slice(0, 60)))
    const code = params.get('code')
    if (!code) fail(new OAuthError('token', 'no code'))
    const exchange = { grant_type: 'authorization_code', code: code as string, redirect_uri: redirectUri, code_verifier: verifier, ...(discovery.resource ? { resource: discovery.resource } : {}) }
    const json = await tokenRequest(discovery.metadata.token_endpoint, client, exchange, options.fetchFn).catch((err: unknown) => {
      loopback.respond(false)
      throw err
    })
    loopback.respond(true)
    return { json, client }
  } finally {
    loopback.close()
    close?.()
  }
}

interface Loopback {
  port: number
  wait(timeoutMs: number, signal?: AbortSignal): Promise<URLSearchParams>
  respond(ok: boolean): void
  close(): void
}

/** A one-shot HTTP server on 127.0.0.1 and a random port, for the redirect only. */
function startLoopback(): Promise<Loopback> {
  return new Promise((resolveStart, rejectStart) => {
    let deliver: ((p: URLSearchParams) => void) | null = null
    let pendingResponse: import('node:http').ServerResponse | null = null
    let received: URLSearchParams | null = null
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback' || received) {
        res.writeHead(404).end()
        return
      }
      received = url.searchParams
      pendingResponse = res
      deliver?.(received)
    })
    server.on('error', rejectStart)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolveStart({
        port,
        wait: (timeoutMs, signal) =>
          new Promise((resolve, reject) => {
            if (received) return resolve(received)
            const timer = setTimeout(() => reject(new OAuthError('timeout')), timeoutMs)
            signal?.addEventListener('abort', () => {
              clearTimeout(timer)
              reject(new OAuthError('cancelled'))
            })
            deliver = (p) => {
              clearTimeout(timer)
              resolve(p)
            }
          }),
        respond: (ok) => {
          const res = pendingResponse
          pendingResponse = null
          res?.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(DONE_PAGE(ok))
        },
        close: () => {
          const res = pendingResponse
          pendingResponse = null
          res?.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(false))
          server.close()
          server.closeAllConnections?.()
        },
      })
    })
  })
}
