/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebContents } from 'electron'
import { assert, docWith, sleep, waitFor, type Chrome } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import { addressSmoke } from '../features/address'
import type { Tab } from '../tabs'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// The address pill driven the way a person drives it: real mouse
// clicks and key presses through webContents.sendInputEvent, never the
// bar's own calls. Each check opens the bar from the pill or ⌘L, types,
// moves with the arrows and commits with Enter, ⌥Enter or ⌘Enter, in both
// layouts and on apex:// pages. Searches use a custom engine on the local
// smoke server, so nothing reaches the network.

type Mod = 'meta' | 'alt' | 'shift' | 'control'

/** ⌘ on macOS, Ctrl on Windows and Linux: the modifier the shortcut table's own keys use there. */
const PRIMARY: Mod = process.platform === 'darwin' ? 'meta' : 'control'

const page = (title: string): string => `<!doctype html><html><head><title>${title}</title></head><body style="font:16px system-ui;padding:40px"><h1>${title}</h1></body></html>`

function route(ctx: SmokeContext, path: string, title: string): string {
  ctx.server.route(path, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(title))
  })
  return `${ctx.server.http}${path}`
}

async function webTab(ctx: SmokeContext, path: string, title: string): Promise<Tab> {
  const url = route(ctx, path, title)
  const tab = ctx.tabs.create(url, { activate: true })
  await waitForPage(tab.view.webContents, title, 8000, (at) => at.includes(path))
  return tab
}

/** The last click clickOn made, for a failure to say where it landed. */
let lastClick: { doc: Chrome; selector: string; at: { x: number; y: number } } | null = null

/** What is at the last click's point now, and whether the pill is still editing (pill--covered). */
async function lastClickReport(): Promise<string> {
  if (!lastClick) return 'no click'
  const { doc, selector, at } = lastClick
  return doc
    .js<unknown>(
      `const hit = document.elementFromPoint(${at.x}, ${at.y}); const el = document.querySelector(${JSON.stringify(selector)})
       return { at: ${JSON.stringify(at)}, hit: hit ? hit.tagName + '.' + String(hit.className).slice(0, 60) : null, onTarget: !!(el && hit && el.contains(hit)), pill: document.querySelector('.pill')?.className ?? null, focused: document.hasFocus() }`,
    )
    .then((v) => JSON.stringify(v), (err: unknown) => `unknown (${String(err)})`)
}

/**
 * A real click on the middle of an element in a webContents (CSS px of its top frame), once it holds still (two
 * looks 50 ms apart agree) and nothing covers that point: a click measured mid-reflow lands beside it.
 */
async function clickOn(doc: Chrome, selector: string, modifiers: Mod[] = []): Promise<void> {
  type Box = { x: number; y: number; width: number; height: number }
  let prev: Box | null = null
  let r: Box | null = null
  await waitFor(async () => {
    const now = await doc
      .js<Box | null>(
        `const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.getClientRects().length === 0) return null
         const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 40), r.top + r.height / 2)
         return hit && el.contains(hit) ? { x: r.left, y: r.top, width: r.width, height: r.height } : null`,
      )
      .catch(() => null)
    const still = prev !== null && now !== null && now.x === prev.x && now.y === prev.y && now.width === prev.width && now.height === prev.height
    prev = now
    if (still) r = now
    return still
  }, 5000, `${selector} to show, uncovered and still`)
  const box = r as unknown as Box
  const at = { x: Math.round(box.x + Math.min(box.width / 2, 40)), y: Math.round(box.y + box.height / 2) }
  lastClick = { doc, selector, at }
  const wc = doc.ui
  wc.focus()
  wc.sendInputEvent({ type: 'mouseMove', ...at })
  wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1, modifiers })
  wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1, modifiers })
  await sleep(80)
}

/** One key press (keyCode as Electron's accelerators name it: 'Return', 'Escape', 'Down', 'L'). */
async function press(wc: WebContents, keyCode: string, modifiers: Mod[] = []): Promise<void> {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await sleep(60)
}

/** Types text a character at a time, as key presses. */
async function typeKeys(wc: WebContents, text: string, settleMs = 150): Promise<void> {
  for (const ch of text) {
    const named = /^[a-z0-9]$/i.test(ch)
    if (named) wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
    wc.sendInputEvent({ type: 'char', keyCode: ch })
    if (named) wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
  }
  if (settleMs > 0) await sleep(settleMs)
}

interface FieldState {
  value: string
  focused: boolean
  start: number
  end: number
  rows: { title: string; sub: string; selected: boolean }[]
}

const FIELD = `const f = document.querySelector('.cb-field__input'); if (!f) return null
  return { value: f.value, focused: document.activeElement === f && document.hasFocus(), start: f.selectionStart, end: f.selectionEnd,
    rows: [...document.querySelectorAll('.cb-row')].map((r) => ({ title: (r.querySelector('.cb-row__title')?.textContent || '').trim(), sub: (r.querySelector('.cb-row__sub')?.textContent || '').trim(), selected: r.classList.contains('cb-row--selected') })) }`

/** Waits for the command bar to open over the pill and returns its document (the interactive overlay). */
async function barOpened(ctx: SmokeContext, what: string): Promise<Chrome> {
  await waitFor(() => addressSmoke.surfaces().includes('command-bar'), 5000, `the command bar (${what})`).catch(async (err: unknown) => {
    throw new Error(`${err instanceof Error ? err.message : String(err)} Open: ${addressSmoke.surfaces().join(', ') || 'nothing'}; last click ${await lastClickReport()}`)
  })
  const doc = await docWith(ctx.chrome, '.cb-field__input', 5000, 'the command bar field', { overlayOnly: true })
  await doc.until(`const f = document.querySelector('.cb-field__input'); return f && document.activeElement === f ? true : null`, 3000, 'the field to take focus')
  return doc
}

/** The bar is on screen over the pill: the overlay view covers the pill and the field draws opaque pixels there. */
async function barVisible(ctx: SmokeContext, doc: Chrome): Promise<void> {
  const pill = await ctx.chrome.js<{ x: number; y: number; width: number; height: number } | null>(
    `const r = document.querySelector('.pill')?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null`,
  )
  assert(pill, 'the pill is drawn')
  let bounds: { x: number; y: number; width: number; height: number } | null = null
  await waitFor(() => {
    bounds = addressSmoke.overlayBounds('command-bar')
    return bounds !== null && bounds.height > 0
  }, 3000, 'the overlay view to show').catch(async () => {
    const frame = await doc.js(`const f = document.querySelector('.ov-frame[data-surface="command-bar"]'); if (!f) return 'no frame'
      return { placed: f.hasAttribute('data-placed'), hidden: f.hidden, style: f.getAttribute('style'), w: f.offsetWidth, h: f.offsetHeight, html: f.innerHTML.length, vw: innerWidth, vh: innerHeight }`)
    throw new Error(`the overlay view is hidden or empty while the bar is open (bounds ${JSON.stringify(bounds)}, frame ${JSON.stringify(frame)})`)
  })
  const b = bounds as unknown as { x: number; y: number; width: number; height: number }
  const cx = pill.x + pill.width / 2
  const cy = pill.y + pill.height / 2
  assert(cx >= b.x && cx <= b.x + b.width && cy >= b.y && cy <= b.y + b.height, `the overlay covers the pill (pill ${JSON.stringify(pill)}, overlay ${JSON.stringify(b)})`)
  const box = await doc.js<{ x: number; y: number; width: number; height: number; opacity: string }>(
    `const el = document.querySelector('.cb-field'); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, opacity: getComputedStyle(el.closest('[data-surface], .cb') || el).opacity }`,
  )
  assert(box.width > 100 && box.height > 16, `the field has a size (${JSON.stringify(box)})`)
  // The field's centre in the overlay is over the pill's centre in the window.
  const fx = b.x + box.x + box.width / 2
  const fy = b.y + box.y + box.height / 2
  assert(Math.abs(fy - cy) < pill.height && Math.abs(fx - cx) < pill.width / 2, `the field sits over the pill (field centre ${Math.round(fx)},${Math.round(fy)}, pill centre ${Math.round(cx)},${Math.round(cy)})`)
  let alpha = 0
  await waitFor(async () => {
    const image = await doc.ui.capturePage({ x: Math.round(box.x + box.width / 2) - 2, y: Math.round(box.y + box.height / 2) - 2, width: 4, height: 4 })
    const px = image.toBitmap()
    alpha = px.length >= 4 ? (px[3] ?? 0) : 0
    return alpha > 200
  }, 3000, 'the field to draw').catch(() => {
    throw new Error(`the field is not drawn where it should be (alpha ${alpha}, opacity ${box.opacity})`)
  })
}

async function barClosed(what: string): Promise<void> {
  await waitFor(() => !addressSmoke.surfaces().includes('command-bar'), 5000, `the command bar to close (${what})`)
}

async function field(doc: Chrome): Promise<FieldState> {
  const state = await doc.js<FieldState | null>(FIELD)
  assert(state, 'the command bar field is there')
  return state
}

async function rowsFor(doc: Chrome, what: string, ok: (s: FieldState) => boolean): Promise<FieldState> {
  let last: FieldState | null = null
  await waitFor(async () => {
    last = await field(doc)
    return ok(last)
  }, 5000, what).catch((err: unknown) => {
    throw new Error(`${what}: ${err instanceof Error ? err.message : String(err)} (rows: ${JSON.stringify(last?.rows ?? [])}, value: ${JSON.stringify(last?.value)}, open: ${addressSmoke.surfaces().join(', ') || 'nothing'})`)
  })
  return last as unknown as FieldState
}

function closeTab(ctx: SmokeContext, tab: Tab | undefined): void {
  if (tab && ctx.tabs.find(tab.id) && !tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
}

/** The tab's address as the chrome shows it: an apex:// page or the web address. */
const addressOf = (tab: Tab): string => tab.internalUrl ?? tab.view.webContents.getURL()

const pillClick: SmokeCheck = {
  name: 'a real click on the pill opens the bar with the address selected; typing an address and Enter go there in the same tab',
  async run(ctx) {
    const tab = await webTab(ctx, '/address-input-start', 'Pill start')
    const target = route(ctx, '/address-input-typed', 'Pill typed')
    try {
      await clickOn(ctx.chrome, '.pill__text')
      const doc = await barOpened(ctx, 'a click on the pill')
      await barVisible(ctx, doc)
      const first = await field(doc)
      assert(first.value === tab.view.webContents.getURL(), `the field holds the address (got ${JSON.stringify(first.value)})`)
      assert(first.start === 0 && first.end === first.value.length, `the address is selected (${first.start}-${first.end} of ${first.value.length})`)
      await typeKeys(doc.ui, target.replace(/^http:\/\//, ''))
      const typed = await rowsFor(doc, 'an Open row for the typed address', (s) => s.rows.some((r) => r.sub === 'Open'))
      assert(typed.rows[0]?.sub === 'Open', `the typed address leads (rows: ${JSON.stringify(typed.rows)})`)
      assert(typed.rows.some((r) => r.sub.startsWith('Search with ')), 'the search row is offered too')
      await press(doc.ui, 'Return')
      await barClosed('Enter')
      await waitFor(() => tab.view.webContents.getURL() === target, 8000, `the tab to go to the typed address (at ${tab.view.webContents.getURL()})`)
      assert(ctx.tabs.activeId() === tab.id, 'Enter stays in the same tab')
      // Enter right after the last key goes where the whole text says, not where the rows for a shorter prefix pointed.
      const longer = route(ctx, '/address-input-typed-further', 'Pill typed further')
      await clickOn(ctx.chrome, '.pill__text')
      const again = await barOpened(ctx, 'a second click on the pill')
      await typeKeys(again.ui, target.replace(/^http:\/\//, ''))
      await rowsFor(again, 'rows for the shorter address', (s) => s.rows[0]?.title.endsWith('/address-input-typed') === true)
      await typeKeys(again.ui, '-further', 0)
      await press(again.ui, 'Return')
      await barClosed('a quick Enter')
      await waitFor(() => tab.view.webContents.getURL() === longer, 8000, `a quick Enter to open the whole address (at ${tab.view.webContents.getURL()})`)
    } finally {
      closeTab(ctx, tab)
    }
  },
}

const searchNewTab: SmokeCheck = {
  name: '⌘T opens a new tab with the bar ready; a query and Enter search the default engine from Settings › Search',
  async run(ctx) {
    const base = ctx.server.https
    if (!base) return
    const before = ctx.settings.get()
    route(ctx, '/address-input-search', 'Search results')
    ctx.settings.update({
      customSearchEngines: [...before.customSearchEngines.filter((e) => e.id !== 'apex-smoke'), { id: 'apex-smoke', name: 'Smoke Search', template: `${base}/address-input-search?q=%s` }],
      searchEngine: 'apex-smoke',
    })
    let opened: Tab | undefined
    const ids = new Set(ctx.tabs.all().map((t) => t.id))
    try {
      await clickOn(ctx.chrome, '.pill')
      await barOpened(ctx, 'a first click').then((doc) => press(doc.ui, 'Escape'))
      await barClosed('Esc')
      ctx.chrome.ui.focus()
      await press(ctx.chrome.ui, 'T', [PRIMARY])
      await waitFor(() => ctx.tabs.all().some((t) => !ids.has(t.id)), 5000, 'a new tab from ⌘T')
      opened = ctx.tabs.all().find((t) => !ids.has(t.id))
      const doc = await barOpened(ctx, '⌘T')
      await barVisible(ctx, doc)
      const empty = await field(doc)
      assert(empty.value === '', `a new tab's bar starts empty (got ${JSON.stringify(empty.value)})`)
      await typeKeys(doc.ui, 'apex smoke query')
      const rows = await rowsFor(doc, 'the search row for the default engine', (s) => s.rows[0]?.sub === 'Search with Smoke Search')
      assert(rows.rows[0]?.title === 'apex smoke query', `the search row shows the query (got ${JSON.stringify(rows.rows[0])})`)
      const started: string[] = []
      const wc = opened!.view.webContents
      const onStart = (details: { url: string; isMainFrame: boolean }): void => {
        if (details.isMainFrame) started.push(details.url)
      }
      wc.on('did-start-navigation', onStart)
      try {
        await press(doc.ui, 'Return')
        await barClosed('Enter')
        const want = `${base}/address-input-search?q=apex%20smoke%20query`
        await waitFor(() => started.includes(want) || opened!.requestedUrl === want, 8000, `the new tab to search the default engine (started: ${started.join(', ') || 'nothing'})`)
        assert(ctx.tabs.activeId() === opened!.id, 'the search runs in the new tab')
      } finally {
        wc.off('did-start-navigation', onStart)
      }
    } finally {
      closeTab(ctx, opened)
      ctx.settings.update({ customSearchEngines: before.customSearchEngines, searchEngine: before.searchEngine })
    }
  },
}

const keysOnApexPage: SmokeCheck = {
  name: '⌘L on Getting started selects its address; arrows move through rows, Esc restores, Enter leaves the apex:// page',
  async run(ctx) {
    const known = await webTab(ctx, '/address-input-known', 'Known page')
    const target = route(ctx, '/address-input-from-apex', 'From apex')
    let tab: Tab | undefined
    try {
      ctx.tabs.openInternal('apex://first-week', { newTab: true })
      await waitFor(() => ctx.tabs.active()?.internalUrl?.startsWith('apex://first-week') === true, 5000, 'Getting started in a tab')
      tab = ctx.tabs.active()!
      await sleep(300)
      ctx.chrome.ui.focus()
      await press(ctx.chrome.ui, 'L', [PRIMARY])
      let doc = await barOpened(ctx, '⌘L')
      await barVisible(ctx, doc)
      const first = await field(doc)
      assert(first.value === addressOf(tab), `the field holds the apex:// address (got ${JSON.stringify(first.value)})`)
      assert(first.start === 0 && first.end === first.value.length, 'the apex:// address is selected')
      // Typing shows open tabs (and history) for what you typed; ↓ and ↑ move, ↑ from the first row restores it.
      await typeKeys(doc.ui, 'Known page')
      const rows = await rowsFor(doc, 'an open-tab row', (s) => s.rows.some((r) => r.title.includes('Known page')))
      assert(rows.rows.length >= 2, `more than one row to move through (got ${rows.rows.length})`)
      await press(doc.ui, 'Down')
      const down = await field(doc)
      assert(down.rows[0]?.selected, 'Down selects the first row')
      await press(doc.ui, 'Down')
      assert((await field(doc)).rows[1]?.selected, 'Down again selects the second row')
      await press(doc.ui, 'Up')
      await press(doc.ui, 'Up')
      const restored = await field(doc)
      assert(restored.value === 'Known page' && !restored.rows.some((r) => r.selected), `Up from the first row restores the typed text (got ${JSON.stringify(restored.value)})`)
      // Esc closes and the page keeps its address.
      await press(doc.ui, 'Escape')
      await barClosed('Esc')
      assert(addressOf(tab).startsWith('apex://first-week'), 'Esc leaves the page as it was')
      const pill = await ctx.chrome.js<string>(`return document.querySelector('.pill__text')?.textContent || ''`)
      assert(pill.length > 0 && !pill.includes('Known page'), `the pill shows the page again (got ${JSON.stringify(pill)})`)
      // Enter on an apex:// page goes there in the same tab.
      await clickOn(ctx.chrome, '.pill__text')
      doc = await barOpened(ctx, 'a click on the apex:// pill')
      assert((await field(doc)).value === addressOf(tab), 'the bar reopens with the address, not the abandoned text')
      await typeKeys(doc.ui, target)
      await rowsFor(doc, 'the Open row', (s) => s.rows[0]?.sub === 'Open')
      await press(doc.ui, 'Return')
      await barClosed('Enter')
      await waitFor(() => tab!.internalUrl === null && tab!.view.webContents.getURL() === target, 8000, `the apex:// tab to load the address (at ${addressOf(tab)})`)
      assert(ctx.tabs.activeId() === tab.id, 'Enter stays in the same tab')
    } finally {
      closeTab(ctx, tab)
      closeTab(ctx, known)
    }
  },
}

const newTabKeys: SmokeCheck = {
  name: '⌥Enter opens the address in a new tab in front, ⌘Enter in one behind; the horizontal layout’s pill works the same',
  async run(ctx) {
    const before = ctx.settings.get().layout
    const tab = await webTab(ctx, '/address-input-stay', 'Stay here')
    const front = route(ctx, '/address-input-front', 'In front')
    const behind = route(ctx, '/address-input-behind', 'Behind')
    const made: Tab[] = []
    try {
      for (const layout of ['sidebar', 'horizontal'] as const) {
        if (ctx.settings.get().layout !== layout) {
          ctx.settings.update({ layout })
          await ctx.chrome.until(`return document.querySelector('.app--${layout}') && document.querySelector('.pill__text') ? true : null`, 5000, `the ${layout} layout`)
          await sleep(300)
        }
        ctx.tabs.activate(tab.id)
        await sleep(150)
        // ⌥Enter: a new tab, in front.
        let ids = new Set(ctx.tabs.all().map((t) => t.id))
        await clickOn(ctx.chrome, '.pill__text')
        let doc = await barOpened(ctx, `a click in the ${layout} layout`)
        await barVisible(ctx, doc)
        await typeKeys(doc.ui, front)
        await rowsFor(doc, `the Open row for ⌥Enter (${layout})`, (s) => s.rows[0]?.sub === 'Open')
        await press(doc.ui, 'Return', ['alt'])
        await barClosed('⌥Enter')
        await waitFor(() => ctx.tabs.all().some((t) => !ids.has(t.id)), 5000, `⌥Enter to open a tab (${layout})`)
        const fresh = ctx.tabs.all().find((t) => !ids.has(t.id))!
        made.push(fresh)
        await waitFor(() => fresh.view.webContents.getURL() === front || fresh.requestedUrl === front, 8000, '⌥Enter’s tab to load the address')
        assert(ctx.tabs.activeId() === fresh.id, `⌥Enter’s tab comes to the front (${layout})`)
        assert(tab.view.webContents.getURL().endsWith('/address-input-stay'), 'the first tab keeps its page')
        // ⌘Enter: a new tab, behind.
        ctx.tabs.activate(tab.id)
        await sleep(150)
        ids = new Set(ctx.tabs.all().map((t) => t.id))
        await clickOn(ctx.chrome, '.pill__text')
        doc = await barOpened(ctx, `a second click in the ${layout} layout`)
        await typeKeys(doc.ui, behind)
        await rowsFor(doc, `the Open row for ⌘Enter (${layout})`, (s) => s.rows[0]?.sub === 'Open')
        await press(doc.ui, 'Return', [PRIMARY])
        await barClosed('⌘Enter')
        await waitFor(() => ctx.tabs.all().some((t) => !ids.has(t.id)), 5000, `⌘Enter to open a tab (${layout})`)
        const back = ctx.tabs.all().find((t) => !ids.has(t.id))!
        made.push(back)
        assert(ctx.tabs.activeId() === tab.id, `⌘Enter’s tab stays behind (${layout})`)
      }
    } finally {
      for (const t of made) closeTab(ctx, t)
      closeTab(ctx, tab)
      if (ctx.settings.get().layout !== before) ctx.settings.update({ layout: before })
      await sleep(300)
    }
  },
}

export const checks: SmokeCheck[] = [pillClick, searchNewTab, keysOnApexPage, newTabKeys]

/** A results page for the smoke engine that echoes the query (local, never fetched from an engine). */
function resultsRoute(ctx: SmokeContext, path: string): void {
  ctx.server.route(path, (_req, res, url) => {
    const q = (url.searchParams.get('q') ?? '').replace(/[<>&"]/g, '')
    const hit = (n: number): string => `<li style="margin:0 0 18px"><a href="#r${n}" style="color:#1a56b8;font-size:18px">Result ${n} for ${q}</a><div style="color:#4a5160">127.0.0.1 › result-${n}</div></li>`
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      `<!doctype html><html><head><title>${q} – Smoke Search</title></head><body style="font:15px system-ui;margin:0;padding:28px 40px;background:#fff;color:#1d2230"><form><input value="${q}" style="font:16px system-ui;width:420px;padding:8px 12px;border:1px solid #c9ccd4;border-radius:20px"></form><ol style="list-style:none;padding:0;margin:28px 0 0">${hit(1)}${hit(2)}${hit(3)}</ol></body></html>`,
    )
  })
}

export const shots: ShotSpec[] = [
  {
    // The bar open over a page with typed text and its suggestions (an open tab, the search row).
    name: 'address-command-bar-typed',
    async run(ctx) {
      const known = await webTab(ctx, '/address-input-shot-known', 'Zebrafinch field notes')
      const tab = await webTab(ctx, '/address-input-shot-page', 'Pill shot page')
      try {
        await clickOn(ctx.chrome, '.pill__text')
        const doc = await barOpened(ctx, 'a click on the pill')
        await typeKeys(doc.ui, 'zebrafinch')
        await rowsFor(doc, 'suggestions for the typed text', (s) => s.rows.length >= 2 && s.rows.some((r) => r.title.includes('Zebrafinch')))
        await sleep(250)
        await ctx.shot('address-command-bar-typed')
        await press(doc.ui, 'Escape')
        await barClosed('Esc')
      } finally {
        closeTab(ctx, tab)
        closeTab(ctx, known)
      }
    },
  },
  {
    // A search result tab: a query typed into the bar on a new tab, searched with the default engine (the smoke server).
    name: 'address-search-result',
    async run(ctx) {
      const base = ctx.server.https
      if (!base) return
      const before = ctx.settings.get()
      resultsRoute(ctx, '/address-input-shot-results')
      ctx.settings.update({
        customSearchEngines: [...before.customSearchEngines.filter((e) => e.id !== 'apex-smoke'), { id: 'apex-smoke', name: 'Smoke Search', template: `${base}/address-input-shot-results?q=%s` }],
        searchEngine: 'apex-smoke',
      })
      const tab = ctx.tabs.create('about:blank', { activate: true })
      try {
        await sleep(300)
        await clickOn(ctx.chrome, '.pill__text')
        const doc = await barOpened(ctx, 'a click on a new tab’s pill')
        await typeKeys(doc.ui, 'apex browser')
        await rowsFor(doc, 'the search row', (s) => s.rows[0]?.sub === 'Search with Smoke Search')
        await press(doc.ui, 'Return')
        await barClosed('Enter')
        // The fixture's certificate is self-signed: let it through as a person would, if it is not already.
        await waitFor(() => ctx.tabs.info(tab).pageError !== null || tab.view.webContents.getTitle().includes('Smoke Search'), 10_000, 'the results or the certificate page')
        if (ctx.tabs.info(tab).pageError) await ctx.chrome.invoke('pageErrors', 'proceed', tab.id)
        await waitForPage(tab.view.webContents, 'apex browser – Smoke Search', 10_000, (at) => at.includes('/address-input-shot-results'))
        await waitFor(() => !ctx.tabs.info(tab).loading, 5000, 'the results to finish loading')
        await sleep(300)
        await ctx.shot('address-search-result')
      } finally {
        closeTab(ctx, tab)
        ctx.settings.update({ customSearchEngines: before.customSearchEngines, searchEngine: before.searchEngine })
      }
    },
  },
]
