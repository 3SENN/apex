/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IncomingMessage } from 'node:http'
import { BrowserWindow, webContents as allWebContents, type WebContents } from 'electron'
import { signInIdentityFor } from '@shared/signInHosts'
import { gestures } from '../popupBlocker'
import { firefoxUserAgent, GOOGLE_FIREFOX_FLAG } from '../signInIdentity'
import { assert, sleep, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { Tab } from '../tabs'
import { browserUserAgent, identity } from '../userAgent'
import type { SmokeCheck, SmokeContext } from './types'

// Sign-in compatibility mode, end to end on the smoke server, with
// Experiments' "Google sign-in: present as Firefox" turned on for the check
// (off, Google presents Chrome: chromeSurface.ts checks that): a page under a
// test host that signInHosts.ts counts as Google's sign-in (APEX_SMOKE_SIGNIN_HOSTS,
// set for smoke runs in index.ts; *.localhost resolves to this machine) gets
// Firefox's User-Agent on every request and in navigator, with no client hints;
// reached typed, through a redirect, by a link and in a popup. The tab is
// Chromium again on the next page, and a second tab never changes.
// APEX_SMOKE_SIGNIN_MODE_OUT=<file> writes what was measured as JSON.

/** The test sign-in host (index.ts maps it to Google under APEX_SMOKE). */
export const SMOKE_SIGNIN_HOST = 'accounts.google.localhost'

interface Seen {
  ua: string
  hints: string[]
}
interface PageReport {
  url: string
  /** navigator.userAgent as the page's first script saw it, and now. */
  first: string
  ua: string
  brands: string[] | null
  opener: boolean
  echo: Seen
}

const seen = new Map<string, Seen[]>()
const pick = (req: IncomingMessage): Seen => ({
  ua: String(req.headers['user-agent'] ?? ''),
  hints: Object.keys(req.headers).filter((k) => k.startsWith('sec-ch-')),
})
const record = (key: string, req: IncomingMessage): void => {
  const list = seen.get(key) ?? []
  list.push(pick(req))
  seen.set(key, list)
}

const pageHtml = (ctx: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in ${ctx}</title>
<script>window.__first = navigator.userAgent</script></head><body style="font:14px system-ui;padding:24px"><h1>Sign-in identity ${ctx}</h1>
<script>
window.__signin = async () => ({
  url: location.href,
  first: window.__first,
  ua: navigator.userAgent,
  brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand) : null,
  opener: Boolean(window.opener),
  echo: await fetch('/signin/echo?ctx=${ctx}').then((r) => r.json()),
})
</script></body></html>`

function routes(ctx: SmokeContext, signInBase: string): void {
  const s = ctx.server
  s.route('/signin/page', (req, res, url) => {
    const name = url.searchParams.get('ctx') ?? '?'
    record(`${name}:document`, req)
    // A sign-in host asking for every UA hint: nothing answers it.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'accept-ch': 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Platform-Version' }).end(pageHtml(name))
  })
  s.route('/signin/echo', (req, res, url) => {
    record(`${url.searchParams.get('ctx') ?? '?'}:fetch`, req)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(pick(req)))
  })
  // Another page of the same site sending the person on to sign-in, as mail.google.com does when signed out.
  s.route('/signin/redirect', (req, res, url) => {
    record(`${url.searchParams.get('ctx') ?? '?'}:redirect`, req)
    res.writeHead(302, { location: `${signInBase}/signin/page?ctx=${url.searchParams.get('ctx') ?? '?'}`, 'cache-control': 'no-store' }).end()
  })
}

const read = (wc: WebContents): Promise<PageReport> => wc.executeJavaScript('window.__signin()', true) as Promise<PageReport>

async function landed(wc: WebContents, ctx: string, what: string): Promise<PageReport> {
  await waitForPage(wc, what, 10000, (at) => at.includes('/signin/page') && at.includes(`ctx=${ctx}`))
  await waitFor(() => wc.executeJavaScript('typeof window.__signin === "function"').catch(() => false), 5000, `${what} script`)
  return read(wc)
}

/** Navigates the page itself (a link click, location.href): renderer-initiated, as sites do. */
const follow = (wc: WebContents, url: string): Promise<unknown> => wc.executeJavaScript(`location.href = ${JSON.stringify(url)}; true`, true)

interface Problems {
  list: string[]
  expect(ok: unknown, what: string): void
}

function problems(): Problems {
  const list: string[] = []
  return { list, expect: (ok, what) => void (ok || list.push(what)) }
}

function checkFirefox(p: Problems, name: string, r: PageReport, requests: string[]): void {
  const ff = firefoxUserAgent()
  p.expect(r.first === ff, `${name}: the page's first script saw ${r.first}`)
  p.expect(r.ua === ff, `${name}: navigator.userAgent ${r.ua}`)
  p.expect(r.echo.ua === ff && r.echo.hints.length === 0, `${name}: its fetch sent ${r.echo.ua} with ${JSON.stringify(r.echo.hints)}`)
  for (const key of requests) {
    const list = seen.get(`${name}:${key}`) ?? []
    p.expect(list.length > 0, `${name}: no ${key} request reached the server`)
    for (const h of list) p.expect(h.ua === ff && h.hints.length === 0, `${name} ${key} request: User-Agent ${h.ua}, hints ${JSON.stringify(h.hints)}`)
  }
  // Exactly one load of the page: switching the identity must not reload it.
  p.expect((seen.get(`${name}:document`) ?? []).length === 1, `${name}: the document was requested ${(seen.get(`${name}:document`) ?? []).length} times`)
}

function checkChromium(p: Problems, name: string, r: PageReport): void {
  const ua = browserUserAgent()
  const brands = identity().brands.map((b) => b.brand)
  p.expect(r.first === ua && r.ua === ua, `${name}: navigator.userAgent ${r.first} / ${r.ua}`)
  p.expect(JSON.stringify(r.brands) === JSON.stringify(brands), `${name}: userAgentData brands ${JSON.stringify(r.brands)}`)
  p.expect(r.echo.ua === ua && r.echo.hints.includes('sec-ch-ua'), `${name}: its fetch sent ${r.echo.ua} with ${JSON.stringify(r.echo.hints)}`)
  for (const h of seen.get(`${name}:document`) ?? []) p.expect(h.ua === ua && h.hints.includes('sec-ch-ua'), `${name} document request: User-Agent ${h.ua}, hints ${JSON.stringify(h.hints)}`)
}

function closeTab(tabs: { find(id: string): Tab | undefined; close(id: string): void }, tab: Tab | undefined): void {
  if (tab && tabs.find(tab.id) && !tab.view.webContents.isDestroyed()) tabs.close(tab.id)
}

/** Runs `body` with the experiment on, through the setting (as apex://flags sets it), and back after. */
async function withFirefoxExperiment<T>(ctx: SmokeContext, body: () => Promise<T>): Promise<T> {
  const before = ctx.settings.get().flags ?? {}
  ctx.settings.update({ flags: { ...before, [GOOGLE_FIREFOX_FLAG]: 'on' } })
  try {
    return await body()
  } finally {
    ctx.settings.update({ flags: before })
  }
}

async function run(ctx: SmokeContext): Promise<string> {
  const port = new URL(ctx.server.http).port
  const normal = ctx.server.http
  const signIn = `http://${SMOKE_SIGNIN_HOST}:${port}`
  assert(signInIdentityFor(`${signIn}/`) === 'firefox', `${SMOKE_SIGNIN_HOST} is not a Google sign-in host here (APEX_SMOKE_SIGNIN_HOSTS=${process.env.APEX_SMOKE_SIGNIN_HOSTS ?? ''})`)
  seen.clear()
  routes(ctx, signIn)
  const p = problems()
  const reports: Record<string, PageReport> = {}

  const tab = ctx.tabs.create(`${normal}/signin/page?ctx=start`, { activate: true })
  const other = ctx.tabs.create(`${normal}/signin/page?ctx=other`, { activate: false })
  try {
    const wc = tab.view.webContents
    reports.start = await landed(wc, 'start', 'the first ordinary page')
    checkChromium(p, 'start', reports.start)

    // 1. Typed into the address bar (browser-initiated): the very first request is Firefox already.
    void wc.loadURL(`${signIn}/signin/page?ctx=typed`).catch(() => undefined)
    reports.typed = await landed(wc, 'typed', 'the typed sign-in page')
    checkFirefox(p, 'typed', reports.typed, ['document', 'fetch'])

    // Meanwhile the other tab is untouched.
    reports.other = await landed(other.view.webContents, 'other', 'the second tab')
    checkChromium(p, 'other', reports.other)

    // 2. Off to the next page by a link: Chromium again, from its first request.
    await follow(wc, `${normal}/signin/page?ctx=after-typed`)
    reports['after-typed'] = await landed(wc, 'after-typed', 'the page after sign-in')
    checkChromium(p, 'after-typed', reports['after-typed'])

    // 3. Sent on to sign-in by a redirect from an ordinary page of the site.
    await follow(wc, `${normal}/signin/redirect?ctx=redirected`)
    reports.redirected = await landed(wc, 'redirected', 'the redirected sign-in page')
    checkFirefox(p, 'redirected', reports.redirected, ['document', 'fetch'])
    for (const h of seen.get('redirected:redirect') ?? []) p.expect(h.ua === browserUserAgent(), `the ordinary page that redirected went out as ${h.ua}`)

    // 4. Back by typing an ordinary address (browser-initiated).
    void wc.loadURL(`${normal}/signin/page?ctx=back`).catch(() => undefined)
    reports.back = await landed(wc, 'back', 'the ordinary page after the redirect')
    checkChromium(p, 'back', reports.back)

    // 5. A site's "Sign in with Google" popup (window.open with a click).
    const before = new Set(allWebContents.getAllWebContents().map((w) => w.id))
    gestures.note(wc.id)
    await wc.executeJavaScript(`window.open(${JSON.stringify(`${signIn}/signin/page?ctx=popup`)}, 'signin-popup', 'popup,width=480,height=600'); true`, true)
    let popup: WebContents | undefined
    await waitFor(() => {
      popup = allWebContents.getAllWebContents().find((w) => !before.has(w.id) && !w.isDestroyed() && w.getURL().includes('ctx=popup'))
      return Boolean(popup)
    }, 8000, 'the sign-in popup')
    assert(popup, 'the sign-in popup')
    try {
      reports.popup = await landed(popup, 'popup', 'the sign-in popup page')
      checkFirefox(p, 'popup', reports.popup, ['document', 'fetch'])
      p.expect(reports.popup.opener, 'popup: window.opener is gone')
      // The sign-in flow's next page inside the popup.
      await follow(popup, `${signIn}/signin/page?ctx=popup-next`)
      reports['popup-next'] = await landed(popup, 'popup-next', "the popup's next sign-in page")
      checkFirefox(p, 'popup-next', reports['popup-next'], ['document', 'fetch'])
    } finally {
      BrowserWindow.fromWebContents(popup)?.close()
    }
    await sleep(100)
    // The opener stayed Chromium throughout.
    const opener = await read(wc)
    p.expect(opener.ua === browserUserAgent(), `the popup's opener: navigator.userAgent ${opener.ua}`)
  } finally {
    closeTab(ctx.tabs, tab)
    closeTab(ctx.tabs, other)
  }
  const out = process.env.APEX_SMOKE_SIGNIN_MODE_OUT
  if (out) (await import('node:fs')).writeFileSync(out, JSON.stringify({ reports, requests: Object.fromEntries(seen) }, null, 2))
  assert(p.list.length === 0, `${p.list.length} sign-in identity problem(s): ${p.list.slice(0, 5).join('; ')}`)
  return `Firefox on ${Object.keys(reports).filter((k) => reports[k]?.ua === firefoxUserAgent()).join(', ')}; Chromium elsewhere`
}

export const checks: SmokeCheck[] = [
  {
    name: 'sign-in mode (experiment on): Google sign-in pages present Firefox (typed, redirected, popup), Chromium again after, other tabs unchanged',
    async run(ctx) {
      await withFirefoxExperiment(ctx, () => run(ctx))
      // Off again: Google's sign-in presents Chrome.
      assert(signInIdentityFor(`http://${SMOKE_SIGNIN_HOST}:${new URL(ctx.server.http).port}/`) === 'chromium', 'the experiment stayed on after the check')
    },
  },
]
