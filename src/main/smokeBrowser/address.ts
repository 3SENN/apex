/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { UI } from '@shared/ipc'
import { core } from '../app'
import { Chrome, assert, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import { addressSmoke } from '../features/address'
import { fittingCount } from '../../renderer/src/components/address'
import type { Tab } from '../tabs'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// The address feature's smoke checks and light and dark shots: the
// command bar's rows and commit, zoom per host, find, bookmarks with the
// editor and folders, and Apex's history, bookmarks and search pages. Pages
// come from the local smoke server; nothing reaches the network.

const PAGE = `<!doctype html><html><head><title>Address fixture</title>
<meta property="og:title" content="Address fixture"><meta name="description" content="A page for the address bar smoke checks."></head>
<body style="font:16px system-ui;padding:40px"><h1>Find me</h1><p>Find me twice: find me.</p>
<p><a id="link" href="/address-fixture?second">A link to another page</a></p></body></html>`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function fixtureTab(ctx: SmokeContext): Promise<Tab> {
  ctx.server.route('/address-fixture', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
  })
  const tab = ctx.tabs.create(`${ctx.server.http}/address-fixture`, { activate: true })
  await waitForPage(tab.view.webContents, 'the address fixture page', 8000, (at) => at.includes('/address-fixture'))
  return tab
}

function closeTab(ctx: SmokeContext, tab: Tab): void {
  if (!tab.view.webContents.isDestroyed()) ctx.tabs.close(tab.id)
}

async function surfaceOpen(surface: string, what: string): Promise<void> {
  await waitFor(() => addressSmoke.surfaces().includes(surface), 5000, what)
  await sleep(250)
}

async function surfaceGone(surface: string, what: string): Promise<void> {
  await waitFor(() => !addressSmoke.surfaces().includes(surface), 5000, what)
}

const omniboxRows: SmokeCheck = {
  name: 'address: the command bar ranks what you typed first and commits it in the tab',
  async run(ctx) {
    const tab = await fixtureTab(ctx)
    try {
      const groups = await ctx.chrome.invoke<{ group: string; rows: { action: unknown }[] }[]>('omnibox', 'query', 'example.com')
      assert(groups[0]?.group === 'typed', `the typed row leads (got ${groups.map((g) => g.group).join(', ')})`)
      const result = await ctx.chrome.invoke<{ ok: boolean }>('omnibox', 'commit', tab.id, 'address-fixture', { kind: 'navigate', url: `${ctx.server.http}/address-fixture?typed` })
      assert(result.ok, 'commit opens the address')
      await waitFor(() => tab.view.webContents.getURL().endsWith('?typed'), 8000, 'the committed address')
      await ctx.chrome.invoke('omnibox', 'setDraft', tab.id, 'half typed')
      assert((await ctx.chrome.invoke<string | null>('omnibox', 'draft', tab.id)) === 'half typed', 'drafts are kept per tab')
      await ctx.chrome.invoke('omnibox', 'setDraft', tab.id, null)
    } finally {
      closeTab(ctx, tab)
    }
  },
}

const zoomPerHost: SmokeCheck = {
  name: 'address: zoom steps 10% per host and resets',
  async run(ctx) {
    const tab = await fixtureTab(ctx)
    try {
      const up = await ctx.chrome.invoke<number>('zoom', 'step', tab.id, 1)
      assert(up === 110, `one step in is 110% (got ${up})`)
      assert((await ctx.chrome.invoke<number>('zoom', 'get', tab.id)) === 110, 'the level reads back')
      const reset = await ctx.chrome.invoke<number>('zoom', 'reset', tab.id)
      assert(reset === 100, 'reset goes back to 100%')
    } finally {
      closeTab(ctx, tab)
    }
  },
}

const findInPage: SmokeCheck = {
  name: 'address: find opens its bar, counts matches and closes keeping the selection',
  async run(ctx) {
    const tab = await fixtureTab(ctx)
    try {
      await ctx.chrome.invoke('find', 'open', tab.id)
      await surfaceOpen('find-bar', 'the find bar')
      await ctx.chrome.invoke('find', 'query', tab.id, 'find me')
      await waitFor(async () => (await ctx.chrome.invoke<{ matches: number }>('find', 'state', tab.id)).matches >= 3, 5000, 'three matches')
      await ctx.chrome.invoke('find', 'close', tab.id)
      await surfaceGone('find-bar', 'the find bar to close')
    } finally {
      closeTab(ctx, tab)
    }
  },
}

const bookmarksRoundTrip: SmokeCheck = {
  name: 'address: bookmarks add, move into a folder, remove and restore',
  async run(ctx) {
    const url = `${ctx.server.http}/address-fixture?bookmark`
    const link = await ctx.chrome.invoke<{ id: string }>('bookmarks', 'add', { url, title: 'Smoke bookmark' })
    const folder = await ctx.chrome.invoke<{ id: string }>('bookmarks', 'createFolder', 'bar', 'Smoke folder')
    await ctx.chrome.invoke('bookmarks', 'move', link.id, folder.id, 0)
    const found = await ctx.chrome.invoke<{ id: string } | null>('bookmarks', 'forUrl', url)
    assert(found?.id === link.id, 'the bookmark is found by its address')
    const removal = await ctx.chrome.invoke('bookmarks', 'removeItem', folder.id)
    assert((await ctx.chrome.invoke('bookmarks', 'forUrl', url)) === null, 'removing the folder removes its bookmark')
    await ctx.chrome.invoke('bookmarks', 'restore', removal)
    assert((await ctx.chrome.invoke<{ id: string } | null>('bookmarks', 'forUrl', url))?.id === link.id, 'Undo brings it back')
    await ctx.chrome.invoke('bookmarks', 'removeItem', folder.id)
  },
}

interface BarChip {
  title: string
  width: number
  cap: number
  right: number
  clipped: boolean
  cut: boolean
}
interface BarState {
  chips: BarChip[]
  natural: number[]
  available: number
  barRight: number
  overflowLeft: number | null
}

const BAR_STATE = `const bar = document.querySelector('.bookmarks-bar:not(.bookmarks-bar--empty)')
  if (!bar) return null
  const chips = [...bar.querySelectorAll(':scope > .bookmark-chip:not(.bookmark-chip--overflow)')].map((el) => {
    const title = el.querySelector('.bookmark-chip__title')
    const box = el.getBoundingClientRect()
    return { title: title ? title.textContent : '', width: box.width, cap: parseFloat(el.style.maxWidth) || 0, right: box.right, clipped: el.hasAttribute('data-clipped'), cut: title ? title.scrollWidth > title.clientWidth + 1 : false }
  })
  const natural = [...bar.querySelectorAll('.bookmarks-bar__measure > .bookmark-chip')].map((el) => el.offsetWidth)
  const overflow = bar.querySelector(':scope > .bookmark-chip--overflow')
  const style = getComputedStyle(bar)
  return { chips, natural, available: bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), barRight: bar.getBoundingClientRect().right - parseFloat(style.paddingRight), overflowLeft: overflow ? overflow.getBoundingClientRect().left : null }`

const bookmarksBarFits: SmokeCheck = {
  name: 'SH-47: the bookmarks bar follows its width: long titles shrink before the overflow, short ones stay whole, only cut titles fade, and a folder offers Open all (n)',
  async run(ctx) {
    const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
    assert(win, 'the first window')
    const before = ctx.settings.get().bookmarksBar
    const size = win.window.getContentSize()
    const titles = ['Ark', 'Team calendar - Agenda - Week overview for the whole team', 'LinkedIn', 'Reading list for the long weekend ahead', 'Docs', 'Quarterly planning board with every project', 'Mail', 'A very long bookmark title that goes on and on']
    const made: string[] = []
    let folderId: string | null = null
    ctx.settings.update({ bookmarksBar: 'always' })
    try {
      for (const [i, title] of titles.entries()) made.push((await ctx.chrome.invoke<{ id: string }>('bookmarks', 'add', { url: `${ctx.server.http}/address-fixture?bar=${i}`, title })).id)
      const folder = await ctx.chrome.invoke<{ id: string }>('bookmarks', 'createFolder', 'bar', 'Bar folder', 0)
      folderId = folder.id
      // The first two go into the folder (and leave with it).
      for (const [i, id] of made.splice(0, 2).entries()) await ctx.chrome.invoke('bookmarks', 'move', id, folder.id, i)
      win.window.setContentSize(1600, size[1] ?? 900)
      const wide = await ctx.chrome.until<BarState>(`const s = (() => { ${BAR_STATE} })(); return s && s.chips.some((c) => c.title === 'LinkedIn') ? s : null`, 8000, 'the bookmarks bar')
      for (const c of wide.chips) assert(c.clipped === c.cut, `"${c.title}" ${c.clipped ? 'fades but fits' : 'is cut without its fade'}`)
      assert(!wide.chips.find((c) => c.title === 'LinkedIn')?.clipped, 'a short title fades as if it were cut')

      // Narrow: the long titles shrink to a shared cap before items go behind the overflow button; short ones stay whole and none spill past it.
      win.window.setContentSize(980, size[1] ?? 900)
      await sleep(400)
      const narrow = await ctx.chrome.until<BarState>(`return (() => { ${BAR_STATE} })()`, 4000, 'the narrow bar')
      await ctx.shot('bookmarks-bar-narrow')
      const edge = narrow.overflowLeft ?? narrow.barRight
      const last = narrow.chips.at(-1)
      assert(last && last.right <= edge + 1, `the last item spills past the bar (${Math.round(last?.right ?? 0)} > ${Math.round(edge)})`)
      for (const [i, c] of narrow.chips.entries()) {
        const natural = narrow.natural[i] ?? 0
        assert(c.width <= Math.max(c.cap, 0) + 1, `"${c.title}" is wider than the bar's cap (${Math.round(c.width)} > ${c.cap})`)
        if (natural <= c.cap) assert(Math.abs(c.width - natural) <= 1, `"${c.title}" fits the cap but was cut (${Math.round(c.width)} of ${natural})`)
        assert(c.width >= Math.min(natural, 120) - 1, `"${c.title}" shrank below the floor (${Math.round(c.width)})`)
        assert(c.clipped === c.cut, `"${c.title}" ${c.clipped ? 'fades but fits' : 'is cut without its fade'}`)
      }
      const naturalFit = fittingCount(narrow.natural.map((w) => w + 2), narrow.available)
      assert(narrow.chips.length >= naturalFit, `fewer items show (${narrow.chips.length}) than fit at full width (${naturalFit})`)
      assert(narrow.chips.length < narrow.natural.length ? narrow.overflowLeft !== null : true, 'items are hidden without the overflow button')

      // The folder's panel counts its links.
      win.window.setContentSize(1600, size[1] ?? 900)
      await ctx.chrome.until(`return document.querySelector('[data-bookmark="${folder.id}"]')`, 4000, 'the folder item')
      await ctx.chrome.js(`document.querySelector('[data-bookmark="${folder.id}"]').click(); return true`)
      await surfaceOpen('bookmark-folder', 'the folder panel')
      const label = await new Chrome(win.overlay.tierWebContents('interactive')!).js<string>(`return [...document.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent).find((t) => t.startsWith('Open all')) ?? ''`)
      assert(label === 'Open all (2)', `the folder panel reads "${label}"`)
      win.overlay.closeAll((s) => s === 'bookmark-folder')
    } finally {
      win.overlay.closeAll((s) => s === 'bookmark-folder')
      win.window.setContentSize(size[0] ?? 1440, size[1] ?? 900)
      for (const id of [...made, ...(folderId ? [folderId] : [])]) await ctx.chrome.invoke('bookmarks', 'removeItem', id).catch(() => undefined)
      ctx.settings.update({ bookmarksBar: before })
    }
  },
}

export const checks: SmokeCheck[] = [omniboxRows, zoomPerHost, findInPage, bookmarksRoundTrip, bookmarksBarFits]

const pageShot = (name: string, url: string, selector: string, what: string): ShotSpec => ({
  name,
  async run(ctx) {
    ctx.tabs.openInternal(url)
    await ctx.chrome.until(`return document.querySelector(${JSON.stringify(selector)}) ? true : null`, 8000, what)
    await sleep(200)
    await ctx.shot(name)
  },
})

export const shots: ShotSpec[] = [
  {
    name: 'address-command-bar',
    async run(ctx) {
      const tab = await fixtureTab(ctx)
      try {
        await ctx.chrome.js(`document.querySelector('.pill__text')?.click(); true`)
        await surfaceOpen('command-bar', 'the command bar')
        await ctx.shot('address-command-bar')
        await ctx.chrome.escape()
      } finally {
        closeTab(ctx, tab)
      }
    },
  },
  {
    name: 'address-find-bar',
    async run(ctx) {
      const tab = await fixtureTab(ctx)
      try {
        await ctx.chrome.invoke('find', 'open', tab.id)
        await ctx.chrome.invoke('find', 'query', tab.id, 'find me')
        await surfaceOpen('find-bar', 'the find bar')
        await ctx.shot('address-find-bar')
        await ctx.chrome.invoke('find', 'close', tab.id)
      } finally {
        closeTab(ctx, tab)
      }
    },
  },
  {
    name: 'address-zoom-chip',
    async run(ctx) {
      const tab = await fixtureTab(ctx)
      try {
        await ctx.chrome.invoke('zoom', 'step', tab.id, 1)
        await ctx.chrome.until(`return document.querySelector('.pill__zoom') ? true : null`, 5000, 'the zoom chip')
        await ctx.chrome.js(`document.querySelector('.pill__zoom')?.click(); true`)
        await surfaceOpen('zoom-popover', 'the zoom popover')
        await ctx.shot('address-zoom-chip')
        await ctx.chrome.invoke('zoom', 'reset', tab.id)
      } finally {
        closeTab(ctx, tab)
      }
    },
  },
  {
    name: 'address-universal-search',
    async run(ctx) {
      const tab = await fixtureTab(ctx)
      try {
        ctx.chrome.ui.send(UI.command, 'open-universal-search')
        await surfaceOpen('universal-search', 'universal search')
        await ctx.shot('address-universal-search')
        await ctx.chrome.escape()
      } finally {
        closeTab(ctx, tab)
      }
    },
  },
  pageShot('address-history', 'apex://history', '.sp-toolbar', 'the history page'),
  pageShot('address-bookmarks', 'apex://bookmarks', '.sp-toolbar', 'the bookmarks page'),
  pageShot('address-search-settings', 'apex://settings/search', '.se-list', 'Settings › Search'),
]
