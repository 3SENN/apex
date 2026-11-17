/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IncomingMessage } from 'node:http'
import { BrowserWindow, webContents as allWebContents, type WebContents } from 'electron'
import { signInIdentityFor } from '@shared/signInHosts'
import { gestures } from '../popupBlocker'
import { assert, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { Tab } from '../tabs'
import { browserUserAgent, identity, lowEntropyHints } from '../userAgent'
import { SMOKE_SIGNIN_HOST } from './signInIdentity'
import type { SmokeCheck, SmokeContext } from './types'

// The chrome surface and Google's Chrome identity, end to end on the smoke
// server: a page whose first inline <head> script reads window.chrome, on an
// ordinary host and on the test host signInHosts.ts counts as Google's
// sign-in (ATELIER_SMOKE_SIGNIN_HOSTS), in a tab, a same-origin iframe, a
// cross-origin iframe, an about:blank iframe the page adds, and a
// window.open popup. Each sees chrome.app, chrome.runtime, chrome.csi and
// chrome.loadTimes before any page script runs, reading as native code; the
// Google host gets Chrome's User-Agent (not Firefox's) and the matching client
// hints on every request; top-level pages have a window around them.
// ATELIER_SMOKE_SURFACE_OUT=<file> writes what was measured as JSON.

interface Head {
  type: string
  keys: string[]
  app: boolean
  runtime: boolean
  native: boolean
  loadTimes: string[]
  csi: string[]
  ua: string
  brands: string[] | null
  outer: [number, number]
  /** Scripts in the document when the head script ran: 1 means it was the first. */
  scripts: number
}
interface Report {
  url: string
  head: Head
  frames: Record<string, Head>
  blank: { keys: string[]; native: boolean } | null
  opener: boolean
  ua: string
  outer: [number, number]
  echo: Seen
}
interface Seen {
  ua: string
  hints: Record<string, string>
}

const HEAD_SCRIPT = `<script>(function () {
  var c = window.chrome
  var ts = Function.prototype.toString
  var nat = function (f) { try { return typeof f === 'function' && /\\{\\s*\\[native code\\]\\s*\\}$/.test(ts.call(f)) } catch (e) { return false } }
  window.__head = {
    type: typeof c,
    keys: c ? Object.keys(c) : [],
    app: !!(c && c.app && c.app.isInstalled === false && c.app.InstallState && c.app.RunningState),
    runtime: !!(c && c.runtime && typeof c.runtime.sendMessage === 'function' && typeof c.runtime.connect === 'function' && c.runtime.PlatformOs),
    native: !!(c && nat(c.loadTimes) && nat(c.csi) && c.app && nat(c.app.getDetails) && c.runtime && nat(c.runtime.connect)),
    loadTimes: c && typeof c.loadTimes === 'function' ? Object.keys(c.loadTimes()) : [],
    csi: c && typeof c.csi === 'function' ? Object.keys(c.csi()) : [],
    ua: navigator.userAgent,
    brands: navigator.userAgentData ? navigator.userAgentData.brands.map(function (b) { return b.brand + '/' + b.version }) : null,
    outer: [outerWidth, outerHeight],
    scripts: document.scripts.length,
  }
})()</script>`

const pageHtml = (ctx: string, otherOrigin: string): string => `<!doctype html><html><head><meta charset="utf-8">${HEAD_SCRIPT}
<title>Surface ${ctx}</title>
<script>window.__frames = {}; addEventListener('message', function (e) { if (e.data && e.data.surfaceFrame) window.__frames[e.data.surfaceFrame] = e.data.head })</script></head>
<body style="font:14px system-ui;padding:24px"><h1>Chrome surface ${ctx}</h1>
<iframe src="/surface/frame?ctx=${ctx}&as=same" style="width:200px;height:60px"></iframe>
<iframe src="${otherOrigin}/surface/frame?ctx=${ctx}&as=cross" style="width:200px;height:60px"></iframe>
<script>
(function () {
  var f = document.createElement('iframe')
  document.body.appendChild(f)
  var w = f.contentWindow
  var c = w.chrome
  var native = false
  try { native = /\\[native code\\]/.test(w.Function.prototype.toString.call(c.loadTimes)) && /^function getDetails\\(\\)/.test(w.Function.prototype.toString.call(c.app.getDetails)) } catch (e) {}
  window.__blank = { keys: c ? Object.keys(c) : [], native: native }
})()
window.__surface = async function () {
  return {
    url: location.href,
    head: window.__head,
    frames: window.__frames,
    blank: window.__blank,
    opener: Boolean(window.opener),
    ua: navigator.userAgent,
    outer: [outerWidth, outerHeight],
    echo: await fetch('/surface/echo?ctx=${ctx}').then(function (r) { return r.json() }),
  }
}
</script></body></html>`

const frameHtml = (as: string): string => `<!doctype html><html><head><meta charset="utf-8">${HEAD_SCRIPT}</head><body>frame
<script>parent.postMessage({ surfaceFrame: ${JSON.stringify(as)}, head: window.__head }, '*')</script></body></html>`

const seen = new Map<string, Seen[]>()
const pick = (req: IncomingMessage): Seen => {
  const hints: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('sec-ch-') && v !== undefined) hints[k] = Array.isArray(v) ? v.join(', ') : v
  return { ua: String(req.headers['user-agent'] ?? ''), hints }
}
const record = (key: string, req: IncomingMessage): void => {
  const list = seen.get(key) ?? []
  list.push(pick(req))
  seen.set(key, list)
}

function routes(ctx: SmokeContext, origins: { normal: string; signIn: string }): void {
  const s = ctx.server
  s.route('/surface/page', (req, res, url) => {
    const name = url.searchParams.get('ctx') ?? '?'
    record(`${name}:document`, req)
    const host = req.headers.host ?? ''
    const other = host.startsWith(SMOKE_SIGNIN_HOST) ? origins.normal : origins.signIn
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(pageHtml(name, other))
  })
  s.route('/surface/frame', (req, res, url) => {
    const as = url.searchParams.get('as') ?? '?'
    record(`${url.searchParams.get('ctx') ?? '?'}:frame-${as}`, req)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(frameHtml(as))
  })
  s.route('/surface/echo', (req, res, url) => {
    record(`${url.searchParams.get('ctx') ?? '?'}:fetch`, req)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(pick(req)))
  })
}

const read = (wc: WebContents): Promise<Report> => wc.executeJavaScript('window.__surface()', true) as Promise<Report>

async function landed(wc: WebContents, name: string, what: string): Promise<Report> {
  await waitForPage(wc, what, 10000, (at) => at.includes('/surface/page') && at.includes(`ctx=${name}`))
  await waitFor(() => wc.executeJavaScript('typeof window.__surface === "function" && Object.keys(window.__frames).length === 2').catch(() => false), 8000, `${what}: its frames`)
  return read(wc)
}

const KEYS = ['loadTimes', 'csi', 'app', 'runtime']
const LOAD_TIMES = ['requestTime', 'startLoadTime', 'commitLoadTime', 'finishDocumentLoadTime', 'finishLoadTime', 'firstPaintTime', 'firstPaintAfterLoadTime', 'navigationType', 'wasFetchedViaSpdy', 'wasNpnNegotiated', 'npnNegotiatedProtocol', 'wasAlternateProtocolAvailable', 'connectionInfo']
const CSI = ['startE', 'onloadT', 'pageT', 'tran']

/** What one realm saw before its own scripts ran, against stock Chrome. */
function checkHead(problems: string[], where: string, h: Head | undefined, opts: { top: boolean }): void {
  const expect = (ok: unknown, what: string): void => void (ok || problems.push(`${where}: ${what}`))
  if (!h) return void problems.push(`${where}: not measured`)
  expect(h.scripts === 1, `the head script was not the first (${h.scripts} scripts)`)
  expect(h.type === 'object' && JSON.stringify(h.keys) === JSON.stringify(KEYS), `window.chrome before page scripts: ${h.type} ${JSON.stringify(h.keys)}`)
  expect(h.app && h.runtime, `chrome.app ${h.app}, chrome.runtime ${h.runtime}`)
  expect(h.native, 'a chrome function does not read as native code')
  expect(JSON.stringify(h.loadTimes) === JSON.stringify(LOAD_TIMES) && JSON.stringify(h.csi) === JSON.stringify(CSI), `loadTimes() ${JSON.stringify(h.loadTimes)}, csi() ${JSON.stringify(h.csi)}`)
  expect(h.ua === browserUserAgent() && !/firefox/i.test(h.ua), `navigator.userAgent ${h.ua}`)
  expect(JSON.stringify(h.brands) === JSON.stringify(identity().brands.map((b) => `${b.brand}/${b.version}`)), `userAgentData brands ${JSON.stringify(h.brands)}`)
  if (opts.top) expect(h.outer[0] > 0 && h.outer[1] > 0, `outer window ${JSON.stringify(h.outer)} as the head script ran`)
}

function checkReport(problems: string[], name: string, r: Report, opts: { popup?: boolean } = {}): void {
  const expect = (ok: unknown, what: string): void => void (ok || problems.push(`${name}: ${what}`))
  checkHead(problems, `${name} page`, r.head, { top: true })
  checkHead(problems, `${name} same-origin iframe`, r.frames.same, { top: false })
  checkHead(problems, `${name} cross-origin iframe`, r.frames.cross, { top: false })
  expect(r.blank && JSON.stringify(r.blank.keys) === JSON.stringify(KEYS) && r.blank.native, `about:blank iframe: ${JSON.stringify(r.blank)}`)
  expect(r.outer[0] > 0 && r.outer[1] > 0, `outer window ${JSON.stringify(r.outer)}`)
  expect(r.ua === browserUserAgent(), `navigator.userAgent ${r.ua}`)
  if (opts.popup) expect(r.opener, 'window.opener is gone')
  // Chrome's identity on every request: its User-Agent and the low-entropy client hints that go with it.
  const low = lowEntropyHints(identity())
  const requests = [...seen].filter(([k]) => k.startsWith(`${name}:`))
  expect(requests.some(([k]) => k.endsWith(':document')) && requests.some(([k]) => k.endsWith(':fetch')), `requests seen: ${requests.map(([k]) => k).join(', ')}`)
  for (const [key, list] of requests) {
    for (const h of list) {
      expect(h.ua === browserUserAgent(), `${key} request: User-Agent ${h.ua}`)
      for (const [hint, value] of Object.entries(low)) expect(h.hints[hint] === value, `${key} request: ${hint} ${h.hints[hint] ?? 'missing'} (expected ${value})`)
    }
  }
}

function closeTab(tabs: { find(id: string): Tab | undefined; close(id: string): void }, tab: Tab | undefined): void {
  if (tab && tabs.find(tab.id) && !tab.view.webContents.isDestroyed()) tabs.close(tab.id)
}

async function run(ctx: SmokeContext): Promise<void> {
  const port = new URL(ctx.server.http).port
  const normal = ctx.server.http
  const signIn = `http://${SMOKE_SIGNIN_HOST}:${port}`
  assert(signInIdentityFor(`${signIn}/`) === 'chromium', `Google's sign-in identity is ${signInIdentityFor(`${signIn}/`)} here, not Chrome's`)
  seen.clear()
  routes(ctx, { normal, signIn })
  const problems: string[] = []
  const reports: Record<string, Report> = {}

  const tab = ctx.tabs.create(`${normal}/surface/page?ctx=plain`, { activate: true })
  let google: Tab | undefined
  try {
    const wc = tab.view.webContents
    reports.plain = await landed(wc, 'plain', 'the ordinary page')
    checkReport(problems, 'plain', reports.plain)

    // window.open('') hands the page an about:blank popup at once: its window.chrome is there too.
    const openedBefore = new Set(allWebContents.getAllWebContents().map((w) => w.id))
    gestures.note(wc.id)
    const blankPopup = (await wc.executeJavaScript(
      `(() => { const w = window.open('', 'surface-blank', 'popup,width=320,height=320'); const c = w && w.chrome; const keys = c ? Object.keys(c) : null; if (w) w.close(); return keys })()`,
      true,
    )) as string[] | null
    if (JSON.stringify(blankPopup) !== JSON.stringify(KEYS)) problems.push(`window.open('') popup: window.chrome ${JSON.stringify(blankPopup)}`)
    await waitFor(() => allWebContents.getAllWebContents().every((w) => openedBefore.has(w.id) || w.isDestroyed() || !w.getURL().startsWith('about:blank')), 4000, 'the about:blank popup to close').catch(() => undefined)

    // Google's sign-in host, typed into the address bar.
    google = ctx.tabs.create(`${signIn}/surface/page?ctx=google`, { activate: true })
    reports.google = await landed(google.view.webContents, 'google', 'the Google sign-in page')
    checkReport(problems, 'google', reports.google)
    if (google.view.webContents.debugger.isAttached()) problems.push('google: a debugger is attached to the sign-in page')

    // A site's "Sign in with Google" popup (window.open with a click), from the ordinary page.
    const before = new Set(allWebContents.getAllWebContents().map((w) => w.id))
    gestures.note(wc.id)
    await wc.executeJavaScript(`window.open(${JSON.stringify(`${signIn}/surface/page?ctx=popup`)}, 'surface-popup', 'popup,width=480,height=600'); true`, true)
    let popup: WebContents | undefined
    await waitFor(() => {
      popup = allWebContents.getAllWebContents().find((w) => !before.has(w.id) && !w.isDestroyed() && w.getURL().includes('ctx=popup'))
      return Boolean(popup)
    }, 8000, 'the sign-in popup')
    assert(popup, 'the sign-in popup')
    try {
      reports.popup = await landed(popup, 'popup', 'the sign-in popup page')
      checkReport(problems, 'popup', reports.popup, { popup: true })
      if (popup.debugger.isAttached()) problems.push('popup: a debugger is attached to the sign-in page')
    } finally {
      BrowserWindow.fromWebContents(popup)?.close()
    }
  } finally {
    closeTab(ctx.tabs, tab)
    closeTab(ctx.tabs, google)
  }
  const out = process.env.ATELIER_SMOKE_SURFACE_OUT
  if (out) (await import('node:fs')).writeFileSync(out, JSON.stringify({ reports, requests: Object.fromEntries(seen) }, null, 2))
  assert(problems.length === 0, `${problems.length} chrome surface problem(s): ${problems.slice(0, 6).join('; ')}`)
}

export const checks: SmokeCheck[] = [
  {
    name: 'chrome surface: window.chrome before page scripts in tabs, iframes and a popup; Google sign-in presents Chrome',
    run,
  },
]
