/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex.server in the real app (APEX_SMOKE_ONLY=PACKS, docs/packs.md › A web
// server of its own): an app that may share on the Wi-Fi starts its server,
// which serves its phone folder and its page's routes on this computer, and
// over TLS with Apex's certificate on the "Wi-Fi" (127.0.0.1 in a smoke run,
// which never leaves the machine). A fake phone (a Node WebSocket client)
// joins with the token and sends frames the app's page hears in order and
// answers; a wrong token gets nothing. Apex's bar sits at the top of the
// app's pane at a real size, counts the phone, and its Stop ends the server.
// An app without lan can't share on the Wi-Fi, and closing the app's tab
// stops its server.
import { request as httpsRequest } from 'node:https'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import WebSocket from 'ws'
import { NO_PACK_PERMISSIONS, PACK_MANIFEST_FILE, packUrl, type PackManifest } from '@shared/packs'
import type { PackServerStatus } from '@shared/localServer'
import { clientTool, type ClientToolContext } from '../agent/tools/registry'
import { assert, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { SmokeContext } from '../smokeBrowser/types'
import type { Tab } from '../tabs'
import { packsRuntime } from './feature'
import { encodeArchive, packHash } from './files'
import type { PackFiles } from './manifest'
import { AuthorKey } from './signing'

export const SERVER_PACK_ID = 'smoke-server'
export const SERVER_LOCAL_PACK_ID = 'smoke-server-local'
const STARTER_PHONE = 'smoke-starter-phone'

const toolCtx = (): ClientToolContext => ({
  chatId: 'smoke-packs-chat',
  companionId: 'shared',
  isPrivate: false,
  isRoutine: false,
  signal: new AbortController().signal,
  emit: () => undefined,
  ask: async () => {
    throw new Error('Pack tools never ask.')
  },
})

const js = <T>(wc: WebContents, code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

/** The app's page: hears sockets and requests, answers a ping, and keeps what it heard in order. */
const APP_SCRIPT = `window.__heard = []
apex.server.onConnection((socket) => {
  __heard.push('join:' + socket.query.name + ':' + socket.remote)
  socket.onMessage((value, text) => {
    __heard.push('message:' + text)
    if (value && value.t === 'ping') socket.send({ t: 'pong', n: value.n })
  })
  socket.onClose((code) => __heard.push('close:' + code))
})
apex.server.onRequest((req) => (req.path === '/api/score' ? { body: { score: 7, team: req.query.team || null } } : null))
apex.server.onStop((reason) => __heard.push('stop:' + reason))
document.title = 'ready'
`

function fixture(id: string, lan: boolean): PackFiles {
  const manifest: PackManifest = {
    format: 'apex-pack',
    manifestVersion: 2,
    id,
    name: lan ? 'Smoke pads' : 'Smoke local pads',
    version: '1.0.0',
    description: 'Phones as controllers, for the smoke test.',
    contributes: { apps: [{ id: 'main', name: lan ? 'Smoke pads' : 'Smoke local pads', root: 'app', entry: 'index.html', build: 'kit', kind: 'game' }] },
    permissions: { ...NO_PACK_PERMISSIONS, server: lan ? { lan: true } : {} },
  }
  return new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(manifest))],
    ['app/index.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>pads</title><script type="module" src="./main.js"></script></head><body><h1>Pads</h1></body></html>')],
    ['app/main.js', Buffer.from(APP_SCRIPT)],
    ['phone/index.html', Buffer.from('<!doctype html><title>phone</title><p>phone page</p>')],
  ])
}

/** A request over TLS that accepts Apex's self-signed certificate, as a phone does once. */
function tlsGet(url: string): Promise<{ status: number; body: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { rejectUnauthorized: false, agent: false }, (res) => {
      // Read while the socket is still there.
      const fingerprint = (res.socket as import('node:tls').TLSSocket | null)?.getPeerCertificate?.()?.fingerprint256 ?? ''
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, fingerprint }))
    })
    req.on('error', reject)
    req.setTimeout(5_000, () => req.destroy(new Error('timed out')))
    req.end()
  })
}

/** A fake phone: joins the socket and collects what the app sends back. */
function phone(url: string): Promise<{ ws: WebSocket; got: unknown[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { rejectUnauthorized: false })
    const got: unknown[] = []
    ws.on('message', (data) => got.push(JSON.parse(String(data))))
    ws.once('open', () => resolve({ ws, got }))
    ws.once('error', reject)
    ws.once('unexpected-response', (_req, res) => reject(new Error(`refused with ${res.statusCode}`)))
  })
}

/** The bar's rect in window px, read from the overlay view. */
async function barRect(contentsId: number): Promise<{ bar: { x: number; y: number; width: number; height: number; text: string }; pane: { x: number; y: number; width: number; height: number } }> {
  const running = packsRuntime()
  assert(running, 'packs are not running')
  let shown: ReturnType<typeof running.serverBar.shown> = null
  await waitFor(() => {
    shown = running.serverBar.shown(contentsId)
    return Boolean(shown?.instanceId)
  }, 5_000, 'Apex’s bar over the app')
  const { win } = shown as unknown as NonNullable<ReturnType<typeof running.serverBar.shown>>
  const wc = win.overlay.tierWebContents('interactive')
  assert(wc, 'the overlay view is missing')
  let rect: { x: number; y: number; width: number; height: number; text: string } | null = null
  await waitFor(async () => {
    rect = await js<typeof rect>(wc, `(() => { const el = document.querySelector('.sv-bar'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, text: el.textContent || '' } })()`).catch(() => null)
    return Boolean(rect && rect.width > 0 && win.overlay.interactiveBounds())
  }, 5_000, 'the bar to draw')
  const view = win.overlay.interactiveBounds()
  assert(view, 'the overlay view has no bounds')
  const zoom = win.chrome.isDestroyed() ? 1 : win.chrome.getZoomFactor() || 1
  const r = rect as unknown as { x: number; y: number; width: number; height: number; text: string }
  const paneTab = win.tabs.all().find((t) => t.view.webContents.id === contentsId)
  assert(paneTab, 'the app’s tab is not in the bar’s window')
  const pane = win.tabs.paneBounds(paneTab.id)
  assert(pane, 'the app’s pane has no bounds')
  return { bar: { x: view.x + r.x * zoom, y: view.y + r.y * zoom, width: r.width * zoom, height: r.height * zoom, text: r.text }, pane }
}

export async function serverWorks(ctx: SmokeContext): Promise<void> {
  const running = packsRuntime()
  assert(running, 'packs are not running')
  const { service, runtime } = running
  const author = new AuthorKey(mkdtempSync(join(tmpdir(), 'apex-smoke-author-')), { encrypt: (b) => b, decrypt: (b) => b })
  const install = (files: PackFiles): void => {
    const review = service.reviewArchive(encodeArchive(files, author.sign(packHash(files))), { kind: 'file' })
    assert(review.problems.length === 0, `the server app has problems: ${review.problems.join('; ')}`)
    service.confirmInstall(review.token)
  }
  const open = async (id: string): Promise<Tab> => {
    runtime.openApp(id, 'main')
    const url = packUrl(id, 'app/index.html')
    let tab: Tab | undefined
    await waitFor(() => {
      tab = ctx.tabs.all().find((t) => t.requestedUrl === url)
      return Boolean(tab)
    }, 5_000, `the ${id} tab`)
    const wc = (tab as Tab).view.webContents
    await waitForPage(wc, `the ${id} app`, 10_000, (at) => at.startsWith(`apex-pack://${id}/`))
    await waitFor(() => js<boolean>(wc, 'document.title === "ready"').catch(() => false), 10_000, `the ${id} app to be ready`)
    return tab as Tab
  }
  // A smoke run's "Wi-Fi" is this machine, so nothing leaves it.
  runtime.servers.useLanAddresses(() => ['127.0.0.1'])
  const tabs: Tab[] = []
  const phones: WebSocket[] = []
  try {
    const review = service.reviewArchive(encodeArchive(fixture(SERVER_PACK_ID, true), author.sign(packHash(fixture(SERVER_PACK_ID, true)))), { kind: 'file' })
    const line = review.permissions.find((l) => l.kind === 'server')
    assert(line?.key === 'packs.perm.serverLan' && line.level === 'warning', `the review’s server line: ${JSON.stringify(line)}`)
    service.confirmInstall(review.token)
    install(fixture(SERVER_LOCAL_PACK_ID, false))

    const app = await open(SERVER_PACK_ID)
    tabs.push(app)
    const wc = app.view.webContents
    const heard = (): Promise<string[]> => js<string[]>(wc, 'window.__heard')

    // On this computer: plain HTTP on 127.0.0.1, the phone folder and the page's route, the token required.
    const local = await js<PackServerStatus>(wc, "apex.server.start({ root: 'phone' })")
    assert(local.running && local.url?.startsWith('http://127.0.0.1:') && local.lanUrl === null && local.qr === null, `the local server: ${JSON.stringify(local)}`)
    const base = local.url as string
    const page = await fetch(base)
    assert(page.status === 200 && (await page.text()).includes('phone page'), 'the phone folder was not served')
    const route = (await (await fetch(`${base}api/score?team=red`)).json()) as { score: number; team: string }
    assert(route.score === 7 && route.team === 'red', `the page’s route: ${JSON.stringify(route)}`)
    assert((await fetch(`http://127.0.0.1:${local.port}/`)).status === 404, 'the server answered without its token')
    assert((await fetch(`http://127.0.0.1:${local.port}/AAAAAAAAAAAAAAAAAAAAAA/`)).status === 404, 'the server answered a wrong token')
    let bar = await barRect(wc.id)
    assert(/runs a web server on this computer/.test(bar.bar.text), `the bar says: ${bar.bar.text}`)

    // On the "Wi-Fi": HTTPS with Apex's certificate, and a phone that joins, moves, presses and is answered.
    const lan = await js<PackServerStatus>(wc, "apex.server.start({ lan: true, root: 'phone' })")
    assert(lan.running && lan.lan && lan.lanUrl?.startsWith('https://127.0.0.1:') && lan.qr?.startsWith('data:image/svg+xml'), `the Wi-Fi server: ${JSON.stringify({ ...lan, qr: lan.qr?.slice(0, 30) })}`)
    const lanBase = lan.lanUrl as string
    const tls = await tlsGet(lanBase)
    assert(tls.status === 200 && tls.body.includes('phone page') && tls.fingerprint.length > 0, `the phone page over TLS: ${tls.status}`)
    const wrong = await tlsGet(`https://127.0.0.1:${lan.port}/AAAAAAAAAAAAAAAAAAAAAA/`)
    assert(wrong.status === 404, `a wrong token over TLS got ${wrong.status}`)
    let refused = ''
    await phone(`wss://127.0.0.1:${lan.port}/AAAAAAAAAAAAAAAAAAAAAA/__apex/socket`).then(
      (p) => p.ws.close(),
      (err: Error) => (refused = err.message),
    )
    assert(/404/.test(refused), `a socket with a wrong token: ${refused || 'joined'}`)
    const before = (await heard()).length
    const fake = await phone(`${lanBase.replace('https:', 'wss:')}__apex/socket?name=Phone`)
    phones.push(fake.ws)
    const frames = ['{"t":"motion","b":12.5,"g":-3,"rx":40}', '{"t":"button","b":"a","down":true}', '{"t":"button","b":"a","down":false}', '{"t":"ping","n":1}']
    for (const f of frames) fake.ws.send(f)
    await waitFor(() => fake.got.length > 0, 5_000, 'the app’s answer on the socket')
    const pong = fake.got[0] as { t: string; n: number }
    assert(pong.t === 'pong' && pong.n === 1, `the app answered ${JSON.stringify(pong)}`)
    const order = (await heard()).slice(before)
    const want = ['join:Phone:local', ...frames.map((f) => `message:${f}`)]
    assert(JSON.stringify(order) === JSON.stringify(want), `the page heard ${JSON.stringify(order)}`)

    // Apex's bar: at the top of the app's pane, a real size, centred, counting the phone.
    await waitFor(async () => /1 connected/.test((await barRect(wc.id)).bar.text), 5_000, 'the bar to count the phone')
    bar = await barRect(wc.id)
    const { bar: b, pane } = bar
    assert(/sharing on your Wi-Fi/.test(b.text), `the bar says: ${b.text}`)
    assert(b.width >= 220 && b.width <= pane.width && b.height >= 28 && b.height <= 140, `the bar is ${Math.round(b.width)}×${Math.round(b.height)}`)
    assert(b.y >= pane.y && b.y <= pane.y + 48, `the bar is not at the top of the pane: y ${Math.round(b.y)}, pane from ${Math.round(pane.y)}`)
    assert(Math.abs(b.x + b.width / 2 - (pane.x + pane.width / 2)) <= 24 && b.x >= pane.x && b.x + b.width <= pane.x + pane.width, `the bar is not centred over the pane: ${Math.round(b.x)}…${Math.round(b.x + b.width)} in ${Math.round(pane.x)}…${Math.round(pane.x + pane.width)}`)
    await ctx.shot('packs-server-bar')

    // The person's Stop ends it: the phone is let go, the page hears why, the port closes.
    const closed = new Promise<number>((resolve) => fake.ws.once('close', (code) => resolve(code)))
    const shown = running.serverBar.shown(wc.id)
    const overlay = shown?.win.overlay.tierWebContents('interactive')
    assert(overlay, 'the overlay view is missing')
    await js(overlay, "document.querySelector('.sv-bar button').click()")
    assert((await closed) === 1001, 'the phone was not let go')
    await waitFor(async () => (await heard()).includes('stop:person'), 5_000, 'the page to hear the person’s Stop')
    assert(runtime.servers.list().length === 0, 'the server still runs after Stop')
    let gone = false
    await tlsGet(lanBase).catch(() => (gone = true))
    assert(gone, 'the port still answers after Stop')

    // An app without lan can't share on the Wi-Fi, and closing its tab stops its server.
    const other = await open(SERVER_LOCAL_PACK_ID)
    tabs.push(other)
    const otherWc = other.view.webContents
    const denied = await js<string>(otherWc, "apex.server.start({ lan: true }).then(() => 'started', (err) => err.message)")
    assert(/only serve this computer/.test(denied), `an app without lan on the Wi-Fi: ${denied}`)
    const mine = await js<PackServerStatus>(otherWc, 'apex.server.start({})')
    assert(mine.running && mine.url?.startsWith('http://127.0.0.1:'), `the local-only server: ${JSON.stringify(mine)}`)
    assert(runtime.servers.list().some((s) => s.packId === SERVER_LOCAL_PACK_ID && !s.lan), 'the local-only server is not listed')
    ctx.tabs.close(other.id)
    await waitFor(() => !runtime.servers.list().some((s) => s.packId === SERVER_LOCAL_PACK_ID), 5_000, 'the server to stop with its tab')
    let closedPort = false
    await fetch(mine.url as string).catch(() => (closedPort = true))
    assert(closedPort, 'the port still answers after the app closed')

    // A companion starts from the phone controller starter: in test_pack its server runs on this computer, and the app says it serves.
    const create = clientTool('create_pack')
    const test = clientTool('test_pack')
    assert(create && test, 'the builder tools are not registered')
    const made = await create.run({ id: STARTER_PHONE, name: 'Smoke phone controller', description: 'A starter in the smoke test.', starter: 'phone-controller' }, toolCtx())
    assert(!made.isError && made.content.includes('phone/phone.js'), `create_pack with the phone-controller starter: ${made.content.slice(0, 200)}`)
    const played = await test.run({ id: STARTER_PHONE, playtest: { width: 800, height: 600, steps: [{ wait: 800 }, { capture: 'serving' }] } }, toolCtx())
    const report = JSON.parse(played.content) as { ok: boolean; playtest?: { ok: boolean; errors: string[]; state: { serving?: boolean; phones?: number } | null } }
    const p = report.playtest
    assert(p && p.ok && p.errors.length === 0, `the phone-controller playtest: ${played.content.slice(0, 600)}`)
    assert(p.state?.serving === true && p.state.phones === 0, `the phone-controller app doesn’t serve: ${JSON.stringify(p.state)} ${JSON.stringify((report as { logs?: unknown }).logs ?? report).slice(0, 1200)}`)
    await waitFor(() => runtime.servers.list().every((s) => s.packId !== STARTER_PHONE), 3_000, 'the starter’s test server to end with its playtest')
  } finally {
    if (running.store.hasDraft(STARTER_PHONE)) running.store.removeDraft(STARTER_PHONE)
    runtime.servers.useLanAddresses(null)
    for (const ws of phones) ws.terminate()
    for (const tab of tabs) if (ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
    for (const id of [SERVER_PACK_ID, SERVER_LOCAL_PACK_ID]) if (running.store.get(id)) service.remove(id)
  }
}
