/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false, getAppPath: () => tmpdir(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: vi.fn(), on: vi.fn(), off: vi.fn(), removeHandler: vi.fn() },
  session: { fromPartition: () => ({}) },
}))

import WebSocket from 'ws'
import type { WebContents } from 'electron'
import { format } from '@shared/i18n/core'
import { EN } from '@shared/i18n/en'
import { NL } from '@shared/i18n/nl'
import {
  RateBucket,
  SERVER_EVENT_BATCH,
  hostAllowed,
  isPrivateAddress,
  originAllowed,
  queryOf,
  requestHeaders,
  responseHeaders,
  serverPath,
  staticFile,
  type ServerEvent,
} from '@shared/localServer'
import { NO_PACK_PERMISSIONS, PACK_IPC, PACK_MANIFEST_FILE, describePackPermissions, permissionDiff, type PackManifest } from '@shared/packs'
import { createBridge, type BridgeDeps, type PackContext } from '../src/main/packs/bridge'
import { LocalServer, newServerToken, type LocalServerOptions } from '../src/main/packs/localServer'
import { certificateCovers, makeServerCertificate, serverCertificate, type ServerCertificate } from '../src/main/packs/localServerCert'
import { LocalServers, type ServerBarView } from '../src/main/packs/localServers'
import { validatePack, type PackFiles } from '../src/main/packs/manifest'
import { ceilingProblems } from '../src/main/packs/policy'
import { SERVER_CLIENT_JS } from '../src/main/packs/serverClient'
import { starterFiles } from '../src/main/packs/starters'

// apex.server (docs/packs.md › A web server of its own): the manifest's
// permission and its review lines, the bridge's checks, the server's checks
// on every request and socket (peers, Host, token, paths, limits), TLS with
// Apex's own certificate, and the servers living and dying with their page.

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'apex-local-server-'))
  dirs.push(d)
  return d
}
const servers: Array<{ stop(): Promise<void> }> = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const appManifest = (server: PackManifest['permissions']['server'], over: Partial<PackManifest> = {}): PackManifest => ({
  format: 'apex-pack',
  manifestVersion: 2,
  id: 'pads',
  name: 'Pads',
  version: '1.0.0',
  description: 'Phones as pads.',
  contributes: { apps: [{ id: 'main', name: 'Pads', root: 'app', entry: 'index.html', build: 'kit', kind: 'game' }] },
  permissions: { ...NO_PACK_PERMISSIONS, ...(server ? { server } : {}) },
  ...over,
})
const files = (m: PackManifest, extra: Record<string, string> = {}): PackFiles =>
  new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(m))], ['app/index.html', Buffer.from('<!doctype html><title>x</title>')], ...Object.entries(extra).map(([p, t]) => [p, Buffer.from(t)] as [string, Buffer])])

describe('the checks every request passes', () => {
  it('lets in this computer and private networks only', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.5', '172.20.1.1', '169.254.3.3', 'fd12:3456::1', 'fe80::1']) expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '100.64.1.1', '::ffff:1.1.1.1', '2001:db8::1', '']) expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it('answers only its own names (no DNS rebinding) and its own pages’ sockets', () => {
    expect(hostAllowed('127.0.0.1:4100', 4100, ['127.0.0.1', 'localhost'])).toBe(true)
    expect(hostAllowed('LOCALHOST:4100', 4100, ['127.0.0.1', 'localhost'])).toBe(true)
    expect(hostAllowed('evil.example:4100', 4100, ['127.0.0.1', 'localhost'])).toBe(false)
    expect(hostAllowed('127.0.0.1:4101', 4100, ['127.0.0.1'])).toBe(false)
    expect(hostAllowed(undefined, 4100, ['127.0.0.1'])).toBe(false)
    expect(originAllowed(undefined, '192.168.1.2:4100')).toBe(true)
    expect(originAllowed('https://192.168.1.2:4100', '192.168.1.2:4100')).toBe(true)
    expect(originAllowed('https://evil.example', '192.168.1.2:4100')).toBe(false)
    expect(originAllowed('null', '192.168.1.2:4100')).toBe(false)
  })

  it('needs the token first in the path and refuses ways out of the folder', () => {
    const token = newServerToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(serverPath(`/${token}/phone.js`, token)).toEqual({ rel: 'phone.js' })
    expect(serverPath(`/${token}/`, token)).toEqual({ rel: '' })
    expect(serverPath(`/${token}`, token)).toEqual({ redirect: `/${token}/` })
    expect(serverPath('/phone.js', token)).toBeNull()
    expect(serverPath(`/${token.slice(0, -1)}x/phone.js`, token)).toBeNull()
    expect(serverPath('/phone.js', null)).toEqual({ rel: 'phone.js' })
    for (const bad of ['/../secret', '/a/../../b', '/a%2F..%2F..%2Fb', '/a\\b', '/a%00b', '/a//b', '/./a']) expect(serverPath(bad, null), bad).toBeNull()
    expect(staticFile('phone', '')).toBe('phone/index.html')
    expect(staticFile('phone', 'img/')).toBe('phone/img/index.html')
    expect(staticFile('phone', 'a.css')).toBe('phone/a.css')
  })

  it('passes on only safe headers, a short query, and answers that stay on the server', () => {
    expect(requestHeaders({ cookie: 'x', authorization: 'y', accept: 'text/html', 'user-agent': 'Phone' })).toEqual({ accept: 'text/html', 'user-agent': 'Phone' })
    const q = queryOf(new URLSearchParams(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'v'.repeat(900)])))
    expect(Object.keys(q)).toHaveLength(20)
    expect(q.k0).toHaveLength(500)
    expect(responseHeaders({ 'Content-Type': 'text/html', 'Set-Cookie': 'a=b', 'Access-Control-Allow-Origin': '*', Location: '/next', 'X-Score': '3' })).toEqual({ 'content-type': 'text/html', location: '/next', 'x-score': '3' })
    expect(responseHeaders({ location: 'https://evil.example/' })).toEqual({})
    expect(responseHeaders({ location: '//evil.example/' })).toEqual({})
    expect(responseHeaders({ 'x-a': 'one\r\nset-cookie: b' })).toEqual({})
  })

  it('limits rates with a bucket that refills', () => {
    let now = 0
    const bucket = new RateBucket(10, 3, () => now)
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false])
    now += 100
    expect(bucket.take()).toBe(true)
    expect(bucket.take()).toBe(false)
  })
})

describe('the permission', () => {
  it('validates, needs an app, and reads as plain lines in English and Dutch', () => {
    const local = appManifest({})
    const lan = appManifest({ lan: true })
    expect(validatePack(files(local)).ok).toBe(true)
    expect(validatePack(files(lan)).ok).toBe(true)
    const odd = validatePack(files({ ...lan, permissions: { ...lan.permissions, server: { lan: true, port: 80 } as never } }))
    expect(odd.ok).toBe(false)
    const noApp = validatePack(files({ ...local, contributes: { skills: [] } }))
    expect(noApp.ok ? [] : noApp.problems.join(' ')).toMatch(/permissions\.server: only an app/)

    const localLine = describePackPermissions(local).find((l) => l.kind === 'server')
    const lanLine = describePackPermissions(lan).find((l) => l.kind === 'server')
    expect(localLine).toMatchObject({ key: 'packs.perm.server', level: 'notice' })
    expect(lanLine).toMatchObject({ key: 'packs.perm.serverLan', level: 'warning' })
    expect(format(EN[localLine!.key])).toBe('Can run a small web server on this computer')
    expect(format(EN[lanLine!.key])).toBe('Can run a small web server that phones and computers on your Wi-Fi can open')
    expect(format(NL[localLine!.key] ?? "")).toBe('Kan een kleine webserver op deze computer draaien')
    expect(format(NL[lanLine!.key] ?? "")).toBe('Kan een kleine webserver draaien die telefoons en computers op je wifi kunnen openen')
    expect(describePackPermissions(appManifest(undefined)).some((l) => l.kind === 'server')).toBe(false)
  })

  it('asks again when an update adds the Wi-Fi, and an organisation can forbid either', () => {
    expect(permissionDiff(appManifest({}), appManifest({ lan: true })).map((l) => l.key)).toEqual(['packs.perm.serverLan'])
    expect(permissionDiff(appManifest({ lan: true }), appManifest({}))).toEqual([])
    expect(permissionDiff(appManifest(undefined), appManifest({})).map((l) => l.key)).toEqual(['packs.perm.server'])
    expect(ceilingProblems({ server: false }, appManifest({}))).toHaveLength(1)
    expect(ceilingProblems({ serverLan: false }, appManifest({}))).toEqual([])
    expect(ceilingProblems({ serverLan: false }, appManifest({ lan: true }))).toHaveLength(1)
  })
})

describe('the bridge', () => {
  function bridgeWith(server: BridgeDeps['plugin']['server']) {
    const deps = {
      contextOf: () => null,
      targetFor: () => null,
      isToolHost: () => false,
      storage: { read: () => ({}), write: () => undefined },
      log: () => undefined,
      notify: vi.fn(),
      ask: vi.fn(),
      copy: vi.fn(),
      open: vi.fn(),
      installedGrants: () => null,
      plugin: { call: vi.fn(), provide: vi.fn(), emit: vi.fn(), listen: vi.fn(), status: vi.fn(), request: vi.fn(), assets: vi.fn(), files: vi.fn(), schedule: vi.fn(), cast: vi.fn(), testState: vi.fn(), ai: { text: vi.fn(), json: vi.fn(), stream: vi.fn(), turn: vi.fn() }, server },
    } as unknown as BridgeDeps
    return createBridge(deps)
  }
  const ctx = (m: PackManifest): PackContext => ({ packId: m.id, mode: 'installed', manifest: m })
  const page = {} as WebContents

  it('refuses a pack without the permission, the Wi-Fi without lan, and arguments it doesn’t know', async () => {
    const server = vi.fn(async () => ({ running: true }))
    const bridge = bridgeWith(server)
    await expect(bridge.run(page, ctx(appManifest(undefined)), 'server.start', [{}])).rejects.toThrow(/no server permission/)
    await expect(bridge.run(page, ctx(appManifest({})), 'server.start', [{ lan: true }])).rejects.toThrow(/only serve this computer/)
    await expect(bridge.run(page, ctx(appManifest({})), 'server.start', [{ port: 80 }])).rejects.toThrow(/arguments are wrong/)
    await expect(bridge.run(page, ctx(appManifest({})), 'server.start', [{ maxConnections: 99 }])).rejects.toThrow(/arguments are wrong/)
    await expect(bridge.run(page, ctx(appManifest({})), 'server.send', [['../x'], 'hi'])).rejects.toThrow(/arguments are wrong/)
    await expect(bridge.run(page, ctx(appManifest({})), 'server.respond', ['r000000000000', { status: 101 }])).rejects.toThrow(/arguments are wrong/)
    await expect(bridge.run(page, ctx(appManifest({})), 'server.close', ['s000000000000', 1006])).rejects.toThrow(/arguments are wrong/)
    expect(server).not.toHaveBeenCalled()
    await expect(bridge.run(page, ctx(appManifest({ lan: true })), 'server.start', [{ lan: true, root: 'phone' }])).resolves.toEqual({ running: true })
    await bridge.run(page, ctx(appManifest({})), 'server.send', ['*', 'hello'])
    expect(server).toHaveBeenCalledTimes(2)
  })
})

// ---- the server itself ----

type Hooks = LocalServerOptions['hooks']
function serve(over: Partial<LocalServerOptions> = {}, hooks: Partial<Hooks> = {}): LocalServer & { events: string[] } {
  const events: string[] = []
  const server = new LocalServer({
    lan: false,
    token: null,
    port: 0,
    maxConnections: 4,
    tls: null,
    file: (rel) => (rel === '' || rel === 'index.html' ? { data: Buffer.from('<h1>pad</h1>') } : rel === 'pad.js' ? { data: Buffer.from('export {}') } : null),
    hostNames: () => ['127.0.0.1', 'localhost'],
    hooks: {
      request: async (req) => ({ status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'no' }, body: JSON.stringify({ path: req.path, query: req.query, json: req.json ?? null, method: req.method }) }),
      connection: (id, info) => events.push(`join ${id} ${JSON.stringify(info.query)} ${info.remote}`),
      message: (id, text) => events.push(`message ${id} ${text}`),
      close: (id, code) => events.push(`close ${id} ${code}`),
      ...hooks,
    },
    ...over,
  }) as LocalServer & { events: string[] }
  server.events = events
  servers.push(server)
  return server
}

function raw(port: number, path: string, headers: Record<string, string> = {}, tls = false): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = (tls ? httpsRequest : httpRequest)({ host: '127.0.0.1', port, path, headers, rejectUnauthorized: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function open(url: string, options: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { rejectUnauthorized: false, ...options })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)))
  })
}

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('the server', () => {
  it('serves its folder’s files and sends the rest to the page, with Apex’s headers', async () => {
    const server = serve()
    const port = await server.start()
    const base = `http://127.0.0.1:${port}`
    const page = await fetch(`${base}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toMatch(/text\/html/)
    expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    expect(page.headers.get('access-control-allow-origin')).toBeNull()
    expect(await page.text()).toBe('<h1>pad</h1>')
    expect((await fetch(`${base}/pad.js`)).headers.get('content-type')).toMatch(/javascript/)
    const dynamic = await fetch(`${base}/api/score?team=red`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"points":3}' })
    expect(dynamic.status).toBe(200)
    expect(dynamic.headers.get('set-cookie')).toBeNull()
    expect(await dynamic.json()).toEqual({ path: '/api/score', query: { team: 'red' }, json: { points: 3 }, method: 'POST' })
    expect((await fetch(`${base}/api`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'x' })).status).toBe(415)
    expect((await fetch(`${base}/api`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(70_000) })).status).toBe(413)
    expect((await fetch(`${base}/api`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })).status).toBe(400)
    // Another site's page can't make the app act (its Origin gives it away); the server's own pages can.
    expect((await fetch(`${base}/api`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.example' }, body: 'x' })).status).toBe(403)
    expect((await fetch(`${base}/api`, { method: 'POST', headers: { 'content-type': 'text/plain', origin: base }, body: 'x' })).status).toBe(200)
    const client = await fetch(`${base}/__apex/client.js`)
    expect(client.headers.get('content-type')).toMatch(/javascript/)
    expect(await client.text()).toBe(SERVER_CLIENT_JS)
    expect((await fetch(`${base}/__apex/other`)).status).toBe(404)
  })

  it('answers a page that is too slow with 504, and only its own Host', async () => {
    const slow = serve({ requestTimeoutMs: 150 }, { request: () => new Promise(() => undefined) })
    const slowPort = await slow.start()
    expect((await fetch(`http://127.0.0.1:${slowPort}/slow`)).status).toBe(504)
    const server = serve()
    const port = await server.start()
    expect((await raw(port, '/', { host: `rebound.example:${port}` })).status).toBe(421)
    expect((await raw(port, '/', { host: `localhost:${port}` })).status).toBe(200)
  })

  it('needs the token: a wrong one is not found, the bare base moves to its slash', async () => {
    const token = newServerToken()
    const server = serve({ token })
    const port = await server.start()
    expect((await fetch(`http://127.0.0.1:${port}/${token}/`)).status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404)
    expect((await fetch(`http://127.0.0.1:${port}/${newServerToken()}/`)).status).toBe(404)
    const bare = await fetch(`http://127.0.0.1:${port}/${token}?a=1`, { redirect: 'manual' })
    expect(bare.status).toBe(308)
    expect(bare.headers.get('location')).toBe(`/${token}/?a=1`)
    await expect(open(`ws://127.0.0.1:${port}/__apex/socket`)).rejects.toThrow(/refused 404/)
    const ws = await open(`ws://127.0.0.1:${port}/${token}/__apex/socket?name=Sam`)
    ws.close()
  })

  it('relays sockets both ways, text only, within the limits', async () => {
    const server = serve({ maxConnections: 2 })
    const port = await server.start()
    const url = `ws://127.0.0.1:${port}/__apex/socket`
    const a = await open(`${url}?name=Ann`)
    await until(() => server.events.length === 1)
    const id = server.socketIds()[0] as string
    expect(server.events[0]).toBe(`join ${id} {"name":"Ann"} local`)
    a.send('{"t":"m","x":1}')
    a.send('second')
    await until(() => server.events.length === 3)
    expect(server.events.slice(1)).toEqual([`message ${id} {"t":"m","x":1}`, `message ${id} second`])
    const got = new Promise<string>((resolve) => a.once('message', (d) => resolve(String(d))))
    expect(server.send(id, 'buzz')).toBe(true)
    expect(await got).toBe('buzz')
    expect(server.send(id, 'x'.repeat(70_000))).toBe(false)
    // Another page's socket, a third socket and a binary message are refused.
    await expect(open(url, { origin: 'https://evil.example' })).rejects.toThrow(/refused 403/)
    const b = await open(url)
    await expect(open(url)).rejects.toThrow(/refused 503/)
    const closed = new Promise<number>((resolve) => b.once('close', (code) => resolve(code)))
    b.send(Buffer.from([1, 2, 3]), { binary: true })
    expect(await closed).toBe(1003)
    // Too big is closed by the server (1009).
    const big = new Promise<number>((resolve) => a.once('close', (code) => resolve(code)))
    a.send('x'.repeat(17_000))
    expect(await big).toBe(1009)
    await until(() => server.connections === 0)
    expect(server.events.filter((e) => e.startsWith('close'))).toHaveLength(2)
  })

  it('drops a flood of messages and stops cleanly, closing its sockets', async () => {
    const server = serve()
    const port = await server.start()
    const ws = await open(`ws://127.0.0.1:${port}/__apex/socket`)
    for (let i = 0; i < 600; i++) ws.send(String(i))
    await new Promise((r) => setTimeout(r, 300))
    const messages = server.events.filter((e) => e.startsWith('message')).length
    expect(messages).toBeGreaterThanOrEqual(240)
    expect(messages).toBeLessThan(600)
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)))
    await server.stop()
    expect(await closed).toBe(1001)
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
  })

  it('keeps to 127.0.0.1 unless it is on the Wi-Fi', async () => {
    const server = serve()
    await server.start()
    // The listening address is the loopback one: reaching it by a LAN address fails.
    const { networkInterfaces } = await import('node:os')
    const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address
    if (lan) await expect(fetch(`http://${lan}:${server.port}/`)).rejects.toThrow()
    expect(() => new LocalServer({ lan: true, token: null, port: 0, maxConnections: 1, tls: null, file: () => null, hostNames: () => [], hooks: { request: async () => ({}), connection: () => undefined, message: () => undefined, close: () => undefined } })).toThrow(/certificate/)
  })
})

describe('on the Wi-Fi: https with Apex’s certificate', () => {
  let cert: ServerCertificate
  beforeAll(async () => {
    cert = await makeServerCertificate(['192.168.1.20'])
  }, 30_000)

  it('makes a self-signed server certificate that names the addresses', () => {
    const x = new X509Certificate(cert.cert)
    expect(x.verify(x.publicKey)).toBe(true)
    expect(x.checkIP('192.168.1.20')).toBe('192.168.1.20')
    expect(x.checkIP('127.0.0.1')).toBe('127.0.0.1')
    expect(x.checkHost('localhost')).toBe('localhost')
    expect(x.keyUsage).toContain('1.3.6.1.5.5.7.3.1')
    expect(x.ca).toBe(false)
    expect(certificateCovers(cert.cert, ['192.168.1.20'])).toBe(true)
    expect(certificateCovers(cert.cert, ['10.0.0.9'])).toBe(false)
    expect(certificateCovers(cert.cert, ['192.168.1.20'], Date.now() + 340 * 24 * 60 * 60_000)).toBe(false)
  })

  it('keeps one per install and adds a new address to the ones before', async () => {
    const dir = tmp()
    const first = await serverCertificate(dir, ['192.168.1.20'])
    expect(await serverCertificate(dir, ['192.168.1.20'])).toEqual(first)
    const moved = await serverCertificate(dir, ['10.0.0.9'])
    expect(moved.cert).not.toBe(first.cert)
    expect(certificateCovers(moved.cert, ['10.0.0.9', '192.168.1.20'])).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'addresses.json'), 'utf8'))).toEqual(['10.0.0.9', '192.168.1.20'])
  }, 30_000)

  it('serves files and sockets over TLS', async () => {
    const server = serve({ lan: true, tls: cert, token: 'abcdefghijklmnopqrstuv' })
    const port = await server.start()
    const page = await raw(port, '/abcdefghijklmnopqrstuv/', { host: `127.0.0.1:${port}` }, true)
    expect(page.status).toBe(200)
    expect(page.body).toBe('<h1>pad</h1>')
    const ws = await open(`wss://127.0.0.1:${port}/abcdefghijklmnopqrstuv/__apex/socket`)
    await until(() => server.events.length === 1)
    ws.close()
    await expect(raw(port, '/abcdefghijklmnopqrstuv/', {}, false)).rejects.toThrow()
  })
})

// ---- the servers apps run ----

class FakePage extends EventEmitter {
  static next = 1
  readonly id = FakePage.next++
  destroyed = false
  sent: ServerEvent[] = []
  isDestroyed(): boolean {
    return this.destroyed
  }
  send(channel: string, message: { name: string; data: ServerEvent[] }): void {
    if (channel === PACK_IPC.event && message.name === SERVER_EVENT_BATCH) this.sent.push(...message.data)
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

function manager(over: { dir?: string } = {}) {
  const bar: Array<[string, ServerBarView | null]> = []
  let onStop: (() => void) | null = null
  const servers = new LocalServers({
    dir: over.dir ?? tmp(),
    file: (_p, _m, path) => (path === 'phone/index.html' ? { data: Buffer.from('<p>phone</p>') } : null),
    hasFolder: (_p, _m, root) => root === 'phone',
    log: () => undefined,
    lanAddresses: () => ['127.0.0.1'],
    certificate: async () => ({ key: '', cert: '' }),
    platform: 'darwin',
    indicator: {
      show: (_c, view, stop) => {
        bar.push(['show', view])
        onStop = stop
      },
      update: (_c, view) => bar.push(['update', view]),
      hide: () => bar.push(['hide', null]),
    },
  })
  return { servers, bar, pressStop: () => onStop?.() }
}
const ctxOf = (m: PackManifest, mode: PackContext['mode'] = 'installed'): PackContext => ({ packId: m.id, mode, manifest: m })
const APP = { id: 'main', name: 'Pads' }

describe('the servers apps run', () => {
  it('starts on this computer, serves the folder, and relays a request and a socket to the page in order', async () => {
    const { servers, bar } = manager()
    const page = new FakePage()
    const status = await servers.start(page as unknown as WebContents, ctxOf(appManifest({})), APP, { root: 'phone' })
    expect(status).toMatchObject({ running: true, lan: false, lanUrl: null, qr: null, token: true, connections: 0 })
    expect(status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/)
    expect(await (await fetch(status.url as string)).text()).toBe('<p>phone</p>')
    expect(bar[0]).toEqual(['show', { app: 'Pads', lan: false, connections: 0, hint: false }])

    const answer = fetch(`${status.url}api/hi?x=1`)
    await until(() => page.sent.some((e) => e.type === 'request'))
    const req = page.sent.find((e) => e.type === 'request') as Extract<ServerEvent, { type: 'request' }>
    expect(req).toMatchObject({ method: 'GET', path: '/api/hi', query: { x: '1' } })
    servers.respond(page.id, req.id, { status: 201, body: 'hello' })
    const res = await answer
    expect([res.status, await res.text()]).toEqual([201, 'hello'])
    expect(() => servers.respond(page.id, req.id, {})).toThrow(/no longer waiting/)

    const ws = await open(`${(status.url as string).replace('http', 'ws')}__apex/socket?name=Sam`)
    for (let i = 0; i < 5; i++) ws.send(`{"n":${i}}`)
    await until(() => page.sent.filter((e) => e.type === 'message').length === 5)
    const join = page.sent.find((e) => e.type === 'connection') as Extract<ServerEvent, { type: 'connection' }>
    expect(join.query).toEqual({ name: 'Sam' })
    expect(page.sent.filter((e) => e.type === 'message').map((e) => (e as { data: string }).data)).toEqual([0, 1, 2, 3, 4].map((n) => `{"n":${n}}`))
    expect(bar.some(([kind, view]) => kind === 'update' && view?.connections === 1)).toBe(true)
    const back = new Promise<string>((resolve) => ws.once('message', (d) => resolve(String(d))))
    expect(servers.send(page.id, '*', 'buzz')).toBe(1)
    expect(await back).toBe('buzz')
    ws.close()
    await until(() => page.sent.some((e) => e.type === 'close'))
    expect(page.sent.map((e) => e.type)).toEqual(['request', 'connection', 'message', 'message', 'message', 'message', 'message', 'close'])

    // The page closes: the server goes with it.
    page.destroy()
    await until(() => servers.list().length === 0)
    expect(bar.at(-1)).toEqual(['hide', null])
    await expect(fetch(status.url as string)).rejects.toThrow()
  })

  it('refuses what the manifest doesn’t allow, a folder that isn’t there, and the Wi-Fi in a test', async () => {
    const { servers } = manager()
    const page = new FakePage() as unknown as WebContents
    await expect(servers.start(page, ctxOf(appManifest(undefined)), APP, {})).rejects.toThrow(/no server permission/)
    await expect(servers.start(page, ctxOf(appManifest({})), APP, { lan: true })).rejects.toThrow(/only serve this computer/)
    await expect(servers.start(page, ctxOf(appManifest({ lan: true }), 'test'), APP, { lan: true })).rejects.toThrow(/test_pack/)
    await expect(servers.start(page, ctxOf(appManifest({})), APP, { root: 'nowhere' })).rejects.toThrow(/no folder nowhere/)
    await expect(servers.start(page, ctxOf(appManifest({})), APP, { root: '../up' })).rejects.toThrow(/not a folder/)
    expect(servers.list()).toEqual([])
  })

  it('shares on the Wi-Fi with a QR code, says once that macOS will ask, and keeps its port and token while Apex runs', async () => {
    const dir = tmp()
    const cert = await makeServerCertificate(['127.0.0.1'])
    const bar: Array<[string, ServerBarView]> = []
    const real = new LocalServers({ dir, file: () => null, hasFolder: () => false, log: () => undefined, lanAddresses: () => ['127.0.0.1'], certificate: async () => cert, platform: 'darwin', indicator: { show: (_c, v) => bar.push(['show', v]), update: () => undefined, hide: () => undefined } })
    const page = new FakePage()
    const first = await real.start(page as unknown as WebContents, ctxOf(appManifest({ lan: true })), APP, { lan: true })
    expect(first.lanUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{22}\/$/)
    expect(first.qr).toMatch(/^data:image\/svg\+xml/)
    expect(bar.at(-1)?.[1]).toMatchObject({ lan: true, hint: true })
    const asked = raw(first.port as number, `/${(first.lanUrl as string).split('/')[3]}/hello`, { host: `127.0.0.1:${first.port}` }, true)
    await until(() => page.sent.some((e) => e.type === 'request'))
    real.respond(page.id, (page.sent.find((e) => e.type === 'request') as { id: string }).id, { body: 'over tls' })
    expect((await asked).body).toBe('over tls')
    // Its page reloads: the server stops, and the next one has the same port and token, without the hint.
    page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await until(() => real.list().length === 0)
    expect(page.sent.at(-1)).toEqual({ type: 'stopped', reason: 'closed' })
    const again = await real.start(page as unknown as WebContents, ctxOf(appManifest({ lan: true })), APP, { lan: true })
    expect([again.port, again.lanUrl]).toEqual([first.port, first.lanUrl])
    expect(bar.at(-1)?.[1]).toMatchObject({ hint: false })
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toMatchObject({ ports: { 'pads/main': first.port }, hintSeen: true })
    await real.stopAll()
  }, 30_000)

  it('the person’s Stop ends it and throws the token away; turning the pack off stops it too', async () => {
    const { servers, pressStop } = manager()
    const page = new FakePage()
    const first = await servers.start(page as unknown as WebContents, ctxOf(appManifest({})), APP, {})
    pressStop()
    await until(() => servers.list().length === 0)
    expect(page.sent.at(-1)).toEqual({ type: 'stopped', reason: 'person' })
    const second = await servers.start(page as unknown as WebContents, ctxOf(appManifest({})), APP, { token: true })
    expect(second.url).not.toBe(first.url)
    expect(second.port).toBe(first.port)
    await servers.stopWhere((packId) => packId === 'pads')
    expect(servers.list()).toEqual([])
    expect(page.sent.at(-1)).toEqual({ type: 'stopped', reason: 'closed' })
    const plain = await servers.start(page as unknown as WebContents, ctxOf(appManifest({})), APP, { token: false })
    expect(plain.url).toMatch(/:\d+\/$/)
    expect(plain.token).toBe(false)
    await servers.stop(page.id, 'stopped')
    expect(servers.status(page.id)).toMatchObject({ running: false, url: null })
  })
})

describe('the helper for served pages and the starter', () => {
  it('parses as a script', () => {
    const file = join(tmp(), 'client.js')
    writeFileSync(file, SERVER_CLIENT_JS)
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    expect(check.status, check.stderr).toBe(0)
  })

  it('the phone controller starter passes the rules, asks for the Wi-Fi, and its scripts parse', () => {
    const made = starterFiles('phone-controller', { id: 'my-pads', name: 'My pads', description: 'Phones as pads.' })
    const check = validatePack(made)
    expect(check.ok ? [] : check.problems).toEqual([])
    const manifest = JSON.parse(made.get(PACK_MANIFEST_FILE)!.toString()) as PackManifest
    expect(manifest.permissions.server).toEqual({ lan: true })
    expect(describePackPermissions(manifest).find((l) => l.kind === 'server')?.key).toBe('packs.perm.serverLan')
    const dir = tmp()
    for (const [path, name] of [['app/main.js', 'main.mjs'], ['phone/phone.js', 'phone.js']] as const) {
      writeFileSync(join(dir, name), made.get(path)!)
      const parsed = spawnSync(process.execPath, ['--check', join(dir, name)], { encoding: 'utf8' })
      expect(parsed.status, `${path}: ${parsed.stderr}`).toBe(0)
    }
    expect(made.get('phone/index.html')!.toString()).toContain('<script src="__apex/client.js"></script>')
    expect(made.get('app/main.js')!.toString()).toContain("apex.server.start({ lan: true, root: 'phone' })")
  })
})
