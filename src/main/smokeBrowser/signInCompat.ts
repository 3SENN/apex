/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { webContents as allWebContents, type WebContents } from 'electron'
import { gestures } from '../popupBlocker'
import { popups } from '../popups'
import { assert, sleep, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { Tab } from '../tabs'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// Sign-in compatibility: the browser mechanics "Sign in with …" flows rely
// on, measured on the local smoke server. 127.0.0.1 plays the site and
// localhost the provider (two sites on one port). Checked: an OAuth popup on
// the provider's origin posting a token back and closing, named-window reuse,
// noopener and noreferrer, a feature-less window.open, the full-page redirect
// and form_post flows, FedCM's feature detection, WebAuthn's feature detection
// and how fast its calls settle, and a provider iframe's cookies and Storage
// Access API. ATELIER_SMOKE_SIGNIN_OUT=<file> writes everything measured as JSON.

const TOKEN = 'tok-5e1f'
/** A sign-in provider's host for the cookie checks: *.localhost is loopback, and ATELIER_SMOKE_SIGNIN_HOSTS makes it Microsoft's in the registry. */
const IDP_HOST = 'idp.localhost'

const SITE = `<!doctype html><html><head><title>Site</title></head><body><h1>Site</h1><script>
window.__msgs = []
addEventListener('message', (e) => { window.__msgs.push({ origin: e.origin, data: e.data }) })
window.__open = (url, name, features) => { const w = window.open(url, name, features); (window.__wins ||= []).push(w); return w === null ? 'null' : 'window' }
</script></body></html>`

const POPUP = `<!doctype html><html><head><title>Provider</title></head><body><h1>Provider</h1><script>
const q = new URLSearchParams(location.search)
window.__report = { opener: window.opener !== null, name: window.name, referrer: document.referrer, step: q.get('step') }
if (window.opener && q.get('post') === '1') window.opener.postMessage({ token: '${TOKEN}', step: q.get('step'), name: window.name }, q.get('origin') || '*')
if (q.get('close') === '1') setTimeout(() => window.close(), 100)
</script></body></html>`

const WIDGET = `<!doctype html><html><head><title>Widget</title></head><body>widget<script>
window.__widget = { cookie: document.cookie }
</script></body></html>`

const SETTLE = `async (label, fn, ms) => {
  const t0 = performance.now()
  let timer
  const pending = new Promise((r) => { timer = setTimeout(() => r({ state: 'pending' }), ms) })
  const out = await Promise.race([
    Promise.resolve().then(fn).then((v) => ({ state: 'resolved', value: v === null || typeof v !== 'object' ? v : (v.constructor && v.constructor.name) || 'object' }), (e) => ({ state: 'rejected', name: e && e.name, message: String(e && e.message).slice(0, 120) })),
    pending,
  ])
  clearTimeout(timer)
  out.ms = Math.round(performance.now() - t0)
  return out
}`

interface Settled {
  state: 'resolved' | 'rejected' | 'pending'
  value?: unknown
  name?: string
  message?: string
  ms: number
}

interface Report {
  popup?: Record<string, unknown>
  named?: Record<string, unknown>
  noopener?: Record<string, unknown>
  noreferrer?: Record<string, unknown>
  plainOpen?: Record<string, unknown>
  redirect?: Record<string, unknown>
  formPost?: Record<string, unknown>
  fedcm?: Record<string, unknown>
  webauthn?: Record<string, unknown>
  storage?: Record<string, unknown>
  preload?: Record<string, unknown>
}

function cookieOf(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie ?? ''
  for (const part of raw.split(/;\s*/)) {
    const [k, ...v] = part.split('=')
    if (k === name) return v.join('=')
  }
  return null
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => resolve(body))
  })
}

const html = (body: string): [number, Record<string, string>, string] => [200, { 'content-type': 'text/html; charset=utf-8' }, body]

let routed = false
/** The two sites: 127.0.0.1 is the site, localhost the provider. */
function origins(ctx: SmokeContext): { site: string; provider: string } {
  const site = ctx.server.http
  const provider = site.replace('127.0.0.1', 'localhost')
  if (!routed) {
    routed = true
    const send = (res: import('node:http').ServerResponse, [status, headers, body]: [number, Record<string, string>, string]): void => {
      res.writeHead(status, headers).end(body)
    }
    ctx.server.route('/signin/site', (_req, res) => send(res, html(SITE)))
    ctx.server.route('/signin/popup', (_req, res) => send(res, html(POPUP)))
    // The redirect flow: the site keeps its state in a Lax cookie, the provider sends the code back.
    ctx.server.route('/signin/start', (_req, res, url) => {
      const mode = url.searchParams.get('mode') === 'form_post' ? 'form_post' : 'query'
      const back = encodeURIComponent(`${site}/signin/callback`)
      res.writeHead(302, { location: `${provider}/signin/authorize?response_mode=${mode}&state=s-77&redirect_uri=${back}`, 'set-cookie': 'oauth_state=s-77; Path=/; SameSite=Lax; HttpOnly' }).end()
    })
    ctx.server.route('/signin/authorize', (_req, res, url) => {
      const back = url.searchParams.get('redirect_uri') ?? ''
      const state = url.searchParams.get('state') ?? ''
      if (url.searchParams.get('response_mode') === 'form_post') {
        send(res, html(`<!doctype html><title>Posting</title><form method="post" action="${back}"><input type="hidden" name="code" value="c-42"><input type="hidden" name="state" value="${state}"></form><script>document.forms[0].submit()</script>`))
        return
      }
      res.writeHead(302, { location: `${back}?code=c-42&state=${encodeURIComponent(state)}` }).end()
    })
    ctx.server.route('/signin/callback', async (req, res, url) => {
      const form = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : url.searchParams
      const result = { method: req.method, code: form.get('code'), state: form.get('state'), cookie: cookieOf(req, 'oauth_state') }
      send(res, html(`<!doctype html><title>Callback</title><script>window.__callback = ${JSON.stringify(result)}</script>`))
    })
    // Third-party cookies: the provider sets a SameSite=None cookie as a top-level page, then is framed by the site.
    ctx.server.route('/signin/provider-login', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sid=p-1; Path=/; SameSite=None; Secure' }).end('<!doctype html><title>Signed in</title>signed in')
    })
    ctx.server.route('/signin/widget', (req, res) => {
      widgetCookies.push(cookieOf(req, 'sid'))
      send(res, html(WIDGET))
    })
    ctx.server.route('/signin/embed', (_req, res, url) => {
      const from = url.searchParams.get('from') === 'idp' ? provider.replace('//localhost', `//${IDP_HOST}`) : provider
      send(res, html(`<!doctype html><title>Embed</title><iframe id="w" src="${from}/signin/widget" style="width:300px;height:120px"></iframe>`))
    })
    ctx.server.route('/signin/blank', (_req, res) => send(res, html('<!doctype html><title>Blank</title>')))
  }
  return { site, provider }
}
const widgetCookies: (string | null)[] = []

async function open(ctx: SmokeContext, url: string, what: string): Promise<Tab> {
  const tab = ctx.tabs.create(url, { activate: true })
  await waitForPage(tab.view.webContents, what, 8000, (u) => u.startsWith(url.split('?')[0]!))
  return tab
}

const js = <T>(wc: WebContents, code: string, gesture = false): Promise<T> => wc.executeJavaScript(code, gesture) as Promise<T>

/** Calls window.open in the page as a click would, and returns the new webContents (if one opened). */
async function scriptedOpen(tab: Tab, url: string, name: string, features: string): Promise<{ result: string; opened: WebContents | null }> {
  const wc = tab.view.webContents
  const before = new Set(allWebContents.getAllWebContents().map((w) => w.id))
  // The popup blocker counts real input only; this stands in for the click.
  gestures.note(wc.id)
  const result = await js<string>(wc, `window.__open(${JSON.stringify(url)}, ${JSON.stringify(name)}, ${JSON.stringify(features)})`, true)
  let opened: WebContents | null = null
  await waitFor(
    () => {
      opened = allWebContents.getAllWebContents().find((w) => !before.has(w.id) && !w.isDestroyed() && w.getURL().startsWith(url.split('?')[0]!)) ?? null
      return opened !== null && !opened.isLoading()
    },
    4000,
    'the opened window',
  ).catch(() => undefined)
  return { result, opened }
}

function closeOpened(wc: WebContents | null): void {
  if (!wc || wc.isDestroyed()) return
  const popup = popups.all().find((p) => p.page === wc)
  if (popup && !popup.window.isDestroyed()) popup.window.close()
  else wc.close()
}

async function measurePopups(ctx: SmokeContext, report: Report): Promise<void> {
  const { site, provider } = origins(ctx)
  const tab = await open(ctx, `${site}/signin/site`, 'the site page')
  const wc = tab.view.webContents
  try {
    // 1. The OAuth popup: another origin, posts the token to its opener, closes itself.
    const first = await scriptedOpen(tab, `${provider}/signin/popup?step=1&post=1&close=1&origin=${encodeURIComponent(site)}`, 'atelier-oauth', 'popup,width=480,height=600')
    const popupWindow = first.opened ? popups.all().find((p) => p.page === first.opened) : undefined
    const popupInfo: Record<string, unknown> = { result: first.result, opened: Boolean(first.opened), inPopupWindow: Boolean(popupWindow), asTab: Boolean(first.opened && ctx.tabs.byWebContents(first.opened)) }
    await waitFor(() => js<boolean>(wc, `window.__msgs.length > 0`), 5000, 'the token message').catch(() => undefined)
    popupInfo.messages = await js<unknown[]>(wc, `window.__msgs`)
    await waitFor(() => js<boolean>(wc, `window.__wins[0] ? window.__wins[0].closed : false`), 5000, 'the popup to close').catch(() => undefined)
    popupInfo.openerSeesClosed = await js<boolean>(wc, `Boolean(window.__wins[0] && window.__wins[0].closed)`)
    popupInfo.webContentsGone = !first.opened || (first.opened as WebContents).isDestroyed()
    popupInfo.windowGone = !popupWindow || popupWindow.window.isDestroyed()
    report.popup = popupInfo
    await js(wc, `window.__msgs = []; window.__wins = []`)

    // 2. A named window is reused: the second open navigates the first popup.
    const named = await scriptedOpen(tab, `${provider}/signin/popup?step=1`, 'atelier-named', 'popup,width=420,height=500')
    const countBefore = allWebContents.getAllWebContents().length
    gestures.note(wc.id)
    await js(wc, `window.__open(${JSON.stringify(`${provider}/signin/popup?step=2&post=1&origin=${encodeURIComponent(site)}`)}, 'atelier-named', 'popup,width=420,height=500')`, true)
    await waitFor(() => js<boolean>(wc, `window.__msgs.some((m) => m.data && m.data.step === '2')`), 5000, 'the reused window to report').catch(() => undefined)
    report.named = {
      opened: Boolean(named.opened),
      sameReference: await js<boolean>(wc, `window.__wins.length === 2 && window.__wins[0] === window.__wins[1]`),
      newWebContents: allWebContents.getAllWebContents().length - countBefore,
      reusedUrl: named.opened && !named.opened.isDestroyed() ? named.opened.getURL().includes('step=2') : false,
      preload: named.opened && !named.opened.isDestroyed() ? await js<boolean>(named.opened, `!String(window.alert).includes('[native code]') && !String(navigator.credentials.get).includes('[native code]')`).catch(() => false) : false,
      messages: await js<unknown[]>(wc, `window.__msgs`),
    }
    closeOpened(named.opened)
    await js(wc, `window.__msgs = []; window.__wins = []`)

    // 3. noopener and noreferrer: the new window has no opener (and no referrer).
    for (const [key, feature] of [
      ['noopener', 'noopener'],
      ['noreferrer', 'noreferrer'],
    ] as const) {
      const r = await scriptedOpen(tab, `${provider}/signin/popup?step=${key}`, '_blank', `popup,width=400,height=400,${feature}`)
      const inner = r.opened ? await js<Record<string, unknown>>(r.opened, `window.__report`).catch(() => null) : null
      report[key] = { result: r.result, opened: Boolean(r.opened), inPopupWindow: Boolean(r.opened && popups.all().some((p) => p.page === r.opened)), page: inner }
      closeOpened(r.opened)
    }

    // 4. window.open without features: Chrome opens a tab that keeps its opener.
    const plain = await scriptedOpen(tab, `${provider}/signin/popup?step=plain&post=1&origin=${encodeURIComponent(site)}`, 'atelier-plain', '')
    await waitFor(() => js<boolean>(wc, `window.__msgs.length > 0`), 3000, 'the plain window message').catch(() => undefined)
    report.plainOpen = {
      result: plain.result,
      opened: Boolean(plain.opened),
      asTab: Boolean(plain.opened && ctx.tabs.byWebContents(plain.opened)),
      inPopupWindow: Boolean(plain.opened && popups.all().some((p) => p.page === plain.opened)),
      page: plain.opened ? await js<Record<string, unknown>>(plain.opened, `window.__report`).catch(() => null) : null,
      // The adopted tab runs the page preload like any tab (its main-world dialog override is in).
      preload: plain.opened ? await js<boolean>(plain.opened, `!String(window.alert).includes('[native code]')`).catch(() => false) : false,
      messages: await js<unknown[]>(wc, `window.__msgs`),
    }
    if (plain.opened) {
      const t = ctx.tabs.byWebContents(plain.opened)
      if (t) ctx.tabs.close(t.id)
      else closeOpened(plain.opened)
    }
  } finally {
    ctx.tabs.close(tab.id)
  }
}

async function measureRedirects(ctx: SmokeContext, report: Report): Promise<void> {
  const { site } = origins(ctx)
  for (const mode of ['query', 'form_post'] as const) {
    const tab = ctx.tabs.create(`${site}/signin/start?mode=${mode}`, { activate: true })
    try {
      await waitForPage(tab.view.webContents, `the ${mode} callback`, 8000, (u) => u.includes('/signin/callback'))
      const result = await waitFor(() => js<boolean>(tab.view.webContents, `Boolean(window.__callback)`), 3000, 'the callback script')
        .then(() => js<Record<string, unknown>>(tab.view.webContents, `window.__callback`))
        .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
      report[mode === 'query' ? 'redirect' : 'formPost'] = { url: tab.view.webContents.getURL().replace(site, ''), ...result }
    } finally {
      ctx.tabs.close(tab.id)
    }
  }
}

async function measureApis(ctx: SmokeContext, report: Report): Promise<void> {
  const { provider } = origins(ctx)
  // WebAuthn needs a domain for its relying party id, so these run on localhost.
  const tab = await open(ctx, `${provider}/signin/blank`, 'the WebAuthn page')
  const wc = tab.view.webContents
  const consoleLines: string[] = []
  wc.on('console-message', (e) => consoleLines.push(String((e as unknown as { message?: string }).message ?? '').slice(0, 200)))
  // Reloaded with a listener on, so a preload that fails to load says why.
  wc.on('preload-error', (_e, path, error) => consoleLines.push(`preload-error ${path}: ${error.message}`.slice(0, 300)))
  wc.reload()
  await sleep(300)
  await waitForPage(wc, 'the WebAuthn page again')
  try {
    report.preload = await js<Record<string, unknown>>(wc, `({ alertNative: String(window.alert).includes('[native code]'), getNative: String(navigator.credentials.get).includes('[native code]'), href: location.href })`)
    report.fedcm = await js<Record<string, unknown>>(
      wc,
      `(async () => {
        const settle = ${SETTLE}
        return {
          IdentityCredential: 'IdentityCredential' in window,
          IdentityProvider: 'IdentityProvider' in window,
          get: await settle('fedcm', () => navigator.credentials.get({ identity: { providers: [{ configURL: location.origin + '/signin/fedcm.json', clientId: 'smoke' }] } }), 5000),
        }
      })()`,
    )
    report.webauthn = await js<Record<string, unknown>>(
      wc,
      `(async () => {
        const settle = ${SETTLE}
        const out = { PublicKeyCredential: typeof PublicKeyCredential }
        if (typeof PublicKeyCredential !== 'function') return out
        const challenge = crypto.getRandomValues(new Uint8Array(32))
        const user = { id: new Uint8Array([7, 7, 7]), name: 'smoke@localhost', displayName: 'Smoke' }
        const base = { rp: { name: 'Smoke', id: location.hostname }, user, challenge, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 120000 }
        out.uvpaa = await settle('uvpaa', () => PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), 3000)
        out.conditional = await settle('conditional', () => PublicKeyCredential.isConditionalMediationAvailable(), 3000)
        out.capabilities = await PublicKeyCredential.getClientCapabilities().catch((e) => ({ error: e.name }))
        // On Windows every call that reaches Chromium opens Windows Security's own dialog: only the shim's answers are asked for.
        if (${JSON.stringify(process.platform === 'win32')}) {
          out.osDialog = true
          if (out.uvpaa.value === true) return out
        }
        out.createPlatform = await settle('create', () => navigator.credentials.create({ publicKey: { ...base, authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' } } }), 8000)
        out.createPasskey = await settle('create', () => navigator.credentials.create({ publicKey: { ...base, authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' } } }), 8000)
        out.getPasskey = await settle('get', () => navigator.credentials.get({ publicKey: { challenge, rpId: location.hostname, timeout: 120000, userVerification: 'preferred' } }), 8000)
        out.getHybrid = await settle('get', () => navigator.credentials.get({ publicKey: { challenge, rpId: location.hostname, timeout: 120000, allowCredentials: [{ type: 'public-key', id: new Uint8Array([1, 2, 3]), transports: ['hybrid', 'internal'] }] } }), 8000)
        const ac = new AbortController()
        const conditional = settle('conditional get', () => navigator.credentials.get({ mediation: 'conditional', signal: ac.signal, publicKey: { challenge, rpId: location.hostname } }), 4000)
        setTimeout(() => ac.abort(), 1000)
        out.getConditional = await conditional
        if (out.osDialog) return out
        // A security key could still answer this one (a second factor); abort stands in for the person giving up.
        const ab = new AbortController()
        const key = settle('security key', () => navigator.credentials.get({ signal: ab.signal, publicKey: { challenge, rpId: location.hostname, timeout: 120000, allowCredentials: [{ type: 'public-key', id: new Uint8Array([4, 5, 6]), transports: ['usb'] }] } }), 6000)
        setTimeout(() => ab.abort(), 1500)
        out.getSecurityKey = await key
        // After all of that nothing is left pending: a fresh call reaches Chromium, not "A request is already pending".
        const ac2 = new AbortController()
        const again = settle('after', () => navigator.credentials.get({ signal: ac2.signal, publicKey: { challenge, rpId: location.hostname, allowCredentials: [{ type: 'public-key', id: new Uint8Array([8, 9]) }] } }), 4000)
        setTimeout(() => ac2.abort(), 500)
        out.after = await again
        return out
      })()`,
    )
    report.preload = { ...report.preload, console: consoleLines.slice(0, 10) }
  } finally {
    ctx.tabs.close(tab.id)
  }
}

async function measureStorage(ctx: SmokeContext, report: Report): Promise<void> {
  const { site, provider } = origins(ctx)
  const idp = provider.replace('//localhost', `//${IDP_HOST}`)
  const hostsBefore = process.env.ATELIER_SMOKE_SIGNIN_HOSTS
  process.env.ATELIER_SMOKE_SIGNIN_HOSTS = [hostsBefore, `${IDP_HOST}=microsoft`].filter(Boolean).join(',')
  const before = ctx.settings.get().blockThirdPartyCookies
  try {
    // Each provider sets its session cookie as a page of its own first.
    const cookieSet: Record<string, boolean> = {}
    for (const [key, origin] of [
      ['plain', provider],
      ['idp', idp],
    ] as const) {
      const login = await open(ctx, `${origin}/signin/provider-login`, `the ${key} provider sign-in`)
      cookieSet[key] = (await login.view.webContents.session.cookies.get({ url: origin, name: 'sid' })).length > 0
      ctx.tabs.close(login.id)
    }
    const measureEmbed = async (from: 'plain' | 'idp'): Promise<Record<string, unknown>> => {
      widgetCookies.length = 0
      const frameOrigin = from === 'idp' ? idp : provider
      const tab = await open(ctx, `${site}/signin/embed?from=${from}`, 'the embedding page')
      try {
        let frame: Electron.WebFrameMain | undefined
        await waitFor(
          () => {
            frame = tab.view.webContents.mainFrame.frames.find((f) => f.url.startsWith(`${frameOrigin}/signin/widget`))
            return Boolean(frame)
          },
          5000,
          'the provider iframe',
        )
        await waitFor(() => frame!.executeJavaScript('Boolean(window.__widget)') as Promise<boolean>, 5000, 'the widget script')
        const inFrame = (await frame!.executeJavaScript(
          `(async () => {
            const settle = ${SETTLE}
            return {
              hasStorageAccess: await settle('has', () => document.hasStorageAccess(), 3000),
              requestStorageAccess: await settle('request', () => document.requestStorageAccess(), 4000),
            }
          })()`,
          true,
        )) as Record<string, unknown>
        return { requestCookie: widgetCookies[0] ?? null, ...inFrame }
      } finally {
        ctx.tabs.close(tab.id)
      }
    }
    const allowed = await measureEmbed('plain')
    ctx.settings.update({ blockThirdPartyCookies: true })
    await sleep(100)
    const blockedPlain = await measureEmbed('plain')
    const blockedProvider = await measureEmbed('idp')
    report.storage = { cookieSet, defaultBlocking: before, allowed, blockedPlain, blockedProvider }
  } finally {
    ctx.settings.update({ blockThirdPartyCookies: before })
    if (hostsBefore === undefined) delete process.env.ATELIER_SMOKE_SIGNIN_HOSTS
    else process.env.ATELIER_SMOKE_SIGNIN_HOSTS = hostsBefore
  }
}

function fastReject(r: unknown, name = 'NotAllowedError', withinMs = 3000): boolean {
  const s = r as Settled | undefined
  return Boolean(s && s.state === 'rejected' && s.name === name && s.ms <= withinMs)
}

async function measureAll(ctx: SmokeContext): Promise<Report> {
  const report: Report = {}
  await measurePopups(ctx, report)
  await measureRedirects(ctx, report)
  await measureApis(ctx, report)
  await measureStorage(ctx, report)
  const out = process.env.ATELIER_SMOKE_SIGNIN_OUT
  if (out) writeFileSync(out, JSON.stringify(report, null, 2))
  return report
}

let measured: Promise<Report> | null = null
const measure = (ctx: SmokeContext): Promise<Report> => (measured ??= measureAll(ctx))

export const checks: SmokeCheck[] = [
  {
    name: 'sign-in compat: an OAuth popup on another origin keeps its opener, posts its token back and closes',
    async run(ctx) {
      const r = await measure(ctx)
      const p = r.popup ?? {}
      const msgs = (p.messages as { origin: string; data: { token?: string } }[] | undefined) ?? []
      assert(p.inPopupWindow === true && p.asTab === false, `the popup should be a popup window: ${JSON.stringify(p)}`)
      assert(msgs.some((m) => m.data?.token === TOKEN && m.origin === origins(ctx).provider), `the opener should get the token from the provider's origin: ${JSON.stringify(msgs)}`)
      assert(p.openerSeesClosed === true && p.windowGone === true, `window.close() should close the popup and the opener see popup.closed: ${JSON.stringify(p)}`)
    },
  },
  {
    name: 'sign-in compat: named windows are reused, noopener and noreferrer are respected, a feature-less window.open keeps its opener',
    async run(ctx) {
      const r = await measure(ctx)
      const n = r.named ?? {}
      assert(n.sameReference === true && n.newWebContents === 0 && n.reusedUrl === true, `a second open with the same name should navigate the first window: ${JSON.stringify(n)}`)
      for (const key of ['noopener', 'noreferrer'] as const) {
        const o = r[key] ?? {}
        const page = (o.page ?? {}) as { opener?: boolean; referrer?: string }
        assert(o.result === 'null' && o.opened === true && page.opener === false, `${key}: window.open returns null and the window has no opener: ${JSON.stringify(o)}`)
        if (key === 'noreferrer') assert(page.referrer === '', `noreferrer sends no referrer: ${JSON.stringify(o)}`)
      }
      const plain = r.plainOpen ?? {}
      const msgs = (plain.messages as { data: { token?: string } }[] | undefined) ?? []
      assert(plain.result === 'window' && plain.asTab === true && plain.preload === true && msgs.some((m) => m.data?.token === TOKEN), `window.open(url, name) opens a tab (with the page preload) that keeps window.opener: ${JSON.stringify(plain)}`)
    },
  },
  {
    name: 'sign-in compat: full-page redirect and form_post flows come back to the site with the code and its state cookie',
    async run(ctx) {
      const r = await measure(ctx)
      const q = (r.redirect ?? {}) as { code?: string; state?: string; cookie?: string | null }
      assert(q.code === 'c-42' && q.state === 's-77' && q.cookie === 's-77', `redirect: ${JSON.stringify(r.redirect)}`)
      const f = (r.formPost ?? {}) as { method?: string; code?: string; state?: string }
      assert(f.method === 'POST' && f.code === 'c-42' && f.state === 's-77', `form_post: ${JSON.stringify(r.formPost)}`)
    },
  },
  {
    name: 'sign-in compat: FedCM is off, so Google Identity Services takes its popup or redirect flow',
    async run(ctx) {
      const r = await measure(ctx)
      const f = (r.fedcm ?? {}) as { IdentityCredential?: boolean; get?: Settled }
      assert(f.IdentityCredential === false, `'IdentityCredential' in window should be false: ${JSON.stringify(f)}`)
      assert(f.get && f.get.state !== 'pending', `an identity request should settle at once: ${JSON.stringify(f)}`)
    },
  },
  {
    name: 'sign-in compat: WebAuthn reports no platform authenticator and passkey-only calls fail fast with NotAllowedError',
    async run(ctx) {
      const r = await measure(ctx)
      const w = (r.webauthn ?? {}) as Record<string, unknown>
      const pre = r.preload ?? {}
      assert(pre.getNative === false, `the page preload's WebAuthn part is in: ${JSON.stringify(pre)}`)
      const uvpaa = w.uvpaa as Settled | undefined
      assert(w.PublicKeyCredential === 'function', `PublicKeyCredential stays (security keys): ${JSON.stringify(w)}`)
      const caps = (w.capabilities ?? {}) as Record<string, unknown>
      if (w.osDialog) {
        // Windows draws its own dialog (Windows Hello, a PIN, a security key), so a platform authenticator is real when Windows says so.
        assert(uvpaa?.state === 'resolved' && typeof uvpaa.value === 'boolean', `isUserVerifyingPlatformAuthenticatorAvailable() answers: ${JSON.stringify(uvpaa)}`)
        assert(caps.userVerifyingPlatformAuthenticator === uvpaa.value, `getClientCapabilities() agrees with it: ${JSON.stringify(caps)}`)
      } else {
        assert(uvpaa?.state === 'resolved' && uvpaa.value === false, `isUserVerifyingPlatformAuthenticatorAvailable() is false: ${JSON.stringify(uvpaa)}`)
        assert(caps.userVerifyingPlatformAuthenticator === false && caps.passkeyPlatformAuthenticator === false && caps.hybridTransport === false, `getClientCapabilities() reports no platform or phone authenticator: ${JSON.stringify(caps)}`)
      }
      assert((w.conditional as Settled | undefined)?.value === false, `isConditionalMediationAvailable() is false (no passkey autofill): ${JSON.stringify(w.conditional)}`)
      // With Windows Hello set up these calls would open its dialog, so they weren't made.
      if (w.osDialog && uvpaa?.value === true) return
      for (const key of ['createPlatform', 'createPasskey', 'getPasskey', 'getHybrid']) assert(fastReject(w[key]), `${key} rejects with NotAllowedError within 3s: ${JSON.stringify(w[key])}`)
      for (const key of w.osDialog ? ['getConditional'] : ['getConditional', 'getSecurityKey', 'after']) assert(fastReject(w[key], 'AbortError', 3500), `${key} (a security key could answer) waits, and settles once aborted: ${JSON.stringify(w[key])}`)
    },
  },
  {
    name: 'sign-in compat: a provider iframe keeps its cookies (blocking third-party cookies exempts sign-in providers) and the Storage Access API answers',
    async run(ctx) {
      const r = await measure(ctx)
      const s = (r.storage ?? {}) as { cookieSet?: Record<string, boolean>; defaultBlocking?: boolean; allowed?: Record<string, unknown>; blockedPlain?: Record<string, unknown>; blockedProvider?: Record<string, unknown> }
      assert(s.cookieSet?.plain === true && s.cookieSet?.idp === true, `the providers' SameSite=None cookies were set: ${JSON.stringify(s.cookieSet)}`)
      assert(s.defaultBlocking === false, 'third-party cookies are allowed by default')
      const a = s.allowed ?? {}
      assert(a.requestCookie === 'p-1', `by default the iframe gets its cookie: ${JSON.stringify(a)}`)
      const has = a.hasStorageAccess as Settled | undefined
      const req = a.requestStorageAccess as Settled | undefined
      assert(has?.state === 'resolved' && has.value === true && req?.state === 'resolved', `hasStorageAccess() is true and requestStorageAccess() resolves: ${JSON.stringify(a)}`)
      assert((s.blockedPlain ?? {}).requestCookie === null, `with blocking on, an ordinary third party loses its cookie: ${JSON.stringify(s.blockedPlain)}`)
      const p = s.blockedProvider ?? {}
      assert(p.requestCookie === 'p-1' && (p.requestStorageAccess as Settled | undefined)?.state === 'resolved', `with blocking on, a sign-in provider keeps its cookie and storage access: ${JSON.stringify(p)}`)
    },
  },
]

export const shots: ShotSpec[] = []
