/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { writeFileSync } from 'node:fs'
import type { WebContents } from 'electron'
import { sitesSmoke } from '../features/sites'
import { assert, captureWindow, waitFor } from '../smokeKit'
import { settleOverlays } from '../smokeShots'
import { waitForPage } from '../smokeLoad'
import type { SmokeGroup, SmokeContext } from '../smokeBrowser/types'
import type { Tab } from '../tabs'
import { tweakStore, startPicking } from './feature'

// Tweaks end to end on the smoke server (APEX_SMOKE_ONLY=TWEAKS): a hidden
// element stored for 127.0.0.1 hides it on a local page before the page's
// own script runs; a CSS change reaches the open page without a reload; the
// picker hides what a click picks and Esc ends it; and a tweak covering
// *.localhost stays off the test host signInHosts.ts counts as Google's
// sign-in (accounts.google.localhost). Everything it adds is removed after.

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Tweak fixture</title>
<style>#ad { display: block !important; }</style></head>
<body style="font:16px system-ui;margin:0;padding:24px">
<div id="ad" class="promo-box" style="height:60px;background:#fc0">Buy now</div>
<p id="keep">Keep me</p>
<div class="row" style="padding:40px 0"><span class="target" style="display:inline-block;width:240px;height:80px;background:#9cf">Hide me</span></div>
<script>window.__adHiddenAtLoad = getComputedStyle(document.getElementById('ad')).display === 'none'</script>
</body></html>`

const js = <T>(wc: WebContents, code: string): Promise<T> => wc.executeJavaScript(code, true) as Promise<T>
const display = (wc: WebContents, sel: string): Promise<string> => js<string>(wc, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? getComputedStyle(e).display : 'missing' })()`)

async function open(ctx: SmokeContext, url: string): Promise<Tab> {
  const tab = ctx.tabs.create(url, { activate: true })
  await waitForPage(tab.view.webContents, `the tweak fixture at ${url}`, 10000, (at) => at.includes('/tweaks/page'))
  await waitFor(() => js<boolean>(tab.view.webContents, 'document.readyState === "complete"').catch(() => false), 8000, 'the tweak fixture to finish loading')
  return tab
}

function close(ctx: SmokeContext, tab: Tab | null): void {
  if (tab && ctx.tabs.find(tab.id) && !tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
}

async function hidesAndPicks(ctx: SmokeContext): Promise<void> {
  const store = tweakStore()
  assert(store, 'the tweaks store is not running')
  ctx.server.page('/tweaks/page', PAGE)
  const before = store.state().tweaks.find((b) => b.host === '127.0.0.1')
  if (before) store.remove(before.id)
  let tab: Tab | null = null
  try {
    const { tweak } = store.addHidden('127.0.0.1', '#ad', 'div#ad · Buy now')
    tab = await open(ctx, `${ctx.server.http}/tweaks/page`)
    const wc = tab.view.webContents
    assert((await js<boolean>(wc, 'window.__adHiddenAtLoad')) === true, 'the hidden element was still showing when the page’s own script ran')
    assert((await display(wc, '#ad')) === 'none', `the hidden element shows (display ${await display(wc, '#ad')})`)
    assert((await display(wc, '#keep')) !== 'none', 'an element nobody picked is hidden')
    if (process.env.APEX_TWEAKS_SHOT) {
      // Site info with its Tweak section, for a look at it alongside apex://tweaks.
      await sitesSmoke.openSiteInfo(tab)
      await waitFor(() => sitesSmoke.surfaces(tab as Tab).includes('site-info'), 5000, 'site info to open')
      await new Promise((done) => setTimeout(done, 800))
      await settleOverlays()
      writeFileSync(process.env.APEX_TWEAKS_SHOT.replace(/\.png$/, '-info.png'), (await captureWindow(ctx.chrome.ui, ctx.tabs)).toPNG())
      ctx.chrome.ui.focus()
      wc.focus()
    }

    // A CSS change reaches the open page without a reload.
    store.update(tweak.id, { css: '#keep { color: rgb(1, 2, 3) !important; }' })
    await waitFor(() => js<string>(wc, 'getComputedStyle(document.getElementById("keep")).color').then((c) => c === 'rgb(1, 2, 3)'), 5000, 'the custom CSS to reach the open page')
    // Turning the tweak off brings everything back, again without a reload.
    store.update(tweak.id, { enabled: false })
    await waitFor(() => display(wc, '#ad').then((d) => d !== 'none'), 5000, 'the hidden element to come back with the tweak off')
    store.update(tweak.id, { enabled: true })
    await waitFor(() => display(wc, '#ad').then((d) => d === 'none'), 5000, 'the hidden element to hide again')

    // The picker: a click on the target hides it and stores a second hidden element; Esc ends picking.
    // Through the chrome's own call, as site info's Hide elements makes it.
    assert((await ctx.chrome.invoke<{ host: string | null; tweak: { id: string } | null }>('tweaks', 'forTab', tab.id)).tweak?.id === tweak.id, 'site info found no tweak for the page')
    assert(await ctx.chrome.invoke<boolean>('tweaks', 'hideElements', tab.id), 'the picker did not start on a web page')
    await waitFor(() => js<boolean>(wc, 'Boolean(document.querySelector("apex-tweak-picker"))'), 5000, 'the picker to appear')
    const r = await js<{ x: number; y: number }>(wc, '(() => { const b = document.querySelector(".target").getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()')
    wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y })
    await new Promise((done) => setTimeout(done, 120))
    wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 })
    await waitFor(() => display(wc, '.target').then((d) => d === 'none'), 5000, 'the clicked element to hide')
    const hidden = store.state().tweaks.find((b) => b.host === '127.0.0.1')?.hidden.map((z) => z.selector) ?? []
    assert(hidden.length === 2 && hidden.includes('#ad'), `the picker stored ${JSON.stringify(hidden)}`)
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await waitFor(() => js<boolean>(wc, '!document.querySelector("apex-tweak-picker")'), 5000, 'Esc to end the picker')

    // Still hidden after a reload, from the stored selectors alone.
    wc.reload()
    await waitForPage(wc, 'the tweak fixture after a reload', 10000, (at) => at.includes('/tweaks/page'))
    await waitFor(() => js<boolean>(wc, 'document.readyState === "complete"').catch(() => false), 8000, 'the reload to finish')
    assert((await display(wc, '.target')) === 'none' && (await display(wc, '#ad')) === 'none', 'hidden elements came back after a reload')

    // A script runs only with Allow custom scripts on, in its own world: the page's DOM, not its globals.
    // It runs at document start, before <html> exists, so it waits for the page's content like any early script.
    store.update(tweak.id, { js: 'window.__tweakGlobal = 1; document.addEventListener("DOMContentLoaded", () => { document.documentElement.dataset.apexTweak = "ran" })', jsEnabled: true })
    const reload = async (what: string): Promise<void> => {
      wc.reload()
      await waitForPage(wc, what, 10000, (at) => at.includes('/tweaks/page'))
      await waitFor(() => js<boolean>(wc, 'document.readyState === "complete"').catch(() => false), 8000, `${what} to finish`)
    }
    await reload('the fixture with scripts not allowed')
    assert((await js<string | null>(wc, 'document.documentElement.dataset.apexTweak ?? null')) === null, 'a tweak script ran with Allow custom scripts off')
    store.setScriptsAllowed(true)
    await reload('the fixture with scripts allowed')
    assert((await js<string | null>(wc, 'document.documentElement.dataset.apexTweak ?? null')) === 'ran', 'the tweak script did not run')
    assert((await js<string>(wc, 'typeof window.__tweakGlobal')) === 'undefined', 'the tweak script ran in the page’s own world')
  } finally {
    close(ctx, tab)
    store.setScriptsAllowed(false)
    const made = store.state().tweaks.find((b) => b.host === '127.0.0.1')
    if (made) store.remove(made.id)
    if (before) store.restore(before)
  }
}

async function staysOffSignIn(ctx: SmokeContext): Promise<void> {
  const store = tweakStore()
  assert(store, 'the tweaks store is not running')
  ctx.server.page('/tweaks/page', PAGE)
  const before = store.state().tweaks.find((b) => b.host === 'localhost')
  let tab: Tab | null = null
  try {
    const b = store.create('localhost')
    store.update(b.id, { subdomains: true })
    store.addHidden('localhost', '#ad', 'ad')
    const port = new URL(ctx.server.http).port
    tab = await open(ctx, `http://accounts.google.localhost:${port}/tweaks/page`)
    assert((await display(tab.view.webContents, '#ad')) !== 'none', 'a tweak ran on a sign-in page')
    assert(!startPicking(tab.id), 'the picker started on a sign-in page')
    assert((await ctx.chrome.invoke<{ blocked: string | null }>('tweaks', 'forTab', tab.id)).blocked === 'sign-in', 'site info offered tweaks on a sign-in page')
  } finally {
    close(ctx, tab)
    const made = store.state().tweaks.find((x) => x.host === 'localhost')
    if (made) store.remove(made.id)
    if (before) store.restore(before)
  }
}

/** apex://tweaks?site=<host> opens that tweak; Show again on a hidden element brings it back. */
async function pageEdits(ctx: SmokeContext): Promise<void> {
  const store = tweakStore()
  assert(store, 'the tweaks store is not running')
  const before = store.state().tweaks.find((b) => b.host === 'tweak-fixture.localhost')
  try {
    const { tweak } = store.addHidden('tweak-fixture.localhost', '.cookie-banner', 'div.cookie-banner · We use cookies')
    store.update(tweak.id, { style: { font: 'serif', tint: 'fern', focus: true }, css: 'body { line-height: 1.6 !important; }' })
    ctx.tabs.openInternal('apex://tweaks?site=tweak-fixture.localhost')
    await ctx.chrome.until('return Boolean(document.querySelector(".twk-editor")) && document.querySelector(".twk-hide__label")?.textContent.includes("cookie")', 10_000, 'the tweak editor with its hidden element')
    const overflow = await ctx.chrome.js<boolean>('const s = document.querySelector(".twk-scroll"); return s.scrollWidth > s.clientWidth + 1')
    assert(!overflow, 'apex://tweaks scrolls sideways')
    await ctx.shot('tweaks-page')
    // APEX_TWEAKS_SHOT=<file.png>: this page alone, without the full shot tour.
    if (process.env.APEX_TWEAKS_SHOT) writeFileSync(process.env.APEX_TWEAKS_SHOT, (await captureWindow(ctx.chrome.ui, ctx.tabs)).toPNG())
    await ctx.chrome.click(/^Show again$/, 'document.querySelector(".twk-editor")')
    await waitFor(() => (store.get(tweak.id)?.hidden.length ?? 1) === 0, 5000, 'Show again to bring the element back')
  } finally {
    const made = store.state().tweaks.find((b) => b.host === 'tweak-fixture.localhost')
    if (made) store.remove(made.id)
    if (before) store.restore(before)
  }
}

export const tweaksSmoke: SmokeGroup = {
  group: 'TWEAKS',
  checks: [
    { name: 'a tweak hides a picked element on a local page, and the picker hides a clicked one', run: hidesAndPicks },
    { name: 'tweaks stay off sign-in pages', run: staysOffSignIn },
    { name: 'apex://tweaks opens a site’s tweak and shows hidden elements again', run: pageEdits },
  ],
  shots: [],
}
