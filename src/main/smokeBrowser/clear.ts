/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { core } from '../app'
import type { WindowContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { Chrome, assert, sleep, waitFor } from '../smokeKit'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// Clear in the sidebar: the Your tabs header's Clear closes every unpinned
// tab and the toast's Undo brings them back in place, asleep, the active one
// active again; the Chats header's Clear takes the chats out of the sidebar
// and Undo puts them back. Real presses on the chrome's buttons; every page is
// the local fixture server.

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

/** Clicks the Clear in a sidebar section's header (it shows on hover; a click needs no hover). */
async function pressClear(doc: Chrome, section: string): Promise<void> {
  await doc.until(`return document.querySelector(${JSON.stringify(`.sidebar ${section} .side-clear`)}) ? true : null`, 6000, `Clear in ${section}`)
  await doc.js(`document.querySelector(${JSON.stringify(`.sidebar ${section} .side-clear`)}).click()`)
}

/** Presses Undo on the toast, wherever it draws (the overlay's toast, or the chrome's own). */
async function pressUndo(win: WindowContext): Promise<void> {
  const label = mainT('menus.toast.undo')
  await waitFor(
    async () => {
      const docs = [win.overlay.tierWebContents('interactive'), win.overlay.tierWebContents('passive'), win.chrome].filter((wc) => wc && !wc.isDestroyed()).map((wc) => new Chrome(wc!))
      for (const doc of docs) {
        const pressed = await doc
          .js<boolean>(`const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)}); if (b) b.click(); return Boolean(b)`)
          .catch(() => false)
        if (pressed) return true
      }
      return false
    },
    6000,
    'Undo on the toast',
  )
}

/** The unpinned tabs' addresses in order, asleep ones included (what session.json would keep). */
const unpinnedUrls = (win: WindowContext): string[] => win.tabs.serialize().filter((t) => !t.pinned).map((t) => t.url)

const clearTabs: SmokeCheck = {
  name: 'clear: the tab list’s Clear closes every unpinned tab, and Undo brings them back in place',
  async run(ctx) {
    const app = core()
    assert(app, 'the app')
    const layout = ctx.settings.get().layout
    await setLayout(ctx, 'sidebar')
    const id = app.windows.open('normal', { url: route(ctx, '/clear/pinned', 'Clear pinned') })
    try {
      await waitFor(() => Boolean(app.windows.get(id)), 8000, 'the window for Clear')
      const win = app.windows.get(id)!
      await waitFor(() => !win.chrome.isLoading(), 10_000, 'its chrome to load')
      const pinned = win.tabs.all()[0]
      assert(pinned, 'the window’s first tab')
      win.tabs.setPinned(pinned.id, true)
      const urls = ['a', 'b', 'c'].map((x) => route(ctx, `/clear/${x}`, `Clear ${x}`))
      const made = urls.map((url) => win.tabs.create(url, { activate: false }))
      win.tabs.activate(made[1]!.id)
      await waitFor(() => unpinnedUrls(win).every((u) => urls.includes(u)) && unpinnedUrls(win).length === 3, 8000, 'the three tabs to load')
      const before = unpinnedUrls(win)
      const doc = new Chrome(win.chrome)
      await pressClear(doc, '.tabs-section')
      await waitFor(() => win.tabs.all().every((t) => t.pinned), 6000, 'every unpinned tab to close')
      assert(win.tabs.find(pinned.id), 'the pinned tab stays')
      await pressUndo(win)
      await waitFor(() => unpinnedUrls(win).length === 3, 6000, 'the three tabs to come back')
      const back = unpinnedUrls(win)
      assert(JSON.stringify(back) === JSON.stringify(before), `the tabs came back out of order: ${JSON.stringify(back)} for ${JSON.stringify(before)}`)
      const active = win.tabs.active()
      assert(active && !active.pinned && win.tabs.serialize()[win.tabs.all().indexOf(active)]?.url === urls[1], 'the tab that was active is active again')
      // ⇧⌘T doesn't bring back a tab that is open again.
      assert(!win.tabs.reopenClosed(), '⇧⌘T reopened a tab Undo had already brought back')
    } finally {
      // Pinned tabs are kept for the profile: unpin so later checks don't meet this one.
      const left = app.windows.get(id)
      for (const tab of left?.tabs.all() ?? []) if (tab.pinned) left?.tabs.setPinned(tab.id, false)
      app.windows.closeNow(id)
      await setLayout(ctx, layout === 'horizontal' ? 'horizontal' : 'sidebar')
    }
  },
}

const clearChats: SmokeCheck = {
  name: 'clear: the Chats header’s Clear takes the chats out of the sidebar, and Undo puts them back',
  async run(ctx) {
    const layout = ctx.settings.get().layout
    const one = ctx.host.start('Clear chat one')
    const two = ctx.host.start('Clear chat two')
    await waitFor(() => !ctx.host.isRunning(one) && !ctx.host.isRunning(two), 10_000, 'the chats to finish')
    const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
    assert(win, 'the first window')
    try {
      await setLayout(ctx, 'sidebar')
      const rowOf = (id: string): string => `.sidebar .chats-section .chat-row[data-drop-id="${id}"]`
      const rows = (on: boolean): string => `return ${[one, two].map((id) => `${on ? '' : '!'}document.querySelector(${JSON.stringify(rowOf(id))})`).join(' && ')} ? true : null`
      await ctx.chrome.until(rows(true), 6000, 'both chats in the Chats section')
      await pressClear(ctx.chrome, '.chats-section')
      await ctx.chrome.until(rows(false), 6000, 'the chats to leave the sidebar')
      assert(ctx.chats.summary(one) && ctx.chats.summary(two), 'Clear deleted a chat')
      await pressUndo(win)
      await ctx.chrome.until(rows(true), 6000, 'the chats back in the sidebar')
    } finally {
      ctx.chats.remove([one, two])
      await setLayout(ctx, layout === 'horizontal' ? 'horizontal' : 'sidebar')
    }
  },
}

/** The headers with Clear showing (focus shows it as hover does). */
const clearShot: ShotSpec = {
  name: 'sidebar-clear',
  async run(ctx) {
    await setLayout(ctx, 'sidebar')
    const chat = ctx.host.start('Clear shot chat')
    await waitFor(() => !ctx.host.isRunning(chat), 10_000, 'the chat to finish')
    const tab = ctx.tabs.create(route(ctx, '/clear/shot', 'Clear shot'), { activate: false })
    try {
      for (const section of ['.tabs-section', '.chats-section']) {
        await ctx.chrome.until(`return document.querySelector(${JSON.stringify(`.sidebar ${section} .side-clear`)}) ? true : null`, 6000, `Clear in ${section}`)
        await ctx.chrome.js(`document.querySelector(${JSON.stringify(`.sidebar ${section} .side-clear`)}).focus()`)
        await sleep(250)
        await ctx.shot(`sidebar-clear${section.replace('.', '-').replace('-section', '')}`)
      }
    } finally {
      if (ctx.tabs.find(tab.id)) ctx.tabs.close(tab.id)
      ctx.chats.remove([chat])
    }
  },
}

export const checks: SmokeCheck[] = [clearTabs, clearChats]
export const shots: ShotSpec[] = [clearShot]
