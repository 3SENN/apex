/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { acceptLanguageHeader } from '@shared/languages'
import { app, BrowserWindow, webContents as allWebContents, type WebContents } from 'electron'
import { core } from '../app'
import { attachInput, detachInput } from '../input'
import { gestures } from '../popupBlocker'
import { assert, sleep, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import { browserUserAgent, chromeMajor, HIGH_ENTROPY_HINTS, highEntropyHint, identity, lowEntropyHints } from '../userAgent'
import type { Tab } from '../tabs'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'
import { checks as chromeSurfaceChecks } from './chromeSurface'
import { checks as signInModeChecks } from './signInIdentity'

// Browser identity (sign-in compatibility): what a site sees of Atelier, read
// from a local fixture page the way a site would: navigator and its client
// hints in the page, an iframe, a dedicated worker, a service worker, a popup
// and a second profile, the request headers the server receives, and whether
// a DevTools client has the Runtime domain on (the console.debug probe: an
// Error whose `stack` getter only runs when a CDP client serializes it).
// Everything runs on the smoke server; nothing leaves the machine.
// ATELIER_SMOKE_IDENTITY_OUT=<file> writes the full measured report as JSON.

const HINT_HEADERS = [
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-full-version',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-model',
  'sec-ch-ua-wow64',
  'sec-ch-ua-form-factors',
]
const ACCEPT_CH = 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Full-Version, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors'
const HIGH = ['platform', 'platformVersion', 'architecture', 'bitness', 'model', 'uaFullVersion', 'fullVersionList', 'wow64', 'formFactors']

type Headers = Record<string, string>
interface Brand {
  brand: string
  version: string
}
export interface Signals {
  ua: string
  appVersion?: string
  vendor?: string
  platform: string
  brands: Brand[] | null
  mobile: boolean | null
  uaPlatform: string | null
  high: Record<string, unknown> | null
  webdriver: unknown
  languages: string[]
  chromeType?: string
  chromeKeys?: string[]
  plugins?: number
  mimeTypes?: number
  pdfViewerEnabled?: boolean
  cdpRuntime?: boolean
  alertNative?: boolean
  getUserMediaNative?: boolean
  nodeGlobals?: string[]
  appGlobals?: string[]
  notification?: string
  outer?: [number, number]
  inner?: [number, number]
  screen?: [number, number, number, number]
}

/** The signals one realm shows. Self-contained: it is serialized into pages and workers. */
async function readSignals(high: string[]): Promise<Signals> {
  const g = globalThis as unknown as Record<string, unknown> & { navigator: Navigator & { userAgentData?: { brands: Brand[]; mobile: boolean; platform: string; getHighEntropyValues(h: string[]): Promise<Record<string, unknown>> } } }
  const nav = g.navigator
  const uad = nav.userAgentData
  let values: Record<string, unknown> | null = null
  try {
    values = uad ? await uad.getHighEntropyValues(high) : null
  } catch (err) {
    values = { error: String(err) }
  }
  const out: Signals = {
    ua: nav.userAgent,
    platform: nav.platform,
    brands: uad ? uad.brands.map((b) => ({ brand: b.brand, version: b.version })) : null,
    mobile: uad ? uad.mobile : null,
    uaPlatform: uad ? uad.platform : null,
    high: values,
    webdriver: nav.webdriver,
    languages: [...nav.languages],
  }
  if (typeof (g as { document?: unknown }).document === 'undefined') return out
  const w = g as unknown as Window & Record<string, unknown>
  const native = (fn: unknown): boolean => typeof fn === 'function' && /\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(fn))
  let cdpRuntime = false
  try {
    const probe = new Error('identity probe')
    Object.defineProperty(probe, 'stack', {
      configurable: true,
      get() {
        cdpRuntime = true
        return ''
      },
    })
    console.debug(probe)
  } catch {
    // A console that throws says nothing either way.
  }
  const chrome = w.chrome as Record<string, unknown> | undefined
  let notification = 'none'
  try {
    notification = `${Notification.permission}/${(await nav.permissions.query({ name: 'notifications' as PermissionName })).state}`
  } catch {
    // No Notification API in this realm.
  }
  return {
    ...out,
    appVersion: nav.appVersion,
    vendor: nav.vendor,
    chromeType: typeof chrome,
    chromeKeys: chrome ? Object.getOwnPropertyNames(chrome).sort() : [],
    plugins: nav.plugins.length,
    mimeTypes: nav.mimeTypes.length,
    pdfViewerEnabled: (nav as { pdfViewerEnabled?: boolean }).pdfViewerEnabled ?? false,
    cdpRuntime,
    alertNative: native(w.alert),
    getUserMediaNative: native(nav.mediaDevices?.getUserMedia),
    nodeGlobals: ['process', 'require', 'module', 'Buffer', 'global', 'electron', '__dirname'].filter((k) => k in w),
    appGlobals: Object.getOwnPropertyNames(w).filter((k) => /atelier|electron/i.test(k)),
    notification,
    outer: [w.outerWidth, w.outerHeight],
    inner: [w.innerWidth, w.innerHeight],
    screen: [w.screenX, w.screenY, w.screen.width, w.screen.height],
  }
}

const READ = `(${readSignals.toString()})`

const pageHtml = (ctx: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Identity ${ctx}</title></head>
<body style="font:14px system-ui;padding:24px"><h1>Identity ${ctx}</h1>
<iframe id="frame" src="/identity/frame?ctx=${ctx}" style="width:300px;height:80px"></iframe>
<script>
const readSignals = ${READ};
const HIGH = ${JSON.stringify(HIGH)};
window.__identity = {
  page: () => readSignals(HIGH),
  frame: () => document.getElementById('frame').contentWindow.__identity.page(),
  echo: () => fetch('/identity/echo?ctx=${ctx}&from=page').then((r) => r.json()),
  worker: () => new Promise((resolve, reject) => {
    const w = new Worker('/identity/worker.js?ctx=${ctx}')
    w.onmessage = (e) => { resolve(e.data); w.terminate() }
    w.onerror = (e) => reject(new Error('worker: ' + (e.message || 'failed')))
  }),
  serviceWorker: async () => {
    if (!navigator.serviceWorker) return { error: 'no navigator.serviceWorker' }
    const reg = await navigator.serviceWorker.register('/identity/sw.js?ctx=${ctx}', { scope: '/identity/' })
    const sw = reg.active || reg.waiting || reg.installing
    if (sw && sw.state !== 'activated') await new Promise((r) => sw.addEventListener('statechange', () => sw.state === 'activated' && r()))
    const target = reg.active
    const reply = await new Promise((resolve) => {
      const ch = new MessageChannel()
      ch.port1.onmessage = (e) => resolve(e.data)
      target.postMessage('read', [ch.port2])
    })
    await reg.unregister()
    return reply
  },
}
</script></body></html>`

const frameHtml = `<!doctype html><html><body>frame<script>
const readSignals = ${READ};
window.__identity = { page: () => readSignals(${JSON.stringify(HIGH)}) }
</script></body></html>`

const workerJs = (ctx: string): string => `const readSignals = ${READ};
readSignals(${JSON.stringify(HIGH)}).then(async (signals) => {
  const headers = await fetch('/identity/echo?ctx=${ctx}&from=worker').then((r) => r.json()).catch((e) => ({ error: String(e) }))
  postMessage({ signals, headers })
})`

const swJs = (ctx: string): string => `const readSignals = ${READ};
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('message', (e) => {
  const port = e.ports[0]
  e.waitUntil(readSignals(${JSON.stringify(HIGH)}).then(async (signals) => {
    const headers = await fetch('/identity/echo?ctx=${ctx}&from=sw').then((r) => r.json()).catch((err) => ({ error: String(err) }))
    port.postMessage({ signals, headers })
  }))
})`

/** The User-Agent, Accept-Language and client hint headers of one request. */
function pick(req: IncomingMessage): Headers {
  const out: Headers = {}
  for (const name of ['user-agent', 'accept-language', ...HINT_HEADERS]) {
    const v = req.headers[name]
    if (v !== undefined) out[name] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

/** Requests the fixture saw, by `<ctx>:<what>`. */
const seen = new Map<string, Headers>()

function routes(ctx: SmokeContext): void {
  const s = ctx.server
  const key = (url: URL, what: string): string => `${url.searchParams.get('ctx') ?? '?'}:${what}`
  s.route('/identity/page', (req, res, url) => {
    seen.set(key(url, 'document'), pick(req))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'accept-ch': ACCEPT_CH, 'cache-control': 'no-store' }).end(pageHtml(url.searchParams.get('ctx') ?? '?'))
  })
  s.route('/identity/frame', (req, res, url) => {
    seen.set(key(url, 'iframe'), pick(req))
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(frameHtml)
  })
  s.route('/identity/echo', (req, res, url) => {
    const headers = pick(req)
    seen.set(key(url, `fetch-${url.searchParams.get('from') ?? '?'}`), headers)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(headers))
  })
  s.route('/identity/worker.js', (req, res, url) => {
    seen.set(key(url, 'worker-script'), pick(req))
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(workerJs(url.searchParams.get('ctx') ?? '?'))
  })
  s.route('/identity/sw.js', (req, res, url) => {
    seen.set(key(url, 'sw-script'), pick(req))
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }).end(swJs(url.searchParams.get('ctx') ?? '?'))
  })
}

const pageUrl = (ctx: SmokeContext, name: string): string => `${ctx.server.http}/identity/page?ctx=${name}`

async function open(tabs: { create(url: string, o?: { activate?: boolean }): Tab }, url: string, name: string): Promise<Tab> {
  const tab = tabs.create(url, { activate: true })
  await waitForPage(tab.view.webContents, `the identity page (${name})`, 10000, (at) => at.includes('/identity/page'))
  await waitFor(() => tab.view.webContents.executeJavaScript('Boolean(window.__identity)').catch(() => false), 5000, `the identity script (${name})`)
  return tab
}

const run = <T>(wc: WebContents, what: 'page' | 'frame' | 'echo' | 'worker' | 'serviceWorker'): Promise<T> => wc.executeJavaScript(`window.__identity.${what}()`, true) as Promise<T>

interface ContextReport {
  page: Signals
  frame?: Signals
  echo?: Headers
  worker?: { signals: Signals; headers: Headers }
  serviceWorker?: { signals: Signals; headers: Headers } | { error: string }
  requests: Record<string, Headers>
  debuggerAttached: boolean
}

async function measure(wc: WebContents, name: string, full: boolean): Promise<ContextReport> {
  const page = await run<Signals>(wc, 'page')
  const report: ContextReport = { page, requests: {}, debuggerAttached: wc.debugger.isAttached() }
  report.echo = await run<Headers>(wc, 'echo')
  if (full) {
    report.frame = await run<Signals>(wc, 'frame')
    report.worker = await run<{ signals: Signals; headers: Headers }>(wc, 'worker')
    report.serviceWorker = await Promise.race([
      run<{ signals: Signals; headers: Headers }>(wc, 'serviceWorker'),
      sleep(8000).then(() => ({ error: 'service worker timed out' })),
    ])
  }
  for (const [k, v] of seen) if (k.startsWith(`${name}:`)) report.requests[k.slice(name.length + 1)] = v
  return report
}

export interface IdentityReport {
  process: { chrome: string; electron: string; platform: string; arch: string; switches: Record<string, boolean>; userAgentFallback: string }
  sessions: Record<string, string>
  contexts: Record<string, ContextReport>
  popup?: Signals | { error: string }
  chromeOuter?: number[]
  /** Chromium's own navigator.languages, read in the chrome (never overridden). */
  ownLanguages?: string[]
}

function closeTab(tabs: { find(id: string): Tab | undefined; close(id: string): void }, tab: Tab | undefined): void {
  if (tab && tabs.find(tab.id) && !tab.view.webContents.isDestroyed()) tabs.close(tab.id)
}

async function measureAll(ctx: SmokeContext): Promise<IdentityReport> {
  seen.clear()
  routes(ctx)
  const handle = core()
  assert(handle, 'the core is running')
  const first = handle.windows.all().find((w) => w.chrome === ctx.chrome.ui)
  assert(first, 'the first window')
  const switches = Object.fromEntries(['enable-automation', 'remote-debugging-port', 'remote-debugging-pipe', 'headless', 'disable-blink-features'].map((s) => [s, app.commandLine.hasSwitch(s)]))
  const report: IdentityReport = {
    process: { chrome: process.versions.chrome ?? '', electron: process.versions.electron ?? '', platform: process.platform, arch: process.arch, switches, userAgentFallback: app.userAgentFallback },
    sessions: { default: first.session.getUserAgent() },
    contexts: {},
    chromeOuter: await ctx.chrome.ui.executeJavaScript('[outerWidth, outerHeight, innerWidth, innerHeight]') as number[],
    ownLanguages: await ctx.chrome.ui.executeJavaScript('[...navigator.languages]') as string[],
  }

  // 1. A normal tab in the default profile, with its iframe, workers and a popup.
  const tab = await open(ctx.tabs, pageUrl(ctx, 'tab'), 'tab')
  try {
    report.contexts.tab = await measure(tab.view.webContents, 'tab', true)
    // A scripted popup (window.open with a user gesture) gets its own webContents.
    const before = new Set(allWebContents.getAllWebContents().map((w) => w.id))
    // The popup blocker counts real input only; this stands in for the click.
    gestures.note(tab.view.webContents.id)
    await tab.view.webContents.executeJavaScript(`window.open('/identity/page?ctx=popup', 'identity-popup', 'popup,width=420,height=420'); true`, true)
    let popup: WebContents | undefined
    await waitFor(() => {
      popup = allWebContents.getAllWebContents().find((w) => !before.has(w.id) && !w.isDestroyed() && w.getURL().includes('ctx=popup'))
      return Boolean(popup) && !popup?.isLoading()
    }, 8000, 'the identity popup').catch(() => undefined)
    if (popup) {
      await waitFor(() => (popup as WebContents).executeJavaScript('Boolean(window.__identity)').catch(() => false), 5000, 'the popup script')
      report.popup = await run<Signals>(popup, 'page')
      BrowserWindow.fromWebContents(popup)?.close()
    } else report.popup = { error: 'no popup opened' }

    // 2. The agent acting on the tab: its input debugger attached, then released.
    await attachInput(tab.view.webContents)
    report.contexts.agent = { ...(await measure(tab.view.webContents, 'tab', false)), requests: {} }
    detachInput(tab.view.webContents)
    await sleep(100)
    report.contexts.agentDone = { ...(await measure(tab.view.webContents, 'tab', false)), requests: {} }
  } finally {
    closeTab(ctx.tabs, tab)
  }

  // 3. A custom website language list (Settings › Languages).
  const before = ctx.settings.get().languages
  try {
    ctx.settings.update({ languages: { mode: 'custom', list: ['nl', 'en-US'] } })
    await sleep(200)
    const langTab = await open(ctx.tabs, pageUrl(ctx, 'lang'), 'lang')
    try {
      report.contexts.lang = await measure(langTab.view.webContents, 'lang', true)
    } finally {
      closeTab(ctx.tabs, langTab)
    }
  } finally {
    ctx.settings.update({ languages: before })
  }

  // 4. A second profile: its own session and window.
  const profiles = handle.servicesOf(first).profiles
  const known = new Set(handle.windows.all().map((w) => w.id))
  const profile = profiles.create({ name: 'Identity check', hue: 'moss' })
  try {
    await waitFor(() => handle.windows.all().some((w) => !known.has(w.id)), 8000, 'the profile window')
    const win = handle.windows.all().find((w) => !known.has(w.id))
    assert(win, 'the profile window')
    report.sessions.profile = win.session.getUserAgent()
    const ptab = await open(win.tabs, pageUrl(ctx, 'profile'), 'profile')
    report.contexts.profile = await measure(ptab.view.webContents, 'profile', true)
  } finally {
    await profiles.remove(profile.id, profile.name)
  }
  return report
}

function write(report: IdentityReport): void {
  const out = process.env.ATELIER_SMOKE_IDENTITY_OUT
  if (out) writeFileSync(out, JSON.stringify(report, null, 2))
}

/** Stock Chromium's shape for every realm and request, or the first difference. */
export function identityProblems(report: IdentityReport): string[] {
  const id = identity()
  const problems: string[] = []
  const expect = (ok: unknown, what: string): void => {
    if (!ok) problems.push(what)
  }
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  const ua = browserUserAgent()
  expect(new RegExp(`^Mozilla/5\\.0 \\([^)]+\\) AppleWebKit/537\\.36 \\(KHTML, like Gecko\\) Chrome/${chromeMajor(report.process.chrome)}\\.0\\.0\\.0 Safari/537\\.36$`).test(ua), `the UA is not Chromium's reduced form: ${ua}`)
  expect(report.process.userAgentFallback === ua, `app.userAgentFallback differs: ${report.process.userAgentFallback}`)
  for (const [name, on] of Object.entries(report.process.switches)) expect(!on, `the ${name} switch is on`)
  for (const [name, value] of Object.entries(report.sessions)) expect(value === ua, `the ${name} session's UA differs: ${value}`)

  const realm = (where: string, s: Signals | undefined, opts: { document?: boolean; top?: boolean } = {}): void => {
    if (!s) {
      problems.push(`${where}: not measured`)
      return
    }
    expect(s.ua === ua, `${where}: navigator.userAgent ${s.ua}`)
    expect(!/electron|atelier/i.test(JSON.stringify([s.ua, s.brands, s.high])), `${where}: an Electron or Atelier token shows`)
    expect(same(s.brands, id.brands), `${where}: brands ${JSON.stringify(s.brands)}`)
    expect(s.mobile === false && s.uaPlatform === id.platform, `${where}: mobile/platform ${s.mobile}/${s.uaPlatform}`)
    const h = s.high ?? {}
    expect(same(h.fullVersionList, id.fullVersionList), `${where}: fullVersionList ${JSON.stringify(h.fullVersionList)}`)
    expect(h.uaFullVersion === id.fullVersion && h.platform === id.platform && h.architecture === id.architecture && h.bitness === id.bitness && h.model === id.model && h.wow64 === id.wow64, `${where}: high-entropy values ${JSON.stringify(h)}`)
    if (id.platformVersion) expect(h.platformVersion === id.platformVersion, `${where}: platformVersion ${String(h.platformVersion)} (expected ${id.platformVersion})`)
    // Window navigators say false; WorkerNavigator has no webdriver at all.
    expect(s.webdriver === (opts.document ? false : undefined), `${where}: navigator.webdriver is ${String(s.webdriver)}`)
    if (!opts.document) return
    expect(s.cdpRuntime === false, `${where}: a DevTools client has the Runtime domain on`)
    // The chrome surface (preload/chromeSurfaceWorld.ts): stock Chrome's window.chrome, in every document.
    expect(s.chromeType === 'object' && JSON.stringify(s.chromeKeys) === JSON.stringify(['app', 'csi', 'loadTimes', 'runtime']), `${where}: window.chrome ${s.chromeType} ${JSON.stringify(s.chromeKeys)}`)
    expect(s.plugins === 5 && s.mimeTypes === 2 && s.pdfViewerEnabled === true, `${where}: plugins ${s.plugins}, mimeTypes ${s.mimeTypes}, pdf ${String(s.pdfViewerEnabled)}`)
    expect((s.nodeGlobals ?? []).length === 0 && (s.appGlobals ?? []).length === 0, `${where}: globals ${JSON.stringify([s.nodeGlobals, s.appGlobals])}`)
    // A laid-out top-level page has a window around it (headless shells report 0).
    if (opts.top && s.inner && s.outer && s.inner[0] > 0) expect(s.outer[0] >= s.inner[0] && s.outer[1] >= s.inner[1], `${where}: outer ${JSON.stringify(s.outer)} smaller than inner ${JSON.stringify(s.inner)}`)
  }

  const low = lowEntropyHints(id)
  // Following the system, tabs hold a language override only where Chromium's own navigator.languages
  // would disagree with the header (on Linux it ends with glib's 'c'): measured here, not taken from Atelier.
  const systemHeader = report.contexts.tab?.requests.document?.['accept-language']
  const systemHeld = Boolean(report.ownLanguages && systemHeader !== undefined && acceptLanguageHeader(report.ownLanguages) !== systemHeader)
  for (const [name, c] of Object.entries(report.contexts)) {
    realm(`${name} page`, c.page, { document: true, top: true })
    if (c.frame) realm(`${name} iframe`, c.frame, { document: true })
    if (c.worker) realm(`${name} worker`, c.worker.signals)
    if (c.serviceWorker) realm(`${name} service worker`, 'signals' in c.serviceWorker ? c.serviceWorker.signals : undefined)
    // The tab's language override reaches its workers too (languages.ts › overrideChild).
    if (c.worker) expect(same(c.worker.signals.languages, c.page.languages), `${name}: worker languages ${JSON.stringify(c.worker.signals.languages)} vs page ${JSON.stringify(c.page.languages)}`)
    // Only the agent's own input attachment (while it acts) and a language override keep a debugger on a tab.
    expect(c.debuggerAttached === (name === 'agent' || name === 'lang' || systemHeld), `${name}: debugger attached ${c.debuggerAttached}${systemHeld ? ' (the system languages need the override)' : ''}`)
    const header = acceptLanguageHeader(c.page.languages)
    for (const [what, h] of Object.entries(c.requests)) {
      const where = `${name} ${what} request`
      expect(h['user-agent'] === ua, `${where}: User-Agent ${h['user-agent']}`)
      expect(h['accept-language'] === header, `${where}: Accept-Language ${h['accept-language']} (navigator.languages gives ${header})`)
      for (const [hint, value] of Object.entries(low)) expect(h[hint] === value, `${where}: ${hint} ${h[hint] ?? 'missing'} (expected ${value})`)
      // After the page's Accept-CH, the origin's requests carry the hints it asked for (the first visit in a session can't).
      const first = what === 'document' && (name === 'tab' || name === 'profile')
      if (first) continue
      for (const hint of HIGH_ENTROPY_HINTS) {
        const value = highEntropyHint(hint, id)
        if (value !== null) expect(h[hint] === value, `${where}: ${hint} ${h[hint] ?? 'missing'} (expected ${value})`)
      }
    }
  }
  if (report.popup && 'error' in report.popup) problems.push(`popup: ${report.popup.error}`)
  else realm('popup', report.popup as Signals | undefined, { document: true, top: true })
  return problems
}

export const checks: SmokeCheck[] = [
  {
    name: 'identity: a tab, iframe, workers, popup, agent tab, custom languages and a second profile look like stock Chromium',
    async run(ctx) {
      const report = await measureAll(ctx)
      write(report)
      const problems = identityProblems(report)
      assert(problems.length === 0, `${problems.length} identity difference(s): ${problems.slice(0, 6).join('; ')}`)
    },
  },
  // The chrome surface, and Google's sign-in presenting Chrome (chromeSurface.ts).
  ...chromeSurfaceChecks,
  // Sign-in compatibility mode, the Experiments fallback: Google's sign-in pages present Firefox (signInIdentity.ts).
  ...signInModeChecks,
]

export const shots: ShotSpec[] = []
