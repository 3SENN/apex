/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The apex-pack:// sandbox (docs/packs.md › The sandbox and the bridge). Each
// pack runs in its own persistent partition, persist:apex-pack-<id>, which
// only ever serves that pack's own files, with Apex's tool host under
// __apex/. Defence in depth, because pack code may come from anyone:
//   - the CSP allows the pack's own script files (never inline code, so
//     nothing that wasn't in the review can run), styles, images and fonts;
//     nothing reaches the network (apex.fetch goes through main);
//   - the session's proxy is a dead end and WebRTC is off, so sockets that
//     skip the request layer (preconnect, STUN and TURN) get nowhere;
//   - the session refuses http, https, ws and file itself, and the webRequest
//     lockdown allows only the pack's own address;
//   - every permission and download is denied; navigation, pop-ups and
//     webviews are blocked; the agent never acts there;
//   - the only way out is the bridge preload, checked in main op by op.
// An app's folder (docs/apps.md › The sandbox) gets a wider CSP, for what a
// real game needs (workers, WebAssembly, its own frames), and a game's pages
// may go full screen and lock the pointer. An app may also connect straight
// to its own servers (docs/apps.md › Your own servers): fetch, WebSocket,
// EventSource, images and media to the hosts in its network permission, and
// only those. Its CSP names every host the pack may ever reach; the lockdown,
// the protocol handlers and the proxy's bypass list hold it to the ones it may
// reach now (an optional host only once granted). Code still comes only from
// the pack, and WebRTC stays off.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { session as electronSession, type Session, type WebContents, type WebPreferences } from 'electron'
import { PACK_KIT_DIR, PACK_OWN_DIR, PACK_PARTITION_PREFIX, PACK_SCHEME, PACK_TOOL_HOST_PATH, PACK_TOOL_HOST_SCRIPT, isLocalHost, packDirectAllowed, parseAssetPath, parsePackUrl, packUrl, type PackApp } from '@shared/packs'
import { log } from '../log'
import { permissionPolicy } from '../permissionPolicy'
import type { SessionInfo } from '../features/types'
import { webRequest } from '../webRequest'

export const PACK_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

/** Files in an app's folder: its own scripts, workers, WebAssembly and frames; still nothing from the network. */
export const PACK_APP_CSP = appCsp(null, [])

/**
 * An app's CSP. `hashes` are the inline scripts of the page being served
 * (its own reviewed or signed file), so a build tool's bootstrap script runs
 * while a script injected later doesn't; `eval` only when the manifest asks.
 */
export function appCsp(app: Pick<PackApp, 'eval'> | null, hashes: readonly string[], hosts: readonly string[] = []): string {
  const script = ["'self'", "'wasm-unsafe-eval'", ...(app?.eval ? ["'unsafe-eval'"] : []), ...hashes.map((h) => `'sha256-${h}'`)].join(' ')
  const media = hostSources(hosts, false).join(' ')
  const connect = hostSources(hosts, true).join(' ')
  return [
    "default-src 'none'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${media ? ` ${media}` : ''}`,
    "font-src 'self' data:",
    `media-src 'self' data: blob:${media ? ` ${media}` : ''}`,
    `connect-src 'self' data: blob:${connect ? ` ${connect}` : ''}`,
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "child-src 'self' blob:",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ')
}

/**
 * CSP sources for the hosts an app may reach: https (and wss with
 * `sockets`), on any port; http and ws too on this computer. A wildcard covers
 * its base name as well, as the network permission does.
 */
export function hostSources(hosts: readonly string[], sockets: boolean): string[] {
  const out: string[] = []
  for (const h of hosts) {
    for (const name of h.startsWith('*.') ? [h, h.slice(2)] : [h]) {
      const local = isLocalHost(name)
      out.push(`https://${name}:*`)
      if (local) out.push(`http://${name}:*`)
      if (sockets) out.push(`wss://${name}:*`, ...(local ? [`ws://${name}:*`] : []))
    }
  }
  return out
}

/** The proxy's bypass list for hosts an app may reach now: those connect directly, every other socket goes nowhere. */
export function proxyBypass(hosts: readonly string[]): string {
  const rules = ['<-loopback>']
  for (const h of hosts) rules.push(...(h.startsWith('*.') ? [h, h.slice(2)] : [h]))
  return rules.join(',')
}

/** The SHA-256 (base64) of each inline script in a page, as CSP hash sources match them. */
export function inlineScriptHashes(html: string): string[] {
  const out = new Set<string>()
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (/\ssrc\s*=/i.test(m[1] ?? '')) continue
    const body = m[2] ?? ''
    if (!body.trim()) continue
    out.add(createHash('sha256').update(body, 'utf8').digest('base64'))
    if (out.size >= 200) break
  }
  return [...out]
}
/** What a game's pages may ask for without a prompt; everything else stays denied. */
const GAME_PERMISSIONS = new Set(['fullscreen', 'pointerLock', 'keyboardLock'])

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml',
  csv: 'text/csv; charset=utf-8',
}

export function packContentType(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
  return TYPES[ext] ?? 'application/octet-stream'
}

/**
 * The headers a pack file is served with. `app` is the app whose folder holds
 * it (its CSP, and COEP when it is `isolated`, for SharedArrayBuffer); `hashes`
 * the inline scripts of the page being served.
 */
export function packResponseHeaders(path: string, app: Pick<PackApp, 'eval' | 'isolated'> | null = null, hashes: readonly string[] = [], hosts: readonly string[] = []): Record<string, string> {
  return {
    'content-type': packContentType(path),
    'content-security-policy': app ? appCsp(app, hashes, hosts) : PACK_CSP,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    ...(app?.isolated ? { 'cross-origin-embedder-policy': 'require-corp' } : {}),
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), clipboard-read=(), clipboard-write=(), display-capture=()',
  }
}

/** The tool host page; its script is a file of its own, since pack pages run no inline code. */
export function toolHostHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Tool host</title></head><body>
<script type="module" src="/${PACK_TOOL_HOST_SCRIPT}"></script>
</body></html>`
}

/** The tool host's script: imports each tool module and serves calls through the bridge. */
export function toolHostScript(modules: Array<{ name: string; module: string }>): string {
  const imports = modules.map((m, i) => `import * as t${i} from ${JSON.stringify(`/${m.module}`)}`).join('\n')
  const table = modules.map((m, i) => `${JSON.stringify(m.name)}: t${i}`).join(',\n  ')
  return `${imports}
window.addEventListener('error', (e) => window.apex.log('Uncaught: ' + (e.message || e.error)))
window.addEventListener('unhandledrejection', (e) => window.apex.log('Unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))))
const tools = {
  ${table}
}
window.apex.tools.serve(async (name, input, ctx) => {
  // A service call names svc:<service>#<method>: the module exports one function per method.
  const hash = name.indexOf('#')
  const mod = tools[hash > 0 ? name.slice(0, hash) : name]
  if (hash > 0) {
    const method = name.slice(hash + 1)
    const fn = mod && typeof mod[method] === 'function' ? mod[method] : null
    if (!fn) throw new Error('The service module has no ' + method + ' function. Export async function ' + method + '(input, ctx).')
    return await fn(input, ctx)
  }
  const run = mod && (typeof mod.run === 'function' ? mod.run : typeof mod.default === 'function' ? mod.default : null)
  if (!run) throw new Error('The tool ' + name + ' has no run function. Export async function run(input, ctx).')
  return await run(input, ctx)
})
`
}

/** 'installed': an installed, enabled pack; 'test': a draft in test_pack's throwaway, in-memory sandbox. */
export type PackMode = 'installed' | 'test'

export interface PackFileSource {
  /** One of a running pack's files held in memory, or null. */
  file(packId: string, path: string, mode: PackMode): Buffer | null
  /** Where one of a running pack's files is on disk, for an app's files that aren't kept in memory; null otherwise. */
  disk?(packId: string, path: string, mode: PackMode): string | null
  /** The app whose folder holds a path of a running pack, or null. */
  appAt(packId: string, path: string, mode: PackMode): PackApp | null
  /** One of the kit's files (docs/apps.md › The kit), `<major>/<path>` on disk; null when the kit has none there. */
  kit?(path: string): string | null
  /** The import map a kit app of that major gets, as JSON text; null when the kit isn't built. */
  kitImportMap?(major: number): string | null
  /** One of the person's own files a pack keeps (apex.files.own), on disk; null when it has none at that path. */
  own?(packId: string, path: string, mode: PackMode): string | null
  /** One of a slot's files (docs/apps.md › Asset slots): from the chosen asset pack, else the app's own layout; null when neither has it. */
  asset?(packId: string, slot: string, path: string, mode: PackMode): { data: Buffer | null; disk: string | null } | null
  /** The tool host page and script for a running pack, or null when it has no tools. */
  toolHost(packId: string, mode: PackMode): { html: string; script: string } | null
  /**
   * The hosts an app's pages may connect to straight (docs/apps.md › Your own
   * servers): `now`, what the lockdown lets through; `ever`, what its CSP
   * names (now, plus optional hosts not granted yet). Empty for a pack with no app.
   */
  network?(packId: string, mode: PackMode): { now: string[]; ever: string[] }
  /** Notes a direct connection an app's page makes (an organisation's audit log; a no-op without one). */
  connected?(packId: string, mode: PackMode, url: string): void
  /** A request's headers with the pack's keys in place (secrets), or null when nothing changes. */
  requestHeaders?(packId: string, mode: PackMode, url: string, headers: Record<string, string>): Record<string, string> | null
}

/** A `Range: bytes=a-b` header as an inclusive span of a file of `size` bytes; null for a whole-file read. */
export function parseByteRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    // A suffix: the last n bytes.
    const n = Number(m[2])
    if (n === 0) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/** Files up to this size are read in one go; bigger ones (music, video, big textures) stream, so a request never holds the whole file. */
const STREAM_FROM = 256 * 1024

/** Reads a file from disk, whole or one span of it, as a response; null when it can't be read. */
async function serveDisk(file: string, baseHeaders: Record<string, string>, rangeHeader: string | null): Promise<Response | null> {
  let size: number
  try {
    const st = await stat(file)
    if (!st.isFile()) return null
    size = st.size
  } catch {
    return null
  }
  const headers = { ...baseHeaders, 'accept-ranges': 'bytes' }
  const range = parseByteRange(rangeHeader, size)
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
  const start = range?.start ?? 0
  const end = range?.end ?? size - 1
  const length = size === 0 ? 0 : end - start + 1
  let body: BodyInit
  try {
    if (length <= STREAM_FROM) {
      const data = await readFile(file)
      body = new Uint8Array(data.buffer, data.byteOffset + start, Math.min(length, Math.max(0, data.length - start)))
    } else {
      body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream<Uint8Array>
    }
  } catch {
    return null
  }
  const sized = { ...headers, 'content-length': String(length) }
  if (!range) return new Response(body, { headers: sized })
  return new Response(body, { status: 206, headers: { ...sized, 'content-range': `bytes ${start}-${end}/${size}` } })
}

const isHtml = (path: string): boolean => /\.html?$/i.test(path)

/** A kit app's page with the kit's import map first in its head (before any module script), so bare imports resolve. */
export function withImportMap(html: string, map: string | null): string {
  if (!map) return html
  const tag = `<script type="importmap">${map}</script>`
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
  const doctype = /<!doctype[^>]*>/i.exec(html)
  return doctype ? html.slice(0, doctype.index + doctype[0].length) + tag + html.slice(doctype.index + doctype[0].length) : tag + html
}
const hasExtension = (path: string): boolean => /\.[A-Za-z0-9]{1,12}$/.test(path.split('/').pop() ?? '')

/**
 * Where a request for `path` lands inside an app, the way static hosts and
 * build tools expect: in a pack with one app, an address the pack doesn't use
 * for its other files is the app's (so `/assets/x.js` from a Vite build
 * works); a folder gets its index.html, `about` its about.html; and a page the
 * app doesn't have (a single-page app's route) gets the app's entry page.
 */
export function resolveAppPath(app: Pick<PackApp, 'root' | 'entry'>, path: string, exists: (path: string) => boolean, wantsPage: boolean): string {
  const inRoot = path === app.root || path.startsWith(`${app.root}/`)
  let at = inRoot ? path : `${app.root}/${path}`
  if (at === app.root || at.endsWith('/')) at = `${at.replace(/\/+$/, '')}/index.html`
  if (exists(at)) return at
  if (!hasExtension(at)) {
    for (const candidate of [`${at}.html`, `${at}/index.html`]) if (exists(candidate)) return candidate
    if (wantsPage) return `${app.root}/${app.entry}`
  }
  return at
}

/** What an apex-pack request inside pack `packId`'s partition gets back. Anything outside that one pack is a 404. */
export async function servePack(source: PackFileSource, packId: string, url: string, mode: PackMode = 'installed', rangeHeader: string | null = null, accept: string | null = null): Promise<Response> {
  const target = parsePackUrl(url)
  const notFound = (): Response => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  if (!target || target.packId !== packId) return notFound()
  if (target.path === PACK_TOOL_HOST_PATH || target.path === PACK_TOOL_HOST_SCRIPT) {
    const host = source.toolHost(packId, mode)
    if (!host) return notFound()
    return new Response(target.path === PACK_TOOL_HOST_PATH ? host.html : host.script, { headers: packResponseHeaders(target.path) })
  }
  // The kit: the same files for every pack, served inside its own origin.
  if (target.path.startsWith(`${PACK_KIT_DIR}/`)) {
    const file = source.kit?.(target.path.slice(PACK_KIT_DIR.length + 1)) ?? null
    if (!file) return notFound()
    return (await serveDisk(file, packResponseHeaders(target.path), rangeHeader)) || notFound()
  }
  // The person's own files: served to the pack's pages as data, never as a page that runs.
  if (target.path.startsWith(`${PACK_OWN_DIR}/`)) {
    const file = source.own?.(packId, target.path.slice(PACK_OWN_DIR.length + 1), mode) ?? null
    if (!file) return notFound()
    return (await serveDisk(file, { ...packResponseHeaders(target.path), 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" }, rangeHeader)) || notFound()
  }
  // A slot's files: art from an asset pack runs nothing, even opened as a page (SVG, say).
  const asset = parseAssetPath(target.path)
  if (asset) {
    const found = source.asset?.(packId, asset.slot, asset.path, mode) ?? null
    if (!found || (!found.data && !found.disk)) return notFound()
    const headers = { ...packResponseHeaders(asset.path), 'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" }
    if (found.data) return new Response(new Uint8Array(found.data), { headers })
    return (await serveDisk(found.disk as string, headers, rangeHeader)) || notFound()
  }
  const app = source.appAt(packId, target.path, mode)
  const hosts = app ? (source.network?.(packId, mode).ever ?? []) : []
  const exists = (p: string): boolean => source.file(packId, p, mode) !== null || Boolean(source.disk?.(packId, p, mode))
  const path = app ? resolveAppPath(app, target.path, exists, Boolean(accept && /text\/html/i.test(accept))) : target.path
  const data = source.file(packId, path, mode)
  const file = data ? null : (source.disk?.(packId, path, mode) ?? null)
  if (!data && !file) return notFound()
  // An app's pages are read whole, so their inline scripts can be allowed by hash.
  if (app && isHtml(path)) {
    let page: Buffer
    try {
      page = data ?? (await readFile(file as string))
    } catch {
      return notFound()
    }
    const html = app.kit ? withImportMap(page.toString('utf8'), source.kitImportMap?.(app.kit) ?? null) : page.toString('utf8')
    return new Response(html, { headers: packResponseHeaders(path, app, inlineScriptHashes(html), hosts) })
  }
  if (data) return new Response(new Uint8Array(data), { headers: packResponseHeaders(path, app, [], hosts) })
  return (await serveDisk(file as string, packResponseHeaders(path, app, [], hosts), rangeHeader)) || notFound()
}

/** Only this pack's own address may load in its partition. */
export function packRequestAllowed(packId: string, url: string): boolean {
  return parsePackUrl(url)?.packId === packId || url.startsWith('data:') || url.startsWith('blob:')
}

export interface PackSandbox {
  session(packId: string, mode?: PackMode): Session
  /** The app an address is a page of (in its folder), or null. */
  appOf(url: string, mode?: PackMode): { packId: string; appId: string; kind: PackApp['kind'] } | null
  /** The pack a session belongs to, or null for any other session. */
  packOf(session: Session): { packId: string; mode: PackMode } | null
  /** WebPreferences for a tab showing an installed pack's page; null for any other address. */
  preferencesFor(url: string): WebPreferences | null
  /** WebPreferences for a hidden view in a pack's sandbox (the tool host). */
  viewPreferences(packId: string, mode: PackMode): WebPreferences
  /** Blocks navigation, pop-ups and webviews for one pack view. */
  harden(contents: WebContents, packId: string): void
  /** Clears a pack's partition (its localStorage, caches): a removed pack's, or a test run's. */
  clear(packId: string, mode?: PackMode): Promise<void>
  /** Brings every pack session's network in line with what each may reach now (after a grant, an update, a revoke). */
  refreshNetwork(): void
}

const DEAD_PROXY = 'socks5://127.0.0.1:9'
const NETWORK_SCHEMES = ['http', 'https', 'ws', 'wss'] as const

interface SessionEntry {
  ses: Session
  packId: string
  mode: PackMode
  /** The hosts its app may reach now; what the proxy and the handlers were last set for. */
  hosts: string[]
  applied: string | null
}

export function createPackSandbox(deps: {
  source: PackFileSource
  isActive(packId: string): boolean
  preload: string
  installSession: () => ((session: Session, info: SessionInfo) => void) | null
}): PackSandbox {
  const sessions = new Map<string, SessionEntry>()
  const refuseNetwork = (): Response => new Response('Packs reach the network only through apex.fetch, or an app’s own hosts.', { status: 403 })

  /** The session's way out: with no hosts, every scheme refuses and every socket goes to a proxy that isn't there; with hosts, those (and only those) connect. */
  const applyNetwork = (entry: SessionEntry): void => {
    const hosts = deps.source.network?.(entry.packId, entry.mode).now ?? []
    const key = hosts.join(' ')
    if (key === entry.applied) return
    const before = entry.applied
    entry.applied = key
    entry.hosts = hosts
    if (before === null || (before === '') !== (key === '')) {
      for (const scheme of NETWORK_SCHEMES) {
        try {
          if (key === '') entry.ses.protocol.handle(scheme, refuseNetwork)
          else if (before !== null) entry.ses.protocol.unhandle(scheme)
        } catch {
          // Some builds can't intercept every built-in scheme; the CSP and the lockdown still hold.
        }
      }
    }
    void entry.ses.setProxy({ proxyRules: DEAD_PROXY, proxyBypassRules: proxyBypass(hosts) }).catch(() => undefined)
  }

  const sessionFor = (packId: string, mode: PackMode = 'installed'): Session => {
    const key = `${mode}:${packId}`
    const existing = sessions.get(key)
    if (existing) return existing.ses
    if (!parsePackUrl(packUrl(packId))) throw new Error('This pack isn’t installed.')
    // A test run keeps nothing: its partition lives in memory only.
    const partition = mode === 'test' ? `apex-pack-test-${packId}` : `${PACK_PARTITION_PREFIX}${packId}`
    const ses = electronSession.fromPartition(partition)
    ses.protocol.handle(PACK_SCHEME, (request) => servePack(deps.source, packId, request.url, mode, request.headers.get('range'), request.headers.get('accept')))
    try {
      ses.protocol.handle('file', refuseNetwork)
    } catch {
      // The lockdown still refuses file: addresses.
    }
    const entry: SessionEntry = { ses, packId, mode, hosts: [], applied: null }
    // The network is not part of a pack, except an app's own hosts: each scheme
    // refuses before anything leaves the machine, and sockets that never become
    // a request (preconnect, DNS prefetch) go to a proxy that isn't there.
    applyNetwork(entry)
    webRequest.lockdown(ses, (d) => {
      if (packRequestAllowed(packId, d.url)) return true
      if (!packDirectAllowed(entry.hosts, d.url)) return false
      deps.source.connected?.(packId, mode, d.url)
      return true
    }, {
      // The pack's keys go on requests to their hosts, and nowhere else (docs/apps.md › Keys).
      onBeforeSendHeaders: (d) => {
        const headers = deps.source.requestHeaders?.(packId, mode, d.url, d.requestHeaders) ?? null
        return headers ? { requestHeaders: headers } : null
      },
    })
    // A game's own pages may go full screen and lock the pointer; nothing else is ever granted.
    const gameAsks = (permission: string, url: string | undefined): boolean => {
      if (!GAME_PERMISSIONS.has(permission) || !url) return false
      const app = appOf(url, mode)
      return app?.packId === packId && app.kind === 'game'
    }
    permissionPolicy.addOverride((r) => (r.session === ses ? (gameAsks(r.permission, r.webContents?.getURL()) ? 'allow' : 'deny') : null))
    ses.setPermissionRequestHandler((wc, permission, callback) => callback(gameAsks(permission, wc.getURL())))
    ses.setPermissionCheckHandler((wc, permission) => gameAsks(permission, wc?.getURL()))
    ses.setDevicePermissionHandler(() => false)
    ses.on('will-download', (event, item) => {
      event.preventDefault()
      item.cancel()
    })
    try {
      ses.registerPreloadScript({ id: 'apex-pack-bridge', type: 'frame', filePath: deps.preload })
    } catch (err) {
      log.warn('packs', 'The pack bridge preload could not be registered', { error: err instanceof Error ? err.message : String(err) })
    }
    deps.installSession()?.(ses, { private: true, partition })
    sessions.set(key, entry)
    return ses
  }

  const appOf = (url: string, mode: PackMode = 'installed'): { packId: string; appId: string; kind: PackApp['kind'] } | null => {
    const target = parsePackUrl(url)
    if (!target) return null
    const app = deps.source.appAt(target.packId, target.path, mode)
    return app ? { packId: target.packId, appId: app.id, kind: app.kind } : null
  }

  const prefs = (ses: Session): WebPreferences => ({
    session: ses,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    safeDialogs: true,
    spellcheck: false,
    navigateOnDragDrop: false,
    autoplayPolicy: 'user-gesture-required',
  })

  return {
    session: sessionFor,
    appOf,
    packOf(ses) {
      for (const entry of sessions.values()) if (entry.ses === ses) return { packId: entry.packId, mode: entry.mode }
      return null
    },
    viewPreferences: (packId, mode) => prefs(sessionFor(packId, mode)),
    preferencesFor(url) {
      const target = parsePackUrl(url)
      if (!target || !deps.isActive(target.packId)) return null
      return prefs(sessionFor(target.packId))
    },
    harden(contents, packId) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      // No WebRTC path around the proxy (STUN and TURN servers are the other way out).
      contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
      const keep = (event: { preventDefault(): void; url: string }): void => {
        if (parsePackUrl(event.url)?.packId !== packId) event.preventDefault()
      }
      contents.on('will-navigate', keep)
      contents.on('will-redirect', keep)
      // A frame may show a page from one of this pack's app folders (an app's own help or levels, docs/apps.md); nothing else.
      // Panels can't frame anything at all: their CSP has frame-src 'none'.
      contents.on('will-frame-navigate', (event) => {
        if (!event.isMainFrame && appOf(event.url)?.packId !== packId) event.preventDefault()
      })
      contents.on('will-attach-webview', (event) => event.preventDefault())
    },
    refreshNetwork() {
      for (const entry of sessions.values()) applyNetwork(entry)
    },
    async clear(packId, mode = 'installed') {
      const ses = sessions.get(`${mode}:${packId}`)?.ses ?? (mode === 'test' ? null : electronSession.fromPartition(`${PACK_PARTITION_PREFIX}${packId}`))
      if (!ses) return
      try {
        await ses.clearStorageData()
        await ses.clearCache()
      } catch {
        // Nothing stored yet.
      }
    },
  }
}
