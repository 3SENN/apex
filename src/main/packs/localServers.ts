/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier.server (docs/packs.md › A web server of its own): the servers apps
// run, one per app page that started one. A server lives only while that
// page does: it stops when the page closes, reloads or navigates, when the
// pack is turned off, when the app calls stop(), when the person presses Stop
// on Atelier's bar over the app, and after a while with nobody using it. What
// happens on it reaches the page as batches of events on the pack event
// channel, in order; requests and new sockets go at once, messages within a
// few milliseconds, so a phone streaming motion at 60 Hz doesn't flood IPC.
// The port is kept per app (a phone's bookmark keeps working) and the token
// per app while Atelier runs (so phones reconnect after the app reloads); the
// person's Stop throws the token away.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { PACK_IPC, safeRelativePath, type PackEventMessage } from '@shared/packs'
import { SERVER_EVENT_BATCH, SERVER_LIMITS, STOPPED_SERVER, isPrivateAddress, lanAddressRank, staticFile, type PackServerStatus, type ServerEvent, type ServerRequestInfo, type ServerStopReason } from '@shared/localServer'
import { qrDataUrl } from '@shared/qr'
import type { PackContext } from './bridge'
import { LocalServer, newServerToken, type AppResponse, type ServedFile } from './localServer'
import { localHostName, serverCertificate, type ServerCertificate } from './localServerCert'
import { markServing } from './serving'

/** What Atelier's bar over the app shows while its server runs. */
export interface ServerBarView {
  app: string
  lan: boolean
  connections: number
  /** The first time on the Wi-Fi on a Mac: macOS will ask about incoming connections. */
  hint: boolean
}

/** Atelier's own bar over an app whose server runs (trusted UI, not drawn by the app). */
export interface ServerIndicator {
  show(contents: WebContents, view: ServerBarView, onStop: () => void): void
  update(contents: WebContents, view: ServerBarView): void
  hide(contents: WebContents): void
}

export interface ServerStartOptions {
  lan?: boolean
  root?: string
  token?: boolean
  maxConnections?: number
}

export interface LocalServersDeps {
  /** Where the certificate and the kept ports live (Atelier's data folder). */
  dir: string
  /** A file of the pack (or the draft under test), or null. */
  file(packId: string, mode: PackContext['mode'], path: string): ServedFile | null
  /** Whether the pack has files under this folder. */
  hasFolder(packId: string, mode: PackContext['mode'], root: string): boolean
  kitFile?(rel: string): string | null
  indicator?: ServerIndicator
  log(ctx: Pick<PackContext, 'packId' | 'mode'>, level: 'info' | 'warn', message: string): void
  /** This computer's LAN addresses, best first (tests pass their own). */
  lanAddresses?(): string[]
  certificate?(ips: readonly string[]): Promise<ServerCertificate>
  platform?: NodeJS.Platform
  now?(): number
}

interface Running {
  key: string
  contents: WebContents
  packId: string
  appId: string
  appName: string
  mode: PackContext['mode']
  options: Required<Pick<ServerStartOptions, 'lan' | 'token' | 'maxConnections'>> & { root: string | null }
  server: LocalServer
  token: string | null
  lanIp: string | null
  queue: ServerEvent[]
  flushTimer: ReturnType<typeof setTimeout> | null
  pending: Map<string, (answer: AppResponse) => void>
  lastActive: number
  idleTimer: ReturnType<typeof setInterval>
  hint: boolean
  detach(): void
}

/** How long messages wait to travel together. */
const BATCH_MS = 8
const IDLE_CHECK_MS = 60_000

/** This computer's private IPv4 addresses on its networks, home networks first. */
export function lanAddresses(): string[] {
  const out = new Set<string>()
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && isPrivateAddress(a.address) && !a.address.startsWith('169.254.')) out.add(a.address)
  }
  return [...out].sort((a, b) => lanAddressRank(a) - lanAddressRank(b))
}

interface KeptState {
  ports: Record<string, number>
  hintSeen: boolean
}

export class LocalServers {
  readonly #deps: LocalServersDeps
  readonly #running = new Map<number, Running>()
  /** Tokens by app while Atelier runs. */
  readonly #tokens = new Map<string, string>()
  readonly #starting = new Map<number, Promise<unknown>>()
  readonly #now: () => number
  #addresses: { at: number; list: string[] } | null = null
  #lanOverride: (() => string[]) | null = null

  constructor(deps: LocalServersDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  // ---- what the bridge asks ----

  /** Starts one at a time per page, so two quick calls don't make two servers. */
  start(contents: WebContents, ctx: PackContext, app: { id: string; name: string }, asked: ServerStartOptions): Promise<PackServerStatus> {
    const before = this.#starting.get(contents.id) ?? Promise.resolve()
    const run = before.catch(() => undefined).then(() => this.#start(contents, ctx, app, asked))
    const settled = run.catch(() => undefined)
    this.#starting.set(contents.id, settled)
    void settled.then(() => {
      if (this.#starting.get(contents.id) === settled) this.#starting.delete(contents.id)
    })
    return run
  }

  async #start(contents: WebContents, ctx: PackContext, app: { id: string; name: string }, asked: ServerStartOptions): Promise<PackServerStatus> {
    const allowed = ctx.manifest.permissions.server
    if (!allowed) throw new Error('This pack has no server permission: add "server": {} to permissions (with "lan": true to share on the Wi-Fi).')
    const lan = asked.lan === true
    if (lan && !allowed.lan) throw new Error('This pack may only serve this computer: add "lan": true to permissions.server to share on the Wi-Fi.')
    if (lan && ctx.mode === 'test') throw new Error('In test_pack, a server runs on this computer only.')
    let root: string | null = null
    if (asked.root !== undefined) {
      root = safeRelativePath(asked.root)
      if (!root || root.startsWith('__atelier')) throw new Error(`${asked.root} is not a folder of the pack.`)
      if (!this.#deps.hasFolder(ctx.packId, ctx.mode, root)) throw new Error(`There is no folder ${root} in the pack.`)
    }
    const options = {
      lan,
      root,
      token: ctx.mode === 'test' ? true : asked.token !== false,
      maxConnections: Math.min(asked.maxConnections ?? SERVER_LIMITS.defaultConnections, ctx.mode === 'test' ? 4 : SERVER_LIMITS.connections),
    }
    const existing = this.#running.get(contents.id)
    if (existing) {
      const same = existing.packId === ctx.packId && JSON.stringify(existing.options) === JSON.stringify(options)
      if (same) return this.#status(existing)
      await this.#stop(existing, null)
    }

    const key = `${ctx.packId}/${app.id}`
    const ips = lan ? this.#lan() : []
    if (lan && ips.length === 0) throw new Error('This computer isn’t on a Wi-Fi or local network, so phones can’t reach it. Try again once it is, or start the server without lan.')
    const tls = lan ? await (this.#deps.certificate ?? ((list) => serverCertificate(this.#deps.dir, list)))(ips) : null
    if (contents.isDestroyed()) throw new Error('The page closed.')
    let token: string | null = null
    if (options.token) {
      token = this.#tokens.get(key) ?? newServerToken()
      this.#tokens.set(key, token)
    }
    const kept = this.#kept()
    const preferred = kept.ports[key] ?? this.#freshPort(kept)
    const record = {} as Running
    const server = new LocalServer({
      lan,
      token,
      port: preferred,
      maxConnections: options.maxConnections,
      tls,
      file: (rel) => (root ? this.#deps.file(ctx.packId, ctx.mode, staticFile(root, rel)) : null),
      kitFile: this.#deps.kitFile ? (rel) => this.#deps.kitFile?.(rel) ?? null : undefined,
      hostNames: () => ['127.0.0.1', 'localhost', '[::1]', ...(lan ? [...this.#lan(), ...(localHostName() ? [localHostName() as string] : [])] : [])],
      now: this.#now,
      hooks: {
        activity: () => (record.lastActive = this.#now()),
        request: (req) => this.#request(record, req),
        connection: (id, info) => {
          this.#push(record, { type: 'connection', id, query: info.query, remote: info.remote }, true)
          this.#showBar(record)
        },
        message: (id, data) => this.#push(record, { type: 'message', id, data }, false),
        close: (id, code) => {
          this.#push(record, { type: 'close', id, code }, true)
          this.#showBar(record)
        },
      },
    })
    const port = await server.start()
    if (contents.isDestroyed()) {
      await server.stop()
      throw new Error('The page closed.')
    }
    if (kept.ports[key] !== port) this.#keep({ ...kept, ports: { ...kept.ports, [key]: port } })
    const hint = lan && (this.#deps.platform ?? process.platform) === 'darwin' && !kept.hintSeen
    if (hint) this.#keep({ ...this.#kept(), hintSeen: true })

    const onGone = (): void => void this.stop(contents.id, 'closed')
    const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) void this.stop(contents.id, 'closed')
    }
    contents.once('destroyed', onGone)
    contents.on('did-start-navigation', onNavigation)
    contents.on('render-process-gone', onGone)
    Object.assign(record, {
      key,
      contents,
      packId: ctx.packId,
      appId: app.id,
      appName: app.name,
      mode: ctx.mode,
      options,
      server,
      token,
      lanIp: ips[0] ?? null,
      queue: [],
      flushTimer: null,
      pending: new Map(),
      lastActive: this.#now(),
      hint,
      idleTimer: setInterval(() => {
        if (server.connections === 0 && this.#now() - record.lastActive >= SERVER_LIMITS.idleMs) void this.stop(contents.id, 'idle')
      }, IDLE_CHECK_MS),
      detach: () => {
        if (contents.isDestroyed()) return
        contents.off('destroyed', onGone)
        contents.off('did-start-navigation', onNavigation)
        contents.off('render-process-gone', onGone)
      },
    } satisfies Running)
    record.idleTimer.unref?.()
    this.#running.set(contents.id, record)
    markServing(contents.id, true)
    this.#deps.log(ctx, 'info', `server started on port ${port}${lan ? ' (on the Wi-Fi)' : ''}${root ? `, serving ${root}` : ''}`)
    this.#deps.indicator?.show(contents, this.#barView(record), () => void this.stop(contents.id, 'person'))
    return this.#status(record)
  }

  status(contentsId: number): PackServerStatus {
    const r = this.#running.get(contentsId)
    return r ? this.#status(r) : { ...STOPPED_SERVER }
  }

  async stop(contentsId: number, reason: ServerStopReason): Promise<void> {
    const r = this.#running.get(contentsId)
    if (r) await this.#stop(r, reason)
  }

  /** The page's answer to a request it was sent. */
  respond(contentsId: number, requestId: string, answer: AppResponse): void {
    const r = this.#running.get(contentsId)
    const settle = r?.pending.get(requestId)
    if (!r || !settle) throw new Error('That request is no longer waiting for an answer.')
    r.pending.delete(requestId)
    settle(answer)
  }

  /** Sends text to sockets ('*' for all of them); how many it went to. */
  send(contentsId: number, ids: readonly string[] | '*', text: string): number {
    const r = this.#running.get(contentsId)
    if (!r) throw new Error('The server is not running: call atelier.server.start() first.')
    if (Buffer.byteLength(text) > SERVER_LIMITS.outBytes) throw new Error(`A message is at most ${SERVER_LIMITS.outBytes / 1024} KB.`)
    const to = ids === '*' ? r.server.socketIds() : ids
    let sent = 0
    for (const id of to) if (r.server.send(id, text)) sent++
    return sent
  }

  close(contentsId: number, id: string, code: number): void {
    this.#running.get(contentsId)?.server.closeSocket(id, code)
  }

  /** Stops the servers of packs that may no longer run them (turned off, removed, a draft no longer under test, an update without the permission). */
  async stopWhere(gone: (packId: string, mode: PackContext['mode'], lan: boolean) => boolean): Promise<void> {
    await Promise.all([...this.#running.values()].filter((r) => gone(r.packId, r.mode, r.options.lan)).map((r) => this.#stop(r, 'closed')))
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#running.values()].map((r) => this.#stop(r, 'closed')))
  }

  /** Smoke runs stay on this machine: their "LAN" is 127.0.0.1 (the server still listens on every interface, over TLS). */
  useLanAddresses(list: (() => string[]) | null): void {
    this.#lanOverride = list
    this.#addresses = null
  }

  /** What runs, for smoke checks and the pack's page. */
  list(): Array<{ contentsId: number; packId: string; appId: string; port: number; lan: boolean; connections: number }> {
    return [...this.#running.values()].map((r) => ({ contentsId: r.contents.id, packId: r.packId, appId: r.appId, port: r.server.port, lan: r.options.lan, connections: r.server.connections }))
  }

  // ---- inside ----

  async #stop(r: Running, reason: ServerStopReason | null): Promise<void> {
    if (this.#running.get(r.contents.id) !== r) return
    this.#running.delete(r.contents.id)
    markServing(r.contents.id, false)
    clearInterval(r.idleTimer)
    r.detach()
    for (const settle of r.pending.values()) settle({ status: 503, body: 'The server stopped.' })
    r.pending.clear()
    if (reason === 'person') this.#tokens.delete(r.key)
    this.#deps.indicator?.hide(r.contents)
    if (reason) this.#push(r, { type: 'stopped', reason }, true)
    if (r.flushTimer) clearTimeout(r.flushTimer)
    await r.server.stop()
    this.#deps.log({ packId: r.packId, mode: r.mode }, 'info', `server stopped (${reason ?? 'restarted'})`)
  }

  #status(r: Running): PackServerStatus {
    const path = r.token ? `/${r.token}/` : '/'
    const port = r.server.port
    const lanUrl = r.options.lan && r.lanIp ? `https://${r.lanIp}:${port}${path}` : null
    return {
      running: true,
      url: r.options.lan ? `https://localhost:${port}${path}` : `http://127.0.0.1:${port}${path}`,
      lanUrl,
      port,
      qr: lanUrl ? qrDataUrl(lanUrl) : null,
      lan: r.options.lan,
      token: r.token !== null,
      connections: r.server.connections,
    }
  }

  #barView(r: Running): ServerBarView {
    return { app: r.appName, lan: r.options.lan, connections: r.server.connections, hint: r.hint }
  }

  #showBar(r: Running): void {
    if (this.#running.get(r.contents.id) === r) this.#deps.indicator?.update(r.contents, this.#barView(r))
  }

  #request(r: Running, req: ServerRequestInfo): Promise<AppResponse> {
    return new Promise((resolve) => {
      r.pending.set(req.id, resolve)
      this.#push(r, { type: 'request', ...req }, true)
      // The server times the request out; forget it then too.
      setTimeout(() => r.pending.delete(req.id), SERVER_LIMITS.requestTimeoutMs + 1_000).unref?.()
    })
  }

  /** Queues an event for the page; urgent ones go now, with everything queued before them. */
  #push(r: Running, event: ServerEvent, urgent: boolean): void {
    r.queue.push(event)
    if (urgent) return this.#flush(r)
    if (!r.flushTimer) r.flushTimer = setTimeout(() => this.#flush(r), BATCH_MS)
  }

  #flush(r: Running): void {
    if (r.flushTimer) clearTimeout(r.flushTimer)
    r.flushTimer = null
    if (r.queue.length === 0) return
    const events = r.queue.splice(0)
    if (r.contents.isDestroyed()) return
    const message: PackEventMessage = { name: SERVER_EVENT_BATCH, data: events }
    r.contents.send(PACK_IPC.event, message)
  }

  #lan(): string[] {
    const at = this.#now()
    if (!this.#addresses || at - this.#addresses.at > 5_000) this.#addresses = { at, list: (this.#lanOverride ?? this.#deps.lanAddresses ?? lanAddresses)() }
    return this.#addresses.list
  }

  #stateFile(): string {
    return join(this.#deps.dir, 'state.json')
  }

  #kept(): KeptState {
    try {
      if (existsSync(this.#stateFile())) {
        const raw = JSON.parse(readFileSync(this.#stateFile(), 'utf8')) as Partial<KeptState>
        const ports: Record<string, number> = {}
        for (const [k, v] of Object.entries(raw.ports ?? {})) if (Number.isInteger(v) && v > 1024 && v < 65_536) ports[k] = v
        return { ports, hintSeen: raw.hintSeen === true }
      }
    } catch {
      // A broken file starts over.
    }
    return { ports: {}, hintSeen: false }
  }

  #keep(state: KeptState): void {
    try {
      mkdirSync(this.#deps.dir, { recursive: true })
      writeFileSync(this.#stateFile(), JSON.stringify(state))
    } catch {
      // Ports and the hint are conveniences.
    }
  }

  /** A port for an app's first server: high, unlikely to be taken, and none another app keeps. */
  #freshPort(kept: KeptState): number {
    const taken = new Set(Object.values(kept.ports))
    for (;;) {
      const port = 42_000 + Math.floor(Math.random() * 7_000)
      if (!taken.has(port)) return port
    }
  }
}
