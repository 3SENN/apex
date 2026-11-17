/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { core } from '../app'
import { commands } from '../commands'
import type { SmokeGroup, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import { assert, sleep, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import { checkLayout, type LayoutSnapshot } from '../smokeLayout/check'
import { COLLECT_SCRIPT, SETTLE_SCRIPT } from '../smokeLayout/collect'
import { LAYOUT_SIZES, sizeLabel } from '../smokeLayout/pages'
import { UI } from '@shared/ipc'
import type { Tab } from '../tabs'

// The reader's smoke checks (APEX_SMOKE_ONLY=READER): the local article
// fixture (tests/fixtures/reader) on the smoke server, its images served
// there too, so nothing leaves the machine. Driven through the chrome's own
// DOM, the command registry and main's state; read aloud is left to the unit
// tests, so the run makes no sound.

const fixtures = (): string => process.env.APEX_SMOKE_FIXTURES ?? join(app.getAppPath(), 'tests/fixtures')
/** A 1×1 PNG for the article's images. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
const TITLE = 'How Tide Pools Keep Time'

interface Fixture {
  article: string
  front: string
}

let served: Fixture | null = null

function serve(ctx: SmokeContext): Fixture {
  if (served) return served
  // The fixture's one outside frame would be a request off the machine: it points nowhere instead.
  const article = readFileSync(join(fixtures(), 'reader', 'article.html'), 'utf8').replace(/<iframe[^>]*><\/iframe>/g, '<iframe src="about:blank"></iframe>')
  ctx.server.page('/reader/tide-pools', article)
  ctx.server.page('/reader/shop', readFileSync(join(fixtures(), 'reader', 'front-page.html'), 'utf8'))
  for (const image of ['/images/pool.jpg', '/images/crab.jpg']) {
    ctx.server.route(image, (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(PIXEL)
    })
  }
  served = { article: `${ctx.server.http}/reader/tide-pools`, front: `${ctx.server.http}/reader/shop` }
  return served
}

const winOf = (ctx: SmokeContext) => {
  const win = core()?.windows.fromWebContents(ctx.chrome.ui.id) ?? null
  assert(win, 'no window for the chrome')
  return win
}

async function openArticle(ctx: SmokeContext): Promise<Tab> {
  const { article } = serve(ctx)
  const tab = ctx.tabs.create(article, { activate: true })
  await waitForPage(tab.view.webContents, 'the article fixture to load')
  await waitFor(() => ctx.tabs.info(tab).reader === 'available', 10_000, 'the article page to report that it reads as an article')
  return tab
}

const READER_SHOWN = `const el = document.querySelector('.reader .reader__title'); return el && el.textContent === ${JSON.stringify(TITLE)} ? true : null`

async function showReader(ctx: SmokeContext, tab: Tab): Promise<void> {
  // The pill hides its button by design when it is 260 px or narrower (a small screen with the side panel open, as on CI);
  // the reader then opens the way ⌥⌘R opens it. The check named for the button clicks it itself.
  const how = await ctx.chrome.until<string>(`const b = document.querySelector('.pill__reader'); if (!b) return null; if (b.getClientRects().length === 0) return 'hidden'; b.click(); return 'clicked'`, 5000, 'the pill’s reader button')
  if (how === 'hidden') await ctx.chrome.invoke('reader', 'toggle', tab.id)
  await ctx.chrome.until(READER_SHOWN, 8000, 'the reader to show the article')
  assert(ctx.tabs.isChromeDrawn(tab), 'the page view is hidden under the reader')
}

function closeTab(ctx: SmokeContext, tab: Tab | undefined): void {
  if (tab && ctx.tabs.find(tab.id) && !tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
}

const checks: SmokeCheck[] = [
  {
    name: 'reader: an article page offers the reader, a shop front does not',
    async run(ctx) {
      const { front } = serve(ctx)
      const tab = await openArticle(ctx)
      const shop = ctx.tabs.create(front, { activate: false })
      try {
        await ctx.chrome.until(`const b = document.querySelector('.pill__reader'); return b && b.getClientRects().length > 0 && b.getAttribute('aria-pressed') === 'false' ? true : null`, 5000, 'the reader button in the pill')
        await waitForPage(shop.view.webContents, 'the shop front fixture to load')
        // The page looks again 2 s after load; give it that long to (not) report.
        await sleep(2600)
        assert(ctx.tabs.info(shop).reader === undefined, 'the shop front offers no reader')
        assert(commands.available(winOf(ctx))['toggle-reader']?.enabled === true, 'View › Reader is enabled on the article')
      } finally {
        closeTab(ctx, shop)
        closeTab(ctx, tab)
      }
    },
  },
  {
    name: 'reader: the pill button opens the article over the pane, cleaned of page parts',
    async run(ctx) {
      const tab = await openArticle(ctx)
      try {
        await showReader(ctx, tab)
        const found = await ctx.chrome.js<{ meta: string; images: string[]; loaded: boolean; links: string[]; bad: number; focused: boolean; pressed: string | null; site: string; byline: string }>(`
          const r = document.querySelector('.reader')
          const imgs = [...r.querySelectorAll('.reader__body img')]
          return {
            meta: r.querySelector('.reader__meta')?.textContent || '',
            images: imgs.map((i) => i.getAttribute('src')),
            loaded: imgs[0] ? imgs[0].complete : false,
            links: [...r.querySelectorAll('.reader__body a[href]')].map((a) => a.getAttribute('href')),
            bad: r.querySelectorAll('.reader__body script, .reader__body iframe, .reader__body form, .reader__body button, .reader__body nav').length,
            focused: document.activeElement === r.querySelector('.reader__scroll'),
            pressed: document.querySelector('.pill__reader')?.getAttribute('aria-pressed') ?? null,
            site: r.querySelector('.reader__site')?.textContent || '',
            byline: r.querySelector('.reader__byline')?.textContent || '',
          }`)
        assert(/min read/.test(found.meta), `the reading time shows (${found.meta})`)
        assert(found.site === 'The Shoreline Journal' && found.byline === 'Mara Okafor', `site and byline (${found.site}, ${found.byline})`)
        assert(found.images.length === 2 && found.images.every((s) => s?.startsWith(ctx.server.http)), `both images, from the page's server (${found.images.join(', ')})`)
        assert(found.links.includes('https://example.org/research/tidal-clocks') && found.links.includes('#reader-notes'), `links and jumps (${found.links.join(', ')})`)
        assert(!found.links.some((l) => l?.startsWith('javascript:')), 'no script links')
        assert(found.bad === 0, 'no scripts, frames, forms, buttons or navigation in the article')
        assert(found.focused, 'focus is on the article')
        assert(found.pressed === 'true', 'the pill button is pressed')
        assert(commands.available(winOf(ctx))['toggle-reader']?.checked === true, 'View › Reader is checked')
      } finally {
        closeTab(ctx, tab)
      }
    },
  },
  {
    name: 'reader: Text and page changes the colours and size, and ⌘+ sizes the text',
    async run(ctx) {
      const before = ctx.settings.get()
      const tab = await openArticle(ctx)
      try {
        await showReader(ctx, tab)
        await ctx.chrome.until(`const b = document.querySelector('.reader__bar button[aria-controls="reader-appearance"]'); if (!b) return null; b.click(); return true`, 3000, 'the Text and page button')
        await ctx.chrome.until(`const b = document.querySelector('#reader-appearance .reader__theme--sepia'); if (!b) return null; b.click(); return true`, 3000, 'the sepia choice')
        const bg = await ctx.chrome.until<string>(`const r = document.querySelector('.reader[data-surface="sepia"]'); return r ? getComputedStyle(r).backgroundColor : null`, 3000, 'the sepia page')
        assert(bg === 'rgb(246, 238, 221)', `the sepia paper (${bg})`)
        await ctx.chrome.js(`const b = [...document.querySelectorAll('#reader-appearance button')].find((x) => x.getAttribute('aria-label') === 'Larger text'); b?.click(); return true`)
        await waitFor(() => ctx.settings.get().readerTextSize === 22, 3000, 'A+ to make the text 22 px')
        await commands.run('zoom-in', winOf(ctx))
        await waitFor(() => ctx.settings.get().readerTextSize === 24, 3000, '⌘+ to size the reader text')
        await ctx.chrome.until(`const r = document.querySelector('.reader'); return r && r.style.getPropertyValue('--reader-size') === '24px' ? true : null`, 3000, 'the column to take the new size')
        assert(tab.view.webContents.getZoomFactor() === 1, 'the hidden page keeps its zoom')
        // Escape closes the panel.
        await ctx.chrome.js(`document.querySelector('#reader-appearance')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
        await ctx.chrome.until(`return document.querySelector('#reader-appearance') ? null : true`, 3000, 'Escape to close the panel')
      } finally {
        ctx.settings.update({ readerTheme: before.readerTheme, readerTextSize: before.readerTextSize })
        closeTab(ctx, tab)
      }
    },
  },
  {
    name: 'reader: Ask the companion quotes the article in the side panel',
    async run(ctx) {
      const tab = await openArticle(ctx)
      try {
        await showReader(ctx, tab)
        await ctx.chrome.until(`const b = [...document.querySelectorAll('.reader__bar button')].find((x) => /about this article/.test(x.getAttribute('aria-label') || '')); if (!b) return null; b.click(); return true`, 3000, 'the Ask button')
        await ctx.chrome.until(
          `const host = ${JSON.stringify(new URL(ctx.server.http).host)}; const chips = [...document.querySelectorAll('.panel-frame .quote-chip, .panel-frame .cmp-chip')]; return chips.some((c) => (c.textContent || '').includes(host) || (c.textContent || '').includes('127.0.0.1')) ? true : null`,
          8000,
          'the article quoted in the panel’s composer',
        )
      } finally {
        if (await ctx.chrome.js<boolean>(`return Boolean(document.querySelector('.panel-frame:not([data-state="closing"]) .chat-panel'))`)) ctx.chrome.ui.send(UI.command, 'toggle-agent')
        closeTab(ctx, tab)
      }
    },
  },
  {
    name: 'reader: lays out at every width, and beside the panel',
    async run(ctx) {
      const window = BrowserWindow.fromWebContents(ctx.chrome.ui)
      assert(window, 'no browser window')
      const size0 = window.getContentSize()
      const tab = await openArticle(ctx)
      const issues: string[] = []
      try {
        await showReader(ctx, tab)
        for (const size of LAYOUT_SIZES) {
          window.setContentSize(size.width, size.height)
          const panelShown = await ctx.chrome.js<boolean>(`return Boolean(document.querySelector('.panel-frame:not([data-state="closing"]) .chat-panel'))`)
          if (panelShown !== size.panel) ctx.chrome.ui.send(UI.command, 'toggle-agent')
          await sleep(200)
          await ctx.chrome.js(SETTLE_SCRIPT.replace('__MAX__', '2500'))
          await ctx.chrome.until(READER_SHOWN, 5000, 'the reader after resizing')
          const snap = await ctx.chrome.js<LayoutSnapshot>(COLLECT_SCRIPT)
          // The reader's own surfaces: the view and its pill button (the rest of the window has its own audit).
          for (const issue of checkLayout(snap).filter((f) => /reader/.test(`${f.selector} ${f.detail}`))) issues.push(`${sizeLabel(size.width, size.height, size.panel)}: ${issue.kind} ${issue.selector} "${issue.text}" (${issue.detail})`)
          await ctx.shot(`reader-${size.width}${size.panel ? '-panel' : ''}`)
        }
      } finally {
        if (await ctx.chrome.js<boolean>(`return Boolean(document.querySelector('.panel-frame:not([data-state="closing"]) .chat-panel'))`)) ctx.chrome.ui.send(UI.command, 'toggle-agent')
        window.setContentSize(size0[0] ?? 1440, size0[1] ?? 900)
        closeTab(ctx, tab)
      }
      assert(issues.length === 0, `layout findings:\n${issues.slice(0, 12).join('\n')}`)
    },
  },
  {
    name: 'reader: leaving, ⌥⌘R and a new page all bring the page back',
    async run(ctx) {
      const { front } = serve(ctx)
      const tab = await openArticle(ctx)
      try {
        await showReader(ctx, tab)
        await ctx.chrome.until(`const b = [...document.querySelectorAll('.reader__bar button')].find((x) => x.getAttribute('aria-label') === 'Leave the reader'); if (!b) return null; b.click(); return true`, 3000, 'the leave button')
        await waitFor(() => !ctx.tabs.isChromeDrawn(tab) && ctx.tabs.info(tab).reader === 'available', 3000, 'the page to show again')
        await ctx.chrome.until(`return document.querySelector('.reader') ? null : true`, 3000, 'the reader to go')
        // The shortcut's command opens and closes it too.
        await commands.run('toggle-reader', winOf(ctx))
        await ctx.chrome.until(READER_SHOWN, 8000, '⌥⌘R to open the reader')
        await commands.run('toggle-reader', winOf(ctx))
        await waitFor(() => ctx.tabs.info(tab).reader === 'available', 3000, '⌥⌘R to close the reader')
        // A new document in the tab closes an open reader.
        await commands.run('toggle-reader', winOf(ctx))
        await ctx.chrome.until(READER_SHOWN, 8000, 'the reader again')
        void tab.view.webContents.loadURL(front)
        await waitFor(() => ctx.tabs.info(tab).reader === undefined && !ctx.tabs.isChromeDrawn(tab), 8000, 'a new page to close the reader')
        await ctx.chrome.until(`return document.querySelector('.reader') ? null : true`, 3000, 'the reader to go after navigating')
      } finally {
        closeTab(ctx, tab)
      }
    },
  },
]

export const readerSmoke: SmokeGroup = {
  group: 'READER',
  checks,
  shots: [],
}
