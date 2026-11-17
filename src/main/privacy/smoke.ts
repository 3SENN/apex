/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer, type AddressInfo } from 'node:net'
import { webContents as allWebContents, type WebContents } from 'electron'
import type { PrivacyExceptions, PrivacySummary } from '@shared/privacyPack'
import { assert, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { SmokeGroup, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import type { Tab } from '../tabs'
import { sitesSmoke } from '../features/sites'
import { webRequestHooks } from '../webRequest'

// The privacy pack end to end (APEX_SMOKE_ONLY=PRIVACY). Nothing leaves the
// machine: the "insecure" site is a public-looking name that a smoke-only mux
// hook answers before any lookup. Its http address goes to the fixture
// server; its https address goes to a local port nothing listens on, so the
// upgrade is refused at once and Apex's page appears.
// - HTTPS-First: the fixture server (127.0.0.1) is never upgraded; the
//   insecure site shows "This site doesn't support a secure connection" at its
//   http address, and Continue to site loads it over http and remembers it.
// - Cookie banners: a consent banner the page adds late is hidden by the user
//   stylesheet and refused through its own Reject button (Accept untouched),
//   the site info summary says so, and the per-site switch shows it again.
//   TrustArc's newer popup is declined in its shadow root, and the page takes clicks again.
// - Global Privacy Control: the header and navigator.globalPrivacyControl
//   agree in the page and in its iframe.

const INSECURE_HOST = 'insecure.apex-smoke.net'

async function refusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

const js = <T>(wc: WebContents, code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>

function close(ctx: SmokeContext, tab: Tab | null): void {
  if (tab && ctx.tabs.find(tab.id) && !tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
}

const PLAIN = `<!doctype html><html><head><meta charset="utf-8"><title>Plain http fixture</title></head><body><p id="plain">Served over plain http.</p></body></html>`

const httpsFirst: SmokeCheck = {
  name: 'privacy: HTTPS-First shows its page for an http site with no https, and Continue to site remembers it',
  async run(ctx) {
    const before = ctx.settings.get().httpsFirst
    ctx.settings.update({ httpsFirst: true })
    ctx.server.page('/privacy/plain', PLAIN)
    const port = await refusedPort()
    const stopHook = webRequestHooks.add(
      {
        onBeforeRequest(d) {
          let u: URL
          try {
            u = new URL(d.url)
          } catch {
            return null
          }
          if (u.hostname !== INSECURE_HOST) return null
          if (d.resourceType !== 'mainFrame') return { cancel: true }
          return { redirectURL: u.protocol === 'https:' ? `https://127.0.0.1:${port}/` : `${ctx.server.http}/privacy/plain` }
        },
      },
      { sessions: 'web' },
    )
    let local: Tab | null = null
    let tab: Tab | null = null
    try {
      // The fixture server is local: loaded over http as it is.
      local = ctx.tabs.create(`${ctx.server.http}/privacy/plain`, { activate: true })
      await waitForPage(local.view.webContents, 'the local http fixture', 10_000, (u) => u.includes('/privacy/plain'))
      assert(local.view.webContents.getURL().startsWith('http://127.0.0.1'), `a local address is never upgraded (got ${local.view.webContents.getURL()})`)
      assert(ctx.tabs.info(local).pageError === null, 'the local fixture shows no error page')
      close(ctx, local)
      local = null

      tab = ctx.tabs.create(`http://${INSECURE_HOST}/`, { activate: true })
      const t = tab
      await waitFor(() => ctx.tabs.info(t).pageError?.kind === 'https-unavailable', 10_000, 'the HTTPS-First page')
      const error = ctx.tabs.info(t).pageError
      assert(error?.url === `http://${INSECURE_HOST}/`, `the page names the http address (got ${error?.url ?? 'nothing'})`)
      const title = await ctx.chrome.until<string>('return document.querySelector(".perr__title")?.textContent || null', 5000, 'the HTTPS-First page in the pane')
      assert(/secure connection/i.test(title), `the page says the site has no secure connection (got "${title}")`)
      const labels = await ctx.chrome.until<string>('return [...document.querySelectorAll(".perr__actions button")].map((b) => b.textContent.trim()).join("|") || null', 5000, 'its buttons')
      assert(labels.includes('Continue to site') && labels.includes('Go back'), `it offers Continue to site and Go back (got ${labels})`)
      await ctx.shot('privacy-https-first')

      await ctx.chrome.invoke('pageErrors', 'proceed', t.id)
      await waitFor(() => ctx.tabs.info(t).pageError === null && t.view.webContents.getURL().includes('/privacy/plain'), 10_000, 'the site over http after Continue to site')
      const exceptions = await ctx.chrome.invoke<PrivacyExceptions>('privacy', 'exceptions')
      assert(exceptions.https.includes(INSECURE_HOST), 'Continue to site is remembered for the site')

      // Remembered: the next visit goes straight to http.
      await t.view.webContents.loadURL(`http://${INSECURE_HOST}/again`).catch(() => undefined)
      await waitForPage(t.view.webContents, 'the remembered site', 10_000, (u) => u.includes('/privacy/plain'))
      assert(ctx.tabs.info(t).pageError === null, 'a remembered site loads without the page')
    } finally {
      stopHook()
      close(ctx, local)
      close(ctx, tab)
      await ctx.chrome.invoke('privacy', 'setException', 'https', INSECURE_HOST, false).catch(() => undefined)
      ctx.settings.update({ httpsFirst: before })
    }
  },
}

const CONSENT = `<!doctype html><html><head><meta charset="utf-8"><title>Consent fixture</title></head>
<body style="font:16px system-ui;margin:0;padding:24px">
<p id="article">An article with a consent banner.</p>
<script>
  window.__accepted = false
  setTimeout(() => {
    const box = document.createElement('div')
    box.id = 'onetrust-banner-sdk'
    box.style.cssText = 'position:fixed;inset:auto 0 0 0;height:120px;background:#eee'
    box.innerHTML = '<p>We use cookies.</p><button id="onetrust-accept-btn-handler">Accept all</button><button id="onetrust-reject-all-handler">Reject all</button>'
    document.body.appendChild(box)
    document.getElementById('onetrust-accept-btn-handler').addEventListener('click', () => { window.__accepted = true })
    document.getElementById('onetrust-reject-all-handler').addEventListener('click', () => { document.title = 'rejected' })
  }, 400)
</script>
</body></html>`

/** The interactive overlay showing `needle` (any window's: earlier groups can leave windows open), and its text. */
async function waitForText(needle: string): Promise<{ wc: WebContents; text: string }> {
  let found: { wc: WebContents; text: string } | null = null
  await waitFor(async () => {
    const overlays = allWebContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().includes('#overlay=interactive'))
    for (const wc of overlays) {
      const text = await js<string>(wc, 'document.body.innerText').catch(() => '')
      if (text.includes(needle)) {
        found = { wc, text }
        return true
      }
    }
    return false
  }, 8000, `"${needle}" in the overlay`)
  if (!found) throw new Error(`"${needle}" is not in any overlay`)
  return found
}

const display = (wc: WebContents, sel: string): Promise<string> => js<string>(wc, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? getComputedStyle(e).display : 'missing' })()`)

const cookieBanners: SmokeCheck = {
  name: 'privacy: a late consent banner is hidden and refused, the site info summary says so, and the site switch shows it again',
  async run(ctx) {
    const before = ctx.settings.get().hideCookieBanners
    ctx.settings.update({ hideCookieBanners: true })
    ctx.server.page('/privacy/consent', CONSENT)
    let tab: Tab | null = null
    try {
      tab = ctx.tabs.create(`${ctx.server.http}/privacy/consent`, { activate: true })
      const wc = tab.view.webContents
      const t = tab
      await waitForPage(wc, 'the consent fixture', 10_000, (u) => u.includes('/privacy/consent'))
      await waitFor(() => wc.getTitle() === 'rejected', 10_000, 'Apex to press the banner’s Reject all')
      assert((await js<boolean>(wc, 'window.__accepted')) === false, 'Accept all is never pressed')
      assert((await display(wc, '#onetrust-banner-sdk')) === 'none', 'the banner is hidden')
      let summary: PrivacySummary | null = null
      await waitFor(async () => {
        summary = await ctx.chrome.invoke<PrivacySummary | null>('privacy', 'summary', t.id)
        return summary?.cookieBanner === 'rejected'
      }, 10_000, 'the summary to report the refused banner')
      const s = summary as PrivacySummary | null
      assert(s?.connection === 'http', `a local page reads as plain http (got ${s?.connection ?? 'nothing'})`)
      assert(typeof s?.trackersBlocked === 'number', 'the summary counts blocked trackers')

      // The site info popover shows the summary, with the per-site switch.
      await sitesSmoke.openSiteInfo(t)
      await waitFor(() => sitesSmoke.surfaces(t).includes('site-info'), 5000, 'site info to open')
      const { wc: overlay, text } = await waitForText('Cookie banner refused for you')
      assert(text.includes('Privacy on this site') && text.includes('Hide cookie banners on this site'), 'site info shows the privacy summary and its switch')
      await js(overlay, 'document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))').catch(() => undefined)

      await ctx.chrome.invoke('privacy', 'setException', 'cookieBanners', '127.0.0.1', true)
      await waitFor(async () => (await display(wc, '#onetrust-banner-sdk')) !== 'none', 5000, 'the banner to show again on an allowed site')
      const allowed = await ctx.chrome.invoke<PrivacySummary | null>('privacy', 'summary', t.id)
      assert(allowed?.cookieBanner === 'allowed', `the summary says the site shows its banner (got ${allowed?.cookieBanner ?? 'nothing'})`)
    } finally {
      await ctx.chrome.invoke('privacy', 'setException', 'cookieBanners', '127.0.0.1', false).catch(() => undefined)
      close(ctx, tab)
      ctx.settings.update({ hideCookieBanners: before })
    }
  },
}

// TrustArc's newer popup, as digitalocean.com serves it: the box inside a transparent full-page wrapper on top of
// everything, its buttons in an open shadow root. Decline records the choice and leaves the wrapper where it is.
const TRUSTARC = `<!doctype html><html><head><meta charset="utf-8"><title>TrustArc fixture</title></head>
<body style="font:16px system-ui;margin:0;padding:24px">
<button id="behind" style="position:absolute;left:40px;top:80px;width:220px;height:60px">A button on the page</button>
<script>
  window.__accepted = false
  window.__behind = 0
  document.getElementById('behind').addEventListener('click', () => { window.__behind++ })
  setTimeout(() => {
    const outer = document.createElement('div')
    outer.className = 'truste_cm_outerdiv'
    outer.style.cssText = 'position:fixed;inset:0;z-index:2199998'
    const box = document.createElement('div')
    box.className = 'truste_box_overlay'
    box.style.cssText = 'position:fixed;inset:30% 25%;background:#eee;z-index:2199998'
    const host = document.createElement('div')
    host.className = 'trustarc_newcm_container'
    box.appendChild(host)
    outer.appendChild(box)
    document.body.appendChild(outer)
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<p>We use cookies.</p><button id="accept_all_button">Accept All</button><button id="decline_all_button">Decline All</button>'
    root.getElementById('accept_all_button').addEventListener('click', () => { window.__accepted = true })
    root.getElementById('decline_all_button').addEventListener('click', () => { document.title = 'declined' })
  }, 400)
</script>
</body></html>`

const trustArcPopup: SmokeCheck = {
  name: 'privacy: TrustArc’s newer popup is declined in its shadow root, and its leftover full-page wrapper no longer takes the page’s clicks',
  async run(ctx) {
    const before = ctx.settings.get().hideCookieBanners
    ctx.settings.update({ hideCookieBanners: true })
    ctx.server.page('/privacy/trustarc', TRUSTARC)
    let tab: Tab | null = null
    try {
      tab = ctx.tabs.create(`${ctx.server.http}/privacy/trustarc`, { activate: true })
      const wc = tab.view.webContents
      await waitForPage(wc, 'the TrustArc fixture', 10_000, (u) => u.includes('/privacy/trustarc'))
      await waitFor(() => wc.getTitle() === 'declined', 10_000, 'Apex to press Decline All in the shadow root')
      assert((await js<boolean>(wc, 'window.__accepted')) === false, 'Accept All is never pressed')
      assert((await display(wc, '.truste_cm_outerdiv')) === 'none', 'the full-page wrapper is hidden')
      // A real click on the page lands on the page, not on the wrapper.
      const r = await js<{ x: number; y: number }>(wc, '(() => { const b = document.getElementById("behind").getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()')
      const top = await js<string>(wc, `document.elementFromPoint(${r.x}, ${r.y})?.id ?? ''`)
      assert(top === 'behind', `the page's button is on top where it is drawn (got "${top}")`)
      wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y })
      await new Promise((done) => setTimeout(done, 120))
      wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 })
      await waitFor(() => js<number>(wc, 'window.__behind').then((n) => n === 1), 5000, 'a click to reach the page’s button')
    } finally {
      close(ctx, tab)
      ctx.settings.update({ hideCookieBanners: before })
    }
  },
}

const gpc: SmokeCheck = {
  name: 'privacy: Global Privacy Control’s header and navigator flag agree in the page and its iframe',
  async run(ctx) {
    const before = ctx.settings.get().globalPrivacyControl
    const seen = new Map<string, string | undefined>()
    const record = (path: string, html: string) =>
      ctx.server.route(path, (req, res) => {
        const header = req.headers['sec-gpc']
        seen.set(path, Array.isArray(header) ? header[0] : header)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
      })
    record('/privacy/gpc', `<!doctype html><html><head><meta charset="utf-8"><title>GPC</title></head><body><iframe src="/privacy/gpc-frame"></iframe></body></html>`)
    record('/privacy/gpc-frame', `<!doctype html><html><body>frame</body></html>`)
    let tab: Tab | null = null
    try {
      ctx.settings.update({ globalPrivacyControl: true })
      tab = ctx.tabs.create(`${ctx.server.http}/privacy/gpc`, { activate: true })
      const wc = tab.view.webContents
      await waitForPage(wc, 'the GPC fixture', 10_000, (u) => u.includes('/privacy/gpc'))
      await waitFor(() => seen.has('/privacy/gpc-frame'), 5000, 'the iframe to load')
      assert(seen.get('/privacy/gpc') === '1' && seen.get('/privacy/gpc-frame') === '1', 'Sec-GPC goes with the page and its iframe')
      const top = await js<unknown>(wc, 'navigator.globalPrivacyControl')
      const frame = await js<unknown>(wc, 'document.querySelector("iframe").contentWindow.navigator.globalPrivacyControl')
      assert(top === true, `the page sees navigator.globalPrivacyControl (got ${String(top)})`)
      assert(frame === true, `the iframe sees it too (got ${String(frame)})`)
    } finally {
      close(ctx, tab)
      ctx.settings.update({ globalPrivacyControl: before })
    }
  },
}

export const privacySmoke: SmokeGroup = { group: 'PRIVACY', checks: [httpsFirst, cookieBanners, trustArcPopup, gpc], shots: [] }
