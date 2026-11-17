/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type Chrome, assert, sleep, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// The close X on a row, pressed the way a person does it: the wheel brings a
// row that is out of view (under the faded edge, an edge pill or the footer)
// fully into view, the pointer moves onto the row (which brings the X in),
// then a real press and release on the X's centre through
// webContents.sendInputEvent. The X counts as in only once it has faded in,
// unclipped and what its centre hits. Covers sidebar tab rows (the
// active one with its chip, and an inactive one), an open chat in the Chats
// section, and a tab in the horizontal strip. Pages come from the 127.0.0.1
// fixture server and replies from the offline stand-in.

type Rect = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }

const chatPage = (id: string): string => `atelier://chat/${id}`

function route(ctx: SmokeContext, path: string, title: string): string {
  ctx.server.route(path, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`)
  })
  return `${ctx.server.http}${path}`
}

async function setLayout(ctx: SmokeContext, layout: 'sidebar' | 'horizontal'): Promise<void> {
  if (ctx.settings.get().layout === layout) return
  ctx.settings.update({ layout })
  await ctx.chrome.until(`return document.querySelector('.app--${layout}') ? true : null`, 5000, `the ${layout} layout`)
  await sleep(300)
}

const centre = (r: Rect): Point => ({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })

function move(doc: Chrome, at: Point): void {
  doc.ui.sendInputEvent({ type: 'mouseMove', ...at })
}

/** What the page would hit at a point, and whether it is (inside) the X. */
async function hitAt(doc: Chrome, at: Point, closeSelector: string): Promise<{ onX: boolean; hit: string; opacity: string }> {
  return doc.js(
    `const el = document.elementFromPoint(${at.x}, ${at.y})
     const x = document.querySelector(${JSON.stringify(closeSelector)})
     const name = (e) => e ? e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '') : 'nothing'
     return { onX: Boolean(el && x && x.contains(el)), hit: name(el) + ' < ' + name(el?.parentElement) + ' < ' + name(el?.parentElement?.parentElement), opacity: x ? getComputedStyle(x).opacity : 'no X' }`,
  )
}

/** Where a row sits in the sidebar's scrolling list, and whether a person can see all of it. */
interface Placement {
  row: Rect
  /** The row's centre less the list's (CSS px); 0 for a row outside the list. */
  offset: number
  /** The list's centre, where the wheel goes. */
  at: Point | null
  scrollTop: number
  /** Inside the list, clear of its faded edges and the edge pills, and the row is what's under its centre. */
  clear: boolean
}

async function placement(doc: Chrome, row: string): Promise<Placement | null> {
  return doc.js<Placement | null>(
    `const el = document.querySelector(${JSON.stringify(row)}); if (!el || el.getClientRects().length === 0) return null
     const r = el.getBoundingClientRect(); const rect = { x: r.left, y: r.top, width: r.width, height: r.height }
     const list = el.closest('.side-scroll__list')
     if (!list) return { row: rect, offset: 0, at: null, scrollTop: 0, clear: true }
     const box = list.getBoundingClientRect(); const scroll = list.parentElement
     // A faded edge (and the pill on it) hides the rows under it: the band is the pill's inset and height plus the fade.
     const band = (side) => scroll.classList.contains('side-scroll--fade-' + side) ? 4 + (scroll.querySelector(':scope > .edge-badge--' + side) ? 24 : 0) + 22 : 0
     const top = box.top + band('top'), bottom = box.bottom - band('bottom')
     const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
     return {
       row: rect,
       offset: (r.top + r.height / 2) - (box.top + box.height / 2),
       at: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
       scrollTop: list.scrollTop,
       clear: r.top >= top - 0.5 && r.bottom <= bottom + 0.5 && Boolean(hit && el.contains(hit)),
     }`,
  )
}

/**
 * Brings the row into full view the way a person does: the wheel over the
 * list, toward the row, until all of it shows clear of the faded edges, the
 * edge pills and the footer (a row near the end of a long list starts under
 * them). Returns the row's rect once it is in view.
 */
async function reveal(doc: Chrome, row: string, what: string): Promise<Rect> {
  // Chromium's wheel deltas run opposite to scrollTop; flipped if this build disagrees.
  let sign = -1
  let last: Placement | null = null
  for (let step = 0; step < 24; step++) {
    const p = await placement(doc, row)
    assert(p, `${what}: the row is in the sidebar`)
    if (p.clear) {
      // Settled: the same place twice running (the row may still be sliding in).
      if (last?.clear && Math.abs(last.row.y - p.row.y) < 0.5 && Math.abs(last.row.height - p.row.height) < 0.5) return p.row
      last = p
      await sleep(120)
      continue
    }
    assert(p.at, `${what}: the row is out of view outside the scrolling list`)
    if (last && !last.clear && last.scrollTop === p.scrollTop && step > 1) sign = -sign
    last = p
    const delta = Math.max(-360, Math.min(360, Math.round(p.offset)))
    doc.ui.sendInputEvent({ type: 'mouseWheel', ...p.at, deltaX: 0, deltaY: sign * delta, canScroll: true })
    await sleep(220)
  }
  const p = await placement(doc, row)
  throw new Error(`${what}: the row never came into full view by scrolling (${JSON.stringify(p)})`)
}

/** The X is drawn, faded in (the strip's rests at 0.75), not clipped by its slot, and it is what a press at its centre lands on. */
async function xShown(doc: Chrome, close: string): Promise<{ rect: Rect; opacity: string; hit: string } | null> {
  return doc.js(
    `const x = document.querySelector(${JSON.stringify(close)}); if (!x || x.getClientRects().length === 0) return null
     const r = x.getBoundingClientRect(); const slot = x.parentElement?.getBoundingClientRect()
     const opacity = getComputedStyle(x).opacity
     const inSlot = !slot || (r.left >= slot.left - 0.5 && r.right <= slot.right + 0.5)
     const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
     const name = (e) => e ? e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '') : 'nothing'
     return { rect: { x: r.left, y: r.top, width: r.width, height: r.height }, opacity, hit: Number(opacity) >= 0.5 && inSlot && hit && x.contains(hit) ? 'x' : name(hit) }`,
  )
}

/**
 * Scrolls `row` into view, hovers it, waits for `close` (the X inside it) to
 * come in and presses it with real input; `gone` must turn true afterwards.
 */
async function pressX(ctx: SmokeContext, row: string, close: string, gone: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const doc = ctx.chrome
  await doc.until<boolean>(`return document.querySelector(${JSON.stringify(row)})?.getClientRects().length ? true : null`, 6000, `${what}: the row`)
  doc.ui.focus()
  const rowRect = await reveal(doc, row, what)
  // Onto the row's left half (the title), then let the X fade and slide in.
  move(doc, { x: Math.round(rowRect.x + Math.min(rowRect.width / 3, 40)), y: Math.round(rowRect.y + rowRect.height / 2) })
  await sleep(60)
  move(doc, { x: Math.round(rowRect.x + rowRect.width / 2), y: Math.round(rowRect.y + rowRect.height / 2) })
  let shown: Awaited<ReturnType<typeof xShown>> = null
  await waitFor(
    async () => {
      shown = await xShown(doc, close)
      return shown?.hit === 'x'
    },
    3000,
  ).catch(() => {
    throw new Error(`${what}: the close X never came in on hover (${JSON.stringify(shown)})`)
  })
  const x = (shown as unknown as { rect: Rect }).rect
  const at = centre(x)
  move(doc, at)
  await sleep(120)
  const hit = await hitAt(doc, at, close)
  doc.ui.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
  await sleep(30)
  doc.ui.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
  const closed = await waitFor(gone, 3000, what).then(
    () => true,
    () => false,
  )
  assert(closed, `${what}: pressing the X at ${JSON.stringify(at)} closed nothing (the X ${JSON.stringify(x)}, opacity ${hit.opacity}; the point hits ${hit.hit})`)
  assert(hit.onX, `${what}: the X's centre hits ${hit.hit}, not the X`)
}

function cleanup(ctx: SmokeContext, ids: readonly string[]): void {
  for (const id of ids) if (ctx.tabs.find(id) && ctx.tabs.all().length > 1) ctx.tabs.close(id, { asked: true })
}

const sidebarTabs: SmokeCheck = {
  name: 'close X: a real press on a sidebar tab row’s X closes the tab, on the active row (its chip) and an inactive one',
  async run(ctx) {
    const layout = ctx.settings.get().layout
    const home = ctx.tabs.activeId()
    const a = ctx.tabs.create(route(ctx, '/close-x/a', 'Close X one'), { activate: true })
    // Enough rows that the inactive one starts below the fold, under the faded edge and the footer:
    // its X is pressed after scrolling down to it, the active row's after scrolling back up.
    const fillers = Array.from({ length: 16 }, (_, i) => ctx.tabs.create(route(ctx, `/close-x/fill-${i}`, `Close X filler ${i + 1}`), { activate: false }))
    const b = ctx.tabs.create(route(ctx, '/close-x/b', 'Close X two'), { activate: false })
    try {
      await setLayout(ctx, 'sidebar')
      const rowOf = (id: string): string => `.sidebar .tabs-section .tab-row[data-tab-ids="${id}"]`
      // The inactive row first, then the active row with its chip.
      await pressX(ctx, rowOf(b.id), `${rowOf(b.id)} .side-row__close`, () => !ctx.tabs.find(b.id), 'the inactive tab row')
      ctx.tabs.activate(a.id)
      await ctx.chrome.until(`return document.querySelector(${JSON.stringify(`${rowOf(a.id)}.side-row--active`)}) ? true : null`, 5000, 'the row to take the chip')
      await pressX(ctx, rowOf(a.id), `${rowOf(a.id)} .side-row__close`, () => !ctx.tabs.find(a.id), 'the active tab row')
    } finally {
      cleanup(ctx, [a.id, b.id, ...fillers.map((f) => f.id)])
      if (home && ctx.tabs.find(home)) ctx.tabs.activate(home)
      await setLayout(ctx, layout === 'horizontal' ? 'horizontal' : 'sidebar')
    }
  },
}

const sidebarChats: SmokeCheck = {
  name: 'close X: a real press on an open chat’s X in the Chats section closes it, active and inactive',
  async run(ctx) {
    const layout = ctx.settings.get().layout
    const home = ctx.tabs.activeId()
    const one = ctx.host.start('Close X chat one')
    const two = ctx.host.start('Close X chat two')
    await waitFor(() => !ctx.host.isRunning(one) && !ctx.host.isRunning(two), 10_000, 'the chats to finish')
    const t1 = ctx.tabs.create(chatPage(one), { activate: false })
    const t2 = ctx.tabs.create(chatPage(two), { activate: true })
    try {
      await setLayout(ctx, 'sidebar')
      const rowOf = (id: string): string => `.sidebar .chats-section .chat-row[data-drop-id="${id}"]`
      const gone = (id: string, tabId: string) => async () => !ctx.tabs.find(tabId) && !(await ctx.chrome.js<boolean>(`return Boolean(document.querySelector(${JSON.stringify(rowOf(id))}))`))
      await ctx.chrome.until(`return document.querySelector(${JSON.stringify(`${rowOf(two)}.side-row--active`)}) && document.querySelector(${JSON.stringify(rowOf(one))}) ? true : null`, 6000, 'both chats in the Chats section, the second active')
      await pressX(ctx, rowOf(one), `${rowOf(one)} .side-row__close`, gone(one, t1.id), 'the inactive chat row')
      await pressX(ctx, rowOf(two), `${rowOf(two)} .side-row__close`, gone(two, t2.id), 'the active chat row')
    } finally {
      cleanup(ctx, [t1.id, t2.id])
      if (home && ctx.tabs.find(home)) ctx.tabs.activate(home)
      await setLayout(ctx, layout === 'horizontal' ? 'horizontal' : 'sidebar')
    }
  },
}

const stripTabs: SmokeCheck = {
  name: 'close X: a real press on a strip tab’s X closes the tab, active and inactive',
  async run(ctx) {
    const layout = ctx.settings.get().layout
    const home = ctx.tabs.activeId()
    const a = ctx.tabs.create(route(ctx, '/close-x/c', 'Close X three'), { activate: true })
    const b = ctx.tabs.create(route(ctx, '/close-x/d', 'Close X four'), { activate: false })
    try {
      await setLayout(ctx, 'horizontal')
      const tabOf = (id: string): string => `.tabstrip .tab[data-tab-ids="${id}"]`
      await pressX(ctx, tabOf(b.id), `${tabOf(b.id)} .tab__close`, () => !ctx.tabs.find(b.id), 'the inactive strip tab')
      ctx.tabs.activate(a.id)
      await ctx.chrome.until(`return document.querySelector(${JSON.stringify(`${tabOf(a.id)}.tab--active`)}) ? true : null`, 5000, 'the strip tab to turn active')
      await pressX(ctx, tabOf(a.id), `${tabOf(a.id)} .tab__close`, () => !ctx.tabs.find(a.id), 'the active strip tab')
    } finally {
      cleanup(ctx, [a.id, b.id])
      if (home && ctx.tabs.find(home)) ctx.tabs.activate(home)
      await setLayout(ctx, layout === 'horizontal' ? 'horizontal' : 'sidebar')
    }
  },
}

export const checks: SmokeCheck[] = [sidebarTabs, sidebarChats, stripTabs]
export const shots: ShotSpec[] = []
