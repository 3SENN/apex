/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// One app's web server (docs/packs.md › A web server of its own): Atelier owns
// the real sockets and the app's page only ever sees what passed the checks.
// Plain HTTP on 127.0.0.1, or HTTPS on every interface with Atelier's own
// certificate when the app may share on the Wi-Fi (phones give motion sensors
// only to secure pages). Every request and socket must come from this
// computer or a private network, name this server in its Host header (no DNS
// rebinding), carry the token in its path, and stay within the limits; files
// come from one folder of the pack, the rest goes to the page. No Electron
// here, so it is unit-tested.
import { randomBytes } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttps } from 'node:https'
import type { AddressInfo, Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  RateBucket,
  SERVER_CLIENT_PATH,
  SERVER_FIXED_HEADERS,
  SERVER_KIT_PATH,
  SERVER_LIMITS,
  SERVER_SOCKET_PATH,
  hostAllowed,
  isLoopbackAddress,
  isPrivateAddress,
  originAllowed,
  queryOf,
  requestHeaders,
  responseHeaders,
  serverPath,
  type ServerRequestInfo,
} from '@shared/localServer'
import { packContentType } from './sandbox'
import { SERVER_CLIENT_JS } from './serverClient'

/** A file to serve: its bytes, or where it is on disk (a large file of an installed pack). */
export type ServedFile = { data: Buffer } | { path: string }

/** What the app's page answers a request with, already checked by the bridge. */
export interface AppResponse {
  status?: number
  headers?: Record<string, string>
  body?: string | null
}

export interface LocalServerHooks {
  /** A request no file answered: the page's answer (the server times it out). */
  request(req: ServerRequestInfo): Promise<AppResponse>
  connection(id: string, info: { query: Record<string, string>; remote: 'local' | 'lan' }): void
  message(id: string, text: string): void
  close(id: string, code: number): void
  /** Something used the server (for the idle timer). */
  activity?(): void
}

export interface LocalServerOptions {
  /** On every interface with TLS (true), or 127.0.0.1 only. */
  lan: boolean
  /** The unguessable first part of every path, or null for none. */
  token: string | null
  /** The port to try first (then the next ten, then any); 0 for any. */
  port: number
  maxConnections: number
  /** Required with lan. */
  tls: { key: string; cert: string } | null
  /** A file under the served folder, by its path there (index.html for the base), or null. */
  file(rel: string): ServedFile | null
  /** A file of the Atelier kit (Atelier UI's ui.css and the rest), by its path under the kit, or null. */
  kitFile?(rel: string): string | null
  /** The names a Host header may carry, without the port: 127.0.0.1, localhost, the LAN addresses. */
  hostNames(): readonly string[]
  hooks: LocalServerHooks
  now?(): number
  /** How long the page has to answer (SERVER_LIMITS.requestTimeoutMs; tests shorten it). */
  requestTimeoutMs?: number
}

interface OpenSocket {
  ws: WebSocket
  bucket: RateBucket
  alive: boolean
  dropped: number
}

const HEARTBEAT_MS = 15_000
const TEXTUAL = /^(text\/[a-z0-9.+-]+|application\/(json|x-www-form-urlencoded|[a-z0-9.+-]+\+json))\s*(;|$)/i

export class LocalServer {
  readonly #opts: LocalServerOptions
  readonly #server: Server
  readonly #wss: WebSocketServer
  readonly #sockets = new Map<string, OpenSocket>()
  readonly #requests: RateBucket
  readonly #now: () => number
  #pending = 0
  #port = 0
  #heartbeat: ReturnType<typeof setInterval> | null = null
  #stopped = false

  constructor(opts: LocalServerOptions) {
    if (opts.lan && !opts.tls) throw new Error('A server on the Wi-Fi needs a certificate.')
    this.#opts = opts
    this.#now = opts.now ?? Date.now
    this.#requests = new RateBucket(SERVER_LIMITS.requestsPerSecond, SERVER_LIMITS.requestBurst, this.#now)
    const handle = (req: IncomingMessage, res: ServerResponse): void => void this.#handle(req, res).catch(() => this.#plain(res, 500, 'Server error'))
    this.#server = opts.lan && opts.tls ? createHttps({ key: opts.tls.key, cert: opts.tls.cert }, handle) : createHttp(handle)
    // Slow or stuck clients can't hold the server open.
    this.#server.headersTimeout = 10_000
    this.#server.requestTimeout = 20_000
    this.#server.keepAliveTimeout = 5_000
    this.#server.maxHeadersCount = 50
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: SERVER_LIMITS.inBytes, perMessageDeflate: false, clientTracking: false })
    this.#server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.#upgrade(req, socket, head))
    this.#server.on('clientError', (_err, socket: Duplex) => socket.destroy())
  }

  get port(): number {
    return this.#port
  }

  get connections(): number {
    return this.#sockets.size
  }

  /** Listens; resolves with the port it got. */
  async start(): Promise<number> {
    const host = this.#opts.lan ? '0.0.0.0' : '127.0.0.1'
    const preferred = this.#opts.port
    const candidates = preferred > 0 ? [...Array.from({ length: 11 }, (_, i) => preferred + i).filter((p) => p <= 65_535), 0] : [0]
    let lastError: unknown = null
    for (const port of candidates) {
      try {
        this.#port = await this.#listen(port, host)
        break
      } catch (err) {
        lastError = err
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err
      }
    }
    if (!this.#port) throw lastError instanceof Error ? lastError : new Error('No port was free.')
    this.#heartbeat = setInterval(() => this.#beat(), HEARTBEAT_MS)
    this.#heartbeat.unref?.()
    return this.#port
  }

  #listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error): void => {
        this.#server.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.#server.off('error', onError)
        resolve((this.#server.address() as AddressInfo).port)
      }
      this.#server.once('error', onError)
      this.#server.once('listening', onListening)
      this.#server.listen(port, host)
    })
  }

  /** Closes every socket (1001, going away) and the server. */
  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    for (const s of this.#sockets.values()) {
      try {
        s.ws.close(1001, 'The app stopped its server.')
      } catch {
        // Already gone.
      }
    }
    const closed = new Promise<void>((resolve) => (this.#server.listening ? this.#server.close(() => resolve()) : resolve()))
    this.#server.closeAllConnections()
    setTimeout(() => {
      for (const s of this.#sockets.values()) s.ws.terminate()
    }, 500).unref?.()
    await closed
  }

  /** Sends a text message to one socket; false when it's gone, too big or too far behind. */
  send(id: string, text: string): boolean {
    const s = this.#sockets.get(id)
    if (!s || s.ws.readyState !== 1) return false
    if (Buffer.byteLength(text) > SERVER_LIMITS.outBytes) return false
    if (s.ws.bufferedAmount > SERVER_LIMITS.bufferedBytes) return false
    s.ws.send(text)
    return true
  }

  socketIds(): string[] {
    return [...this.#sockets.keys()]
  }

  closeSocket(id: string, code = 1000): void {
    this.#sockets.get(id)?.ws.close(code)
  }

  // ---- checks ----

  #peerOk(address: string | undefined): boolean {
    if (!address) return false
    return this.#opts.lan ? isPrivateAddress(address) : isLoopbackAddress(address)
  }

  #hostOk(host: string | undefined): boolean {
    return hostAllowed(host, this.#port, this.#opts.hostNames())
  }

  #plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
    if (res.headersSent) return void res.end()
    res.writeHead(status, { ...SERVER_FIXED_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra })
    res.end(text)
  }

  // ---- HTTP ----

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#peerOk(req.socket.remoteAddress)) return void req.socket.destroy()
    if (!this.#hostOk(req.headers.host)) return this.#plain(res, 421, 'This server answers only its own address.')
    if (!this.#requests.take()) return this.#plain(res, 429, 'Too many requests.')
    this.#opts.hooks.activity?.()
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://server')
    } catch {
      return this.#plain(res, 400, 'Bad request.')
    }
    const at = serverPath(url.pathname, this.#opts.token)
    if (!at) return this.#plain(res, 404, 'Not found.')
    if ('redirect' in at) return this.#plain(res, 308, '', { location: `${at.redirect}${url.search}` })
    const rel = at.rel
    const method = (req.method ?? 'GET').toUpperCase()
    const reading = method === 'GET' || method === 'HEAD'

    if (rel === SERVER_CLIENT_PATH) return reading ? this.#send(res, method, 'text/javascript; charset=utf-8', Buffer.from(SERVER_CLIENT_JS)) : this.#plain(res, 405, 'Method not allowed.')
    if (rel === SERVER_SOCKET_PATH) return this.#plain(res, 426, 'Open a WebSocket here.', { upgrade: 'websocket' })
    if (rel.startsWith(SERVER_KIT_PATH)) {
      const full = reading ? this.#opts.kitFile?.(rel.slice(SERVER_KIT_PATH.length)) : null
      return full ? this.#sendFile(res, method, rel, { path: full }) : this.#plain(res, 404, 'Not found.')
    }
    if (rel.startsWith('__atelier/')) return this.#plain(res, 404, 'Not found.')
    if (reading) {
      const file = this.#opts.file(rel)
      if (file) return this.#sendFile(res, method, rel === '' || rel.endsWith('/') ? 'index.html' : rel, file)
    }
    return this.#dynamic(req, res, method, rel, url)
  }

  #send(res: ServerResponse, method: string, type: string, body: Buffer): void {
    res.writeHead(200, { ...SERVER_FIXED_HEADERS, 'content-type': type, 'cache-control': 'no-store', 'content-length': String(body.length) })
    res.end(method === 'HEAD' ? undefined : body)
  }

  #sendFile(res: ServerResponse, method: string, name: string, file: ServedFile): void {
    const type = packContentType(name)
    if ('data' in file) return this.#send(res, method, type, file.data)
    let size: number
    try {
      size = statSync(file.path).size
    } catch {
      return this.#plain(res, 404, 'Not found.')
    }
    res.writeHead(200, { ...SERVER_FIXED_HEADERS, 'content-type': type, 'cache-control': 'no-store', 'content-length': String(size) })
    if (method === 'HEAD') return void res.end()
    createReadStream(file.path)
      .on('error', () => res.destroy())
      .pipe(res)
  }

  async #dynamic(req: IncomingMessage, res: ServerResponse, method: string, rel: string, url: URL): Promise<void> {
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return this.#plain(res, 405, 'Method not allowed.')
    // Another site's page can send a request here without reading the answer; its Origin gives it away (CSRF).
    if (!originAllowed(typeof req.headers.origin === 'string' ? req.headers.origin : undefined, req.headers.host)) return this.#plain(res, 403, 'Requests from other sites are refused.')
    if (this.#pending >= SERVER_LIMITS.pendingRequests) return this.#plain(res, 503, 'The app is busy.')
    const type = String(req.headers['content-type'] ?? '')
    let body: string | null = null
    let json: unknown
    const hasBody = method !== 'GET' && method !== 'HEAD' && (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined)
    if (hasBody) {
      if (!TEXTUAL.test(type)) return this.#plain(res, 415, 'Send text or JSON.')
      const read = await readBody(req, SERVER_LIMITS.requestBodyBytes)
      if (read === null) return this.#plain(res, 413, 'The request is too large.')
      body = read
      if (/^application\/([a-z0-9.+-]+\+)?json/i.test(type)) {
        try {
          json = JSON.parse(body)
        } catch {
          return this.#plain(res, 400, 'The JSON is not valid.')
        }
      }
    }
    const info: ServerRequestInfo = { id: `r${randomBytes(6).toString('hex')}`, method, path: `/${rel}`, query: queryOf(url.searchParams), headers: requestHeaders(req.headers), body, ...(json !== undefined ? { json } : {}) }
    this.#pending++
    let answer: AppResponse
    try {
      answer = await withTimeout(this.#opts.hooks.request(info), this.#opts.requestTimeoutMs ?? SERVER_LIMITS.requestTimeoutMs)
    } catch (err) {
      return this.#plain(res, err instanceof TimeoutError ? 504 : 502, err instanceof TimeoutError ? 'The app did not answer in time.' : 'The app could not answer.')
    } finally {
      this.#pending--
    }
    const status = Number.isInteger(answer.status) && (answer.status as number) >= 200 && (answer.status as number) <= 599 ? (answer.status as number) : 200
    const text = answer.body ?? ''
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > SERVER_LIMITS.responseBytes) return this.#plain(res, 502, 'The app’s answer is too large.')
    const headers = responseHeaders(answer.headers)
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers, ...SERVER_FIXED_HEADERS, 'content-length': String(bytes.length) })
    res.end(method === 'HEAD' ? undefined : bytes)
  }

  // ---- WebSockets ----

  #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, text: string): void => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    const address = (socket as Socket).remoteAddress
    if (!this.#peerOk(address)) return void socket.destroy()
    if (!this.#hostOk(req.headers.host)) return refuse(421, 'Misdirected Request')
    if (!originAllowed(req.headers.origin, req.headers.host)) return refuse(403, 'Forbidden')
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://server')
    } catch {
      return refuse(400, 'Bad Request')
    }
    const at = serverPath(url.pathname, this.#opts.token)
    if (!at || 'redirect' in at || at.rel !== SERVER_SOCKET_PATH) return refuse(404, 'Not Found')
    if (this.#sockets.size >= this.#opts.maxConnections) return refuse(503, 'Service Unavailable')
    const query = queryOf(url.searchParams)
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, query, address ?? ''))
  }

  #accept(ws: WebSocket, query: Record<string, string>, address: string): void {
    if (this.#stopped) return void ws.terminate()
    const id = `s${randomBytes(6).toString('hex')}`
    const open: OpenSocket = { ws, bucket: new RateBucket(SERVER_LIMITS.messagesPerSecond, SERVER_LIMITS.messageBurst, this.#now), alive: true, dropped: 0 }
    this.#sockets.set(id, open)
    this.#opts.hooks.activity?.()
    this.#opts.hooks.connection(id, { query, remote: isLoopbackAddress(address) ? 'local' : 'lan' })
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return void ws.close(1003, 'Text messages only.')
      if (!open.bucket.take()) {
        // A burst is dropped; a socket that keeps flooding is closed.
        if (++open.dropped > SERVER_LIMITS.messageBurst * 4) ws.close(1008, 'Too many messages.')
        return
      }
      open.dropped = 0
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8')
      this.#opts.hooks.activity?.()
      this.#opts.hooks.message(id, text)
    })
    ws.on('pong', () => (open.alive = true))
    ws.on('error', () => undefined)
    ws.on('close', (code: number) => {
      if (!this.#sockets.delete(id)) return
      this.#opts.hooks.close(id, code)
    })
  }

  /** Sockets that didn't answer the last ping are dropped (a phone that left the Wi-Fi). */
  #beat(): void {
    for (const s of this.#sockets.values()) {
      if (!s.alive) {
        s.ws.terminate()
        continue
      }
      s.alive = false
      try {
        s.ws.ping()
      } catch {
        s.ws.terminate()
      }
    }
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError('timeout')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/** A request body as UTF-8 text, or null once it passes `max` bytes. */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > max) {
        done = true
        resolve(null)
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => {
      if (done) return
      done = true
      resolve(null)
    })
  })
}

/** A new unguessable token for a server's paths (22 characters, 128 bits). */
export function newServerToken(): string {
  return randomBytes(16).toString('base64url')
}
