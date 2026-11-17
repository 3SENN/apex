/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex.server (docs/packs.md › A web server of its own): what main, the
// preload and the tests share about the small web server Apex runs for an
// app. Pure: the checks every request and socket passes before anything
// reaches the app's page.

export const SERVER_LIMITS = {
  /** Open sockets a server takes at most, and by default. */
  connections: 32,
  defaultConnections: 16,
  /** One message from a served page, and one the app sends back. */
  inBytes: 16 * 1024,
  outBytes: 64 * 1024,
  /** Messages a socket may send: a steady rate (motion at 60 Hz with buttons) and a burst. */
  messagesPerSecond: 120,
  messageBurst: 240,
  /** Requests a server answers: a steady rate and a burst. */
  requestsPerSecond: 60,
  requestBurst: 120,
  /** A request body the app's page gets, and what it may answer. */
  requestBodyBytes: 64 * 1024,
  responseBytes: 2 * 1024 * 1024,
  /** How long the page has to answer, and how many requests may wait for it. */
  requestTimeoutMs: 10_000,
  pendingRequests: 32,
  /** A server nobody used (no request, no socket) this long stops. */
  idleMs: 15 * 60_000,
  /** A slow socket's unsent messages past this are dropped, not queued. */
  bufferedBytes: 1024 * 1024,
  queryKeys: 20,
  queryChars: 500,
  pathChars: 1_000,
} as const

/** Where served pages open their socket to the app, under the server's base. */
export const SERVER_SOCKET_PATH = '__apex/socket'
/** The helper served pages may load: one socket that reconnects by itself. */
export const SERVER_CLIENT_PATH = '__apex/client.js'
/** Apex UI and the kit, for served pages that want to look like Apex. */
export const SERVER_KIT_PATH = '__apex/kit/'

export const SERVER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/
export const SERVER_SOCKET_ID_PATTERN = /^s[0-9a-f]{12}$/
export const SERVER_REQUEST_ID_PATTERN = /^r[0-9a-f]{12}$/

/** The pack event (PACK_IPC.event) that carries a batch of server events to the app's page, in order. */
export const SERVER_EVENT_BATCH = 'server.batch'

/** What apex.server.start and status answer. */
export interface PackServerStatus {
  running: boolean
  /** The address on this computer. */
  url: string | null
  /** The address phones and computers on the same Wi-Fi open (https), or null for a server on this computer only. */
  lanUrl: string | null
  port: number | null
  /** A QR code of lanUrl as an image data URL, for the app to show; null without lanUrl. */
  qr: string | null
  lan: boolean
  /** Whether addresses carry the unguessable token. */
  token: boolean
  connections: number
}

export const STOPPED_SERVER: PackServerStatus = { running: false, url: null, lanUrl: null, port: null, qr: null, lan: false, token: false, connections: 0 }

/** Why a server stopped, as the page hears it: its own stop(), the person's Stop, nobody using it, or the page or pack going away. */
export type ServerStopReason = 'stopped' | 'person' | 'idle' | 'closed'

export interface ServerRequestInfo {
  id: string
  method: string
  /** The path below the server's base, from '/'. */
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: string | null
  /** The body parsed, when it was sent as JSON. */
  json?: unknown
}

/** One thing that happened on a server, as the app's page hears it. */
export type ServerEvent =
  | { type: 'connection'; id: string; query: Record<string, string>; remote: 'local' | 'lan' }
  | { type: 'message'; id: string; data: string }
  | { type: 'close'; id: string; code: number }
  | ({ type: 'request' } & ServerRequestInfo)
  | { type: 'stopped'; reason: ServerStopReason }

// ---- who may connect ----

/** The IPv4 address in a socket's remote address (`::ffff:192.168.1.5` too), or null. */
export function ipv4Of(address: string): string | null {
  const plain = address.replace(/^::ffff:/i, '')
  const parts = plain.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null
  return plain
}

export function isLoopbackAddress(address: string): boolean {
  const v4 = ipv4Of(address)
  if (v4) return v4.startsWith('127.')
  return address === '::1'
}

/**
 * Whether a peer is on this computer or a private network: loopback, the
 * private IPv4 ranges, link-local, and IPv6 unique-local and link-local.
 * Shared address space (100.64/10, carrier and VPN overlays) is not.
 */
export function isPrivateAddress(address: string): boolean {
  if (isLoopbackAddress(address)) return true
  const v4 = ipv4Of(address)
  if (v4) {
    const [a, b] = v4.split('.').map(Number) as [number, number]
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  const v6 = address.toLowerCase().split('%')[0] ?? ''
  return /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6)
}

/** The order LAN addresses are offered in: home networks first. */
export function lanAddressRank(ip: string): number {
  return ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3
}

/**
 * Whether a request's Host header names this server (one of `names`, on its
 * port): a page elsewhere that points its own name at this computer (DNS
 * rebinding) never gets an answer.
 */
export function hostAllowed(host: string | undefined, port: number, names: readonly string[]): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  return names.some((n) => h === `${n.toLowerCase()}:${port}`)
}

/** Whether a socket's Origin is the server's own page (or absent: a program, not a page in a browser). */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    return new URL(origin).host.toLowerCase() === (host ?? '').trim().toLowerCase()
  } catch {
    return false
  }
}

// ---- paths ----

/**
 * The path below the server's base: with a token, everything sits under
 * `/<token>/`. `{ redirect }` for the base without its slash (so relative
 * addresses work), null for anything else (a wrong token, `..`, a backslash,
 * a control character).
 */
export function serverPath(pathname: string, token: string | null): { rel: string } | { redirect: string } | null {
  if (pathname.length > SERVER_LIMITS.pathChars || !pathname.startsWith('/')) return null
  let rest = pathname.slice(1)
  if (token) {
    if (rest === token) return { redirect: `/${token}/` }
    if (!rest.startsWith(`${token}/`)) return null
    rest = rest.slice(token.length + 1)
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return null
  }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return null
  const parts = decoded.split('/')
  if (parts.some((p) => p === '..' || p === '.')) return null
  if (parts.slice(0, -1).some((p) => p === '')) return null
  return { rel: decoded }
}

/** The file a static path asks for inside `root`: a folder (or the base) gets its index.html. */
export function staticFile(root: string, rel: string): string {
  const inner = rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel
  return `${root}/${inner}`
}

/** A request's query as plain strings: the first value of each name, within limits. */
export function queryOf(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of params) {
    if (Object.keys(out).length >= SERVER_LIMITS.queryKeys) break
    if (name.length > 100 || Object.hasOwn(out, name)) continue
    out[name] = value.slice(0, SERVER_LIMITS.queryChars)
  }
  return out
}

/** The request headers the app's page sees: what describes the request, never cookies or credentials. */
export const SERVER_REQUEST_HEADERS: readonly string[] = ['accept', 'accept-language', 'content-type', 'user-agent']

export function requestHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of SERVER_REQUEST_HEADERS) {
    const value = headers[name]
    if (typeof value === 'string') out[name] = value.slice(0, 1_000)
  }
  return out
}

/**
 * The response headers an app may set; Apex sets the rest (no CORS, so other
 * pages can't read the answers; no framing by other sites). A redirect stays
 * on this server.
 */
export const SERVER_RESPONSE_HEADER_PATTERN = /^(content-type|cache-control|content-language|content-disposition|etag|last-modified|location|x-[a-z0-9-]{1,40})$/

export function responseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [raw, value] of Object.entries(headers ?? {})) {
    const name = raw.toLowerCase()
    if (!SERVER_RESPONSE_HEADER_PATTERN.test(name) || /[\r\n\u0000]/.test(value)) continue
    // A relative address only: no scheme, nothing protocol-relative.
    if (name === 'location' && (/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[/\\]{2}/.test(value) || value.includes('\\'))) continue
    out[name] = value.slice(0, 2_000)
  }
  return out
}

/** The headers every answer gets, whatever the app says. */
export const SERVER_FIXED_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': "frame-ancestors 'self'",
}

// ---- rates ----

/** A token bucket: `take()` is false once the burst is spent faster than the rate refills it. */
export class RateBucket {
  readonly #rate: number
  readonly #burst: number
  readonly #now: () => number
  #tokens: number
  #at: number

  constructor(perSecond: number, burst: number, now: () => number = Date.now) {
    this.#rate = perSecond
    this.#burst = burst
    this.#now = now
    this.#tokens = burst
    this.#at = now()
  }

  take(): boolean {
    const at = this.#now()
    this.#tokens = Math.min(this.#burst, this.#tokens + ((at - this.#at) / 1000) * this.#rate)
    this.#at = at
    if (this.#tokens < 1) return false
    this.#tokens -= 1
    return true
  }
}
