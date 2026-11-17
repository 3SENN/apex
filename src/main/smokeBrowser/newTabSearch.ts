/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, type WebContents } from 'electron'
import type { FirstWeekView } from '@shared/firstWeek'
import { assert, sleep, waitFor, type Chrome } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { Tab } from '../tabs'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// NT-01: browsing the web from a new tab, driven the way a person does it:
// real clicks on the start composer and key presses through
// webContents.sendInputEvent. Searches use a custom engine on the local
// smoke server and typed sites are the smoke server's pages, so nothing
// reaches the network.

type Mod = 'meta' | 'alt' | 'shift' | 'control'

const page = (title: string): string => `<!doctype html><html><head><title>${title}</title></head><body style="font:16px system-ui;padding:40px"><h1>${title}</h1></body></html>`

function route(ctx: SmokeContext, path: string, title: string): string {
  ctx.server.route(path, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(title))
  })
  return `${ctx.server.http}${path}`
}

interface Target {
  x: number
  y: number
  /** The element on top at that point is the target (or inside it). */
  hit: boolean
  /** What is on top there, for the message. */
  top: string
}

/** Describes an element in a script: its tag and classes. */
const DESCRIBE = `const describe = (el) => el ? el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '') : 'nothing'`

/**
 * A real click on the middle of an element in the chrome, once it holds still with nothing over it, as a
 * person clicks what they see: a new tab can still be settling (the layout the check before switched back,
 * the page's arrival) on a slow machine, and a click measured mid-move lands beside the field.
 */
async function clickOn(doc: Chrome, selector: string): Promise<void> {
  let last: Target | null = null
  let still = 0
  await waitFor(async () => {
    const now = await doc.js<Target | null>(`${DESCRIBE}
      const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.getClientRects().length === 0) return null
      const r = el.getBoundingClientRect(); const x = Math.round(r.left + Math.min(r.width / 2, 40)); const y = Math.round(r.top + r.height / 2)
      const top = document.elementFromPoint(x, y)
      return { x, y, hit: !!top && el.contains(top), top: describe(top) }`)
    still = now && last && now.x === last.x && now.y === last.y && now.hit ? still + 1 : 0
    last = now
    return still >= 2
  }, 5000, `${selector} to show`).catch((err: unknown) => {
    const seen = last as Target | null
    throw new Error(`${err instanceof Error ? err.message : String(err)} (${seen ? `at ${seen.x},${seen.y} the top element is ${seen.top}` : 'not there'})`)
  })
  const at = { x: (last as unknown as Target).x, y: (last as unknown as Target).y }
  const wc = doc.ui
  wc.focus()
  wc.sendInputEvent({ type: 'mouseMove', ...at })
  wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
  await sleep(80)
}

async function press(wc: WebContents, keyCode: string, modifiers: Mod[] = []): Promise<void> {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (keyCode === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await sleep(60)
}

async function typeKeys(wc: WebContents, text: string): Promise<void> {
  for (const ch of text) {
    const named = /^[a-z0-9]$/i.test(ch)
    if (named) wc.sendInputEvent({ type: 'keyDown', keyCode: ch })
    wc.sendInputEvent({ type: 'char', keyCode: ch })
    if (named) wc.sendInputEvent({ type: 'keyUp', keyCode: ch })
  }
  await sleep(150)
}

interface ComposerState {
  value: string
  focused: boolean
  placeholder: string
  mode: string | null
  send: string
  rows: { title: string; sub: string; key: string; selected: boolean; group: string }[]
  choosing: boolean
  /** The window has keyboard focus (the list only shows while the field is focused in a focused window). */
  windowFocus: boolean
  /** The element that has focus, for the message when it isn't the field. */
  active: string
}

const COMPOSER = `${DESCRIBE}
  const f = document.querySelector('.nt-composer__field'); if (!f) return null
  return { value: f.value, focused: document.activeElement === f, placeholder: f.placeholder, active: describe(document.activeElement),
    mode: document.querySelector('.nt-mode__option[aria-checked="true"]')?.getAttribute('data-mode') ?? null,
    send: document.querySelector('.nt-composer__send')?.getAttribute('aria-label') || '',
    choosing: !!document.querySelector('.nt-choose'), windowFocus: document.hasFocus(),
    rows: [...document.querySelectorAll('.nt-suggest__row')].map((r) => ({ title: (r.querySelector('.nt-suggest__title')?.textContent || '').trim(), sub: (r.querySelector('.nt-suggest__sub')?.textContent || '').trim(), key: (r.querySelector('.nt-suggest__key')?.textContent || '').trim(), selected: r.getAttribute('aria-selected') === 'true', group: r.closest('.nt-suggest__group')?.querySelector('.nt-suggest__label')?.textContent || '' })) }`

async function composer(ctx: SmokeContext): Promise<ComposerState> {
  const state = await ctx.chrome.js<ComposerState | null>(COMPOSER)
  assert(state, 'the new tab composer is there')
  return state
}

async function until(ctx: SmokeContext, what: string, ok: (s: ComposerState) => boolean): Promise<ComposerState> {
  let last: ComposerState | null = null
  await waitFor(async () => {
    last = await composer(ctx)
    return ok(last)
  }, 5000, what).catch((err: unknown) => {
    const s = last as ComposerState | null
    const brief = s ? `rows ${s.rows.length}, choosing ${s.choosing}, window focus ${s.windowFocus}, field focus ${s.focused}, focus on ${s.active}, mode ${s.mode}` : 'no composer'
    throw new Error(`${err instanceof Error ? err.message : String(err)} (${brief}; state: ${JSON.stringify(last)})`)
  })
  return last as unknown as ComposerState
}

/** A new tab in front, its composer clicked into (a real click), ready for keys. */
async function newTab(ctx: SmokeContext, mode: 'companion' | 'web'): Promise<Tab> {
  // Bring the window forward when the system allows it (the composer also works while it stays behind).
  BrowserWindow.fromWebContents(ctx.chrome.ui)?.focus()
  const tab = ctx.tabs.create('about:blank', { activate: true })
  await ctx.chrome.until(`return document.querySelector('.nt-composer__field:not([disabled])') && document.querySelector('.nt-mode__option[data-mode="${mode}"][aria-checked="true"]') ? true : null`, 8000, `the new tab composer in ${mode} mode`)
  await sleep(250)
  await clickOn(ctx.chrome, '.nt-composer__field')
  await until(ctx, 'the composer to take focus', (s) => s.focused)
  return tab
}

/** Waits for a tab to start loading `url` (it may never finish: the smoke server answers fast, but redirects are not followed here). */
async function loads(tab: Tab, url: string, what: string): Promise<void> {
  const started: string[] = []
  const wc = tab.view.webContents
  const onStart = (details: { url: string; isMainFrame: boolean }): void => {
    if (details.isMainFrame) started.push(details.url)
  }
  wc.on('did-start-navigation', onStart)
  try {
    await waitFor(() => started.includes(url) || tab.requestedUrl === url || wc.getURL() === url, 8000, `${what} (started: ${started.join(', ') || 'nothing'}, at: ${wc.getURL()})`)
  } finally {
    wc.off('did-start-navigation', onStart)
  }
}

function closeTab(ctx: SmokeContext, tab: Tab | undefined): void {
  if (tab && ctx.tabs.find(tab.id) && !tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
}

/** Points Settings › Search at the smoke server for the length of `body`. */
async function withSmokeEngine(ctx: SmokeContext, patch: { newTabMode: 'companion' | 'web'; searchEngineChosen?: boolean }, body: (base: string) => Promise<void>): Promise<void> {
  const base = ctx.server.https
  if (!base) return
  const before = ctx.settings.get()
  route(ctx, '/nt-search', 'New tab search results')
  ctx.settings.update({
    customSearchEngines: [...before.customSearchEngines.filter((e) => e.id !== 'atelier-smoke'), { id: 'atelier-smoke', name: 'Smoke Search', template: `${base}/nt-search?q=%s` }],
    searchEngine: 'atelier-smoke',
    searchEngineChosen: patch.searchEngineChosen ?? true,
    newTabMode: patch.newTabMode,
  })
  try {
    await body(base)
  } finally {
    ctx.settings.update({ customSearchEngines: before.customSearchEngines, searchEngine: before.searchEngine, searchEngineChosen: before.searchEngineChosen, newTabMode: before.newTabMode })
  }
}

const webModeSearch: SmokeCheck = {
  name: 'NT-01: in web mode, words typed into the new tab composer and Enter search the default engine in the same tab',
  async run(ctx) {
    await withSmokeEngine(ctx, { newTabMode: 'web' }, async (base) => {
      let tab: Tab | undefined
      try {
        tab = await newTab(ctx, 'web')
        const empty = await composer(ctx)
        assert(empty.placeholder.includes('Smoke Search'), `the placeholder names the engine (got ${JSON.stringify(empty.placeholder)})`)
        await typeKeys(ctx.chrome.ui, 'atelier web query')
        const typed = await until(ctx, 'the Search row first', (s) => s.rows[0]?.title === 'Search Smoke Search')
        assert(typed.rows[0]?.key === '↵' && typed.rows[0]?.sub === 'atelier web query', `Enter searches what was typed (rows: ${JSON.stringify(typed.rows)})`)
        assert(typed.rows[1]?.title.startsWith('Ask ') && typed.rows[1]?.key === '⌥↵', `asking the companion is on ⌥Enter (rows: ${JSON.stringify(typed.rows)})`)
        assert(typed.send === 'Search Smoke Search', `the send button searches (got ${JSON.stringify(typed.send)})`)
        await press(ctx.chrome.ui, 'Return')
        await loads(tab, `${base}/nt-search?q=atelier%20web%20query`, 'the new tab to search the default engine')
        assert(ctx.tabs.activeId() === tab.id, 'the search runs in the same tab')
        // NT-01: the getting-started item ticks on the first search from a new tab.
        const view = await ctx.chrome.invoke<FirstWeekView>('firstWeek', 'view')
        if (view.status === 'ready') {
          await waitFor(async () => (await ctx.chrome.invoke<FirstWeekView>('firstWeek', 'view')).items.find((i) => i.id === 'search-web')?.done === true, 3000, 'the “Search the web from a new tab” item to tick')
        }
      } finally {
        closeTab(ctx, tab)
      }
    })
  },
}

const companionModeKeys: SmokeCheck = {
  name: 'NT-01: in companion mode a typed site offers Go to first and Enter goes there; ⌥Enter on words searches instead of asking',
  async run(ctx) {
    await withSmokeEngine(ctx, { newTabMode: 'companion' }, async (base) => {
      const target = route(ctx, '/nt-typed', 'New tab typed site')
      const made: Tab[] = []
      try {
        // A typed site: Go to first, Enter loads it in this tab.
        const first = await newTab(ctx, 'companion')
        made.push(first)
        await typeKeys(ctx.chrome.ui, target.replace(/^http:\/\//, ''))
        const site = await until(ctx, 'the Go to row first', (s) => s.rows[0]?.title.startsWith('Go to ') === true)
        assert(site.rows[0]?.key === '↵', `Enter goes to the typed site (rows: ${JSON.stringify(site.rows)})`)
        assert(site.rows.some((r) => r.title === 'Search Smoke Search' && r.key === '⌥↵'), `Search is offered on ⌥Enter (rows: ${JSON.stringify(site.rows)})`)
        await press(ctx.chrome.ui, 'Return')
        await loads(first, target, 'the new tab to go to the typed site')
        await waitForPage(first.view.webContents, 'New tab typed site', 8000, (at) => at === target)
        assert(ctx.tabs.activeId() === first.id, 'the typed site opens in the same tab')
        // Words: Enter would ask; ⌥Enter searches the default engine instead.
        const second = await newTab(ctx, 'companion')
        made.push(second)
        await typeKeys(ctx.chrome.ui, 'atelier alt query')
        const words = await until(ctx, 'the Ask row first', (s) => s.rows[0]?.title.startsWith('Ask ') === true)
        assert(words.rows[1]?.title === 'Search Smoke Search' && words.rows[1]?.key === '⌥↵', `Search is the ⌥Enter row (rows: ${JSON.stringify(words.rows)})`)
        await press(ctx.chrome.ui, 'Return', ['alt'])
        await loads(second, `${base}/nt-search?q=atelier%20alt%20query`, '⌥Enter to search the default engine')
        assert(ctx.tabs.activeId() === second.id, '⌥Enter searches in the same tab')
        assert(!second.internalUrl?.startsWith('atelier://chat/'), '⌥Enter did not start a chat')
      } finally {
        for (const t of made) closeTab(ctx, t)
      }
    })
  },
}

const suggestionsAndEsc: SmokeCheck = {
  name: 'NT-01: typing on a new tab lists open tabs under the composer; ↓ and Enter switch to one, Esc clears',
  async run(ctx) {
    const known = ctx.tabs.create(route(ctx, '/nt-known', 'Zebrafinch notes'), { activate: false })
    let tab: Tab | undefined
    try {
      await waitForPage(known.view.webContents, 'Zebrafinch notes', 8000, (at) => at.endsWith('/nt-known'))
      tab = await newTab(ctx, ctx.settings.get().newTabMode === 'web' ? 'web' : 'companion')
      await typeKeys(ctx.chrome.ui, 'Zebrafinch')
      const listed = await until(ctx, 'the open tab under the composer', (s) => s.rows.some((r) => r.title.includes('Zebrafinch notes')))
      // Esc clears the field and the list.
      await press(ctx.chrome.ui, 'Escape')
      const cleared = await until(ctx, 'Esc to clear', (s) => s.value === '' && s.rows.length === 0)
      assert(cleared.focused, 'the composer keeps focus after Esc')
      // ↓ walks to the tab's row and Enter switches to it.
      await typeKeys(ctx.chrome.ui, 'Zebrafinch')
      const again = await until(ctx, 'the open tab again', (s) => s.rows.some((r) => r.title.includes('Zebrafinch notes')))
      const at = again.rows.findIndex((r) => r.title.includes('Zebrafinch notes'))
      assert(at >= 2 && listed.rows[0]?.title.length, `the actions lead, then the suggestions (rows: ${JSON.stringify(again.rows)})`)
      for (let i = 0; i <= at; i++) await press(ctx.chrome.ui, 'Down')
      const picked = await until(ctx, 'the tab row to be selected', (s) => s.rows[at]?.selected === true)
      assert(picked.rows[at]?.key === '↵', 'Enter now runs the selected row')
      await press(ctx.chrome.ui, 'Return')
      await waitFor(() => ctx.tabs.activeId() === known.id, 5000, 'Enter to switch to the open tab')
      const left = tab.view.webContents.getURL()
      assert(tab.internalUrl === null && (left === '' || left === 'about:blank'), `the new tab stays a new tab (at ${left})`)
    } finally {
      closeTab(ctx, tab)
      closeTab(ctx, known)
    }
  },
}

const switchAndChoice: SmokeCheck = {
  name: 'NT-01: a click on the switch remembers web mode for the profile, offering the engine once; Esc keeps the engine',
  async run(ctx) {
    await withSmokeEngine(ctx, { newTabMode: 'companion', searchEngineChosen: false }, async () => {
      let tab: Tab | undefined
      try {
        tab = await newTab(ctx, 'companion')
        await clickOn(ctx.chrome, '.nt-mode__option[data-mode="web"]')
        await waitFor(() => ctx.settings.get().newTabMode === 'web', 3000, 'web mode to be saved')
        const offered = await until(ctx, 'the one-time engine choice', (s) => s.choosing && s.mode === 'web')
        assert(offered.placeholder.includes('Smoke Search'), 'the field names the engine in web mode')
        await waitFor(async () => (await composer(ctx)).focused, 2000, 'focus back in the composer')
        await press(ctx.chrome.ui, 'Escape')
        await until(ctx, 'Esc to close the choice', (s) => !s.choosing)
        await waitFor(() => ctx.settings.get().searchEngineChosen === true, 3000, 'the choice to be marked made')
        assert(ctx.settings.get().searchEngine === 'atelier-smoke', 'Esc keeps the engine')
        // Once made, the choice is not offered again.
        await clickOn(ctx.chrome, '.nt-mode__option[data-mode="companion"]')
        await waitFor(() => ctx.settings.get().newTabMode === 'companion', 3000, 'companion mode to be saved')
        await clickOn(ctx.chrome, '.nt-mode__option[data-mode="web"]')
        await waitFor(() => ctx.settings.get().newTabMode === 'web', 3000, 'web mode again')
        await sleep(200)
        assert(!(await composer(ctx)).choosing, 'the engine choice shows only once')
      } finally {
        closeTab(ctx, tab)
      }
    })
  },
}

export const checks: SmokeCheck[] = [webModeSearch, companionModeKeys, suggestionsAndEsc, switchAndChoice]
export const shots: ShotSpec[] = [
  {
    // A new tab in web-search mode with words typed: Search first, Ask on ⌥Enter, then an open tab and history under the composer.
    name: 'newtab-web-search',
    async run(ctx) {
      const known = ctx.tabs.create(route(ctx, '/nt-shot-known', 'Zebrafinch field guide'), { activate: false })
      let tab: Tab | undefined
      try {
        await waitForPage(known.view.webContents, 'Zebrafinch field guide', 8000, (at) => at.endsWith('/nt-shot-known'))
        await withSmokeEngine(ctx, { newTabMode: 'web' }, async () => {
          tab = await newTab(ctx, 'web')
          await typeKeys(ctx.chrome.ui, 'zebrafinch')
          await until(ctx, 'the actions and suggestions', (s) => s.rows[0]?.title === 'Search Smoke Search' && s.rows.some((r) => r.title.includes('Zebrafinch field guide')))
          await sleep(250)
          await ctx.shot('newtab-web-search')
        })
      } finally {
        closeTab(ctx, tab)
        closeTab(ctx, known)
      }
    },
  },
]
