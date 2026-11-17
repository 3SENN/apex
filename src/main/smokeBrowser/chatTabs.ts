/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { UI } from '@shared/ipc'
import { core } from '../app'
import { PrivateCloseGuard, privateCloseSpec } from '../agent/privateClose'
import { dialogs } from '../dialogs'
import type { WindowContext } from '../features/types'
import { registerScenario } from '../smokeClient'
import { Chrome, assert, sleep, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { Tab } from '../tabs'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// Chats and the tabs that hold them: the strip's unread mark (SH-21), the
// question before a private chat's tab closes (CH-30), and a side-panel chat
// expanded into its tab, beside the tab's own page (CH-03, DS-65). Replies
// come from the offline stand-in and pages from the 127.0.0.1 fixture server.

const chatPage = (id: string): string => `apex://chat/${id}`
const PANEL_SHOWN = `document.querySelector('.panel-frame:not([data-state="closing"]) .chat-panel')`

type Rect = { x: number; y: number; width: number; height: number }

function firstWindow(ctx: SmokeContext): WindowContext {
  const win = core()?.windows.all().find((w) => w.chrome === ctx.chrome.ui)
  assert(win, 'the first window')
  return win
}

function close(ctx: SmokeContext, tabId: string | undefined): void {
  if (tabId && ctx.tabs.find(tabId)) ctx.tabs.close(tabId)
}

async function idle(ctx: SmokeContext, id: string): Promise<void> {
  await waitFor(() => !ctx.host.isRunning(id), 10_000, 'the chat to finish')
}

async function rectOf(doc: Chrome, selector: string): Promise<Rect | null> {
  return doc.js<Rect | null>(
    `const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }`,
  )
}

async function setLayout(ctx: SmokeContext, layout: 'sidebar' | 'horizontal'): Promise<void> {
  if (ctx.settings.get().layout === layout) return
  ctx.settings.update({ layout })
  await ctx.chrome.until(`return document.querySelector('.app--${layout}') ? true : null`, 5000, `the ${layout} layout`)
  await sleep(300)
}

async function setPanel(ctx: SmokeContext, open: boolean): Promise<void> {
  if ((await ctx.chrome.js<boolean>(`return Boolean(${PANEL_SHOWN})`)) === open) return
  ctx.chrome.ui.send(UI.command, 'toggle-agent')
  await ctx.chrome.until(`return ${open ? '' : '!'}${PANEL_SHOWN} ? true : null`, 5000, open ? 'the side panel to open' : 'the side panel to close')
}

const stripUnread: SmokeCheck = {
  name: 'SH-21: the strip marks a background chat with unread results after its title, and looking at the tab clears it',
  async run(ctx) {
    const layout = ctx.settings.get().layout
    const home = ctx.tabs.activeId()
    const id = ctx.host.start('Plan a picnic by the river')
    await idle(ctx, id)
    const tab = ctx.tabs.create(chatPage(id), { activate: false })
    const dot = `.tabstrip .tab[data-tab-ids~="${tab.id}"] .ui-status-dot--unread`
    try {
      await setLayout(ctx, 'horizontal')
      ctx.chats.update([id], { unread: true })
      await ctx.chrome.until(`return document.querySelector(${JSON.stringify(dot)}) ? true : null`, 5000, 'the unread mark on the strip tab')
      const mark = await rectOf(ctx.chrome, dot)
      const icon = await rectOf(ctx.chrome, `.tabstrip .tab[data-tab-ids~="${tab.id}"] .tab__icon`)
      const title = await rectOf(ctx.chrome, `.tabstrip .tab[data-tab-ids~="${tab.id}"] .tab__title`)
      assert(mark && icon && title, 'the mark, favicon and title are drawn')
      assert(mark.width > 0 && mark.x >= icon.x + icon.width, `the mark is clear of the favicon (mark ${JSON.stringify(mark)}, icon ${JSON.stringify(icon)})`)
      assert(mark.x >= title.x, `the mark sits after the title (mark ${JSON.stringify(mark)}, title ${JSON.stringify(title)})`)
      await sleep(200)
      await ctx.shot('tabs-strip-unread')
      ctx.tabs.activate(tab.id)
      await ctx.chrome.until(`return document.querySelector(${JSON.stringify(dot)}) ? null : true`, 5000, 'the mark to clear once the tab is looked at')
    } finally {
      if (home && ctx.tabs.find(home)) ctx.tabs.activate(home)
      close(ctx, tab.id)
      await setLayout(ctx, layout === 'horizontal' ? 'horizontal' : 'sidebar')
    }
  },
}

/** The dialog the guard asks with, in the overlay (or the chrome's fallback). */
async function dialogDoc(ctx: SmokeContext, win: WindowContext): Promise<Chrome> {
  let found: Chrome | null = null
  await waitFor(
    async () => {
      const wc = win.overlay.tierWebContents('interactive')
      for (const doc of [...(wc && !wc.isDestroyed() ? [new Chrome(wc)] : []), ctx.chrome]) {
        if (await doc.js<boolean>(`return Boolean(document.querySelector('.dlg [data-dlg-button="confirm"]'))`).catch(() => false)) {
          found = doc
          return true
        }
      }
      return false
    },
    8000,
    'the private chat question',
  )
  return found as unknown as Chrome
}

async function dialogGone(win: WindowContext): Promise<void> {
  const wc = win.overlay.tierWebContents('interactive')
  if (wc && !wc.isDestroyed()) await new Chrome(wc).until(`return document.querySelector('.dlg') ? null : true`, 5000, 'the question to leave')
}

const privateClose: SmokeCheck = {
  name: 'CH-30: closing a private chat’s tab asks first; Cancel keeps both, the confirm closes and discards; an empty one closes without asking',
  async run(ctx) {
    const win = firstWindow(ctx)
    // The app's guard is off in smoke runs (so other checks close tabs freely); this one installs the same guard with the real dialog.
    const guard = new PrivateCloseGuard({
      privateState: (id) => ctx.host.privateState(id),
      viewing: () => ctx.host.viewing(),
      openTabs: () => (core()?.windows.all() ?? []).flatMap((w) => w.tabs.all().map((t) => ({ id: t.id, internalUrl: t.internalUrl, windowId: w.id }))),
      discard: (id) => ctx.host.discardPrivate(id),
      ask: (w) => dialogs.show(w, privateCloseSpec()).then((result) => result.button === 'confirm'),
    })
    guard.watch(win)
    let tabId: string | undefined
    try {
      const id = ctx.host.start('A private note for the trip', { private: true })
      await idle(ctx, id)
      assert(ctx.host.privateState(id) === 'content', 'the private chat has content')
      tabId = ctx.tabs.create(chatPage(id), { activate: true }).id
      await ctx.chrome.until(`return document.querySelector('.chat-view--page .chat-composer') ? true : null`, 8000, 'the private chat page')
      assert(guard.windowEnding(win) !== null, 'closing the window would ask')
      // Cancel: the tab and the chat stay.
      ctx.tabs.close(tabId)
      let doc = await dialogDoc(ctx, win)
      const title = await doc.js<string>(`return document.querySelector('.dlg__title')?.textContent || ''`)
      assert(title === privateCloseSpec().title, `the question is End private chat’s (${title})`)
      assert(ctx.tabs.find(tabId), 'the tab waits for the answer')
      await doc.js(`document.querySelector('.dlg [data-dlg-button="cancel"]')?.click(); return true`)
      await sleep(200)
      assert(ctx.tabs.find(tabId) && ctx.host.privateState(id) === 'content', 'Cancel keeps the tab and the chat')
      await dialogGone(win)
      // Confirm: the tab closes and the chat is discarded.
      ctx.tabs.close(tabId)
      doc = await dialogDoc(ctx, win)
      await doc.js(`document.querySelector('.dlg [data-dlg-button="confirm"]')?.click(); return true`)
      const closing = tabId
      await waitFor(() => !ctx.tabs.find(closing), 5000, 'the tab to close')
      await waitFor(() => ctx.host.privateState(id) === null, 5000, 'the private chat to be discarded')
      await dialogGone(win)
      // An empty private chat closes at once and is discarded.
      const empty = ctx.host.create({ private: true }).id
      assert(ctx.host.privateState(empty) === 'empty', 'the new private chat is empty')
      tabId = ctx.tabs.create(chatPage(empty), { activate: true }).id
      await ctx.chrome.until(`return document.querySelector('.chat-view--page .chat-composer') ? true : null`, 8000, 'the empty private chat page')
      assert(guard.windowEnding(win) === null, 'an empty private chat asks nothing on window close')
      ctx.tabs.close(tabId)
      assert(!ctx.tabs.find(tabId), 'the empty chat’s tab closes without asking')
      await waitFor(() => ctx.host.privateState(empty) === null, 5000, 'the empty private chat to be discarded')
    } finally {
      win.tabs.setCloseGuard(null)
      close(ctx, tabId)
    }
  },
}

const chatInTab: SmokeCheck = {
  name: 'CH-03: expanding the panel chat turns the website tab into the chat page with its page beside it; ⌘J puts it back',
  async run(ctx) {
    const win = firstWindow(ctx)
    ctx.server.page('/ch03-beside', '<!doctype html><title>Beside the chat</title><body style="font:16px system-ui;padding:40px"><h1>Beside the chat</h1></body>')
    const url = `${ctx.server.http}/ch03-beside`
    const id = ctx.host.start('Plan a picnic on the hill')
    await idle(ctx, id)
    let tab: Tab | undefined
    let blankId: string | undefined
    try {
      tab = ctx.tabs.create(url, { activate: true })
      const site = tab
      await waitForPage(site.view.webContents, 'Beside the chat', 8000, (at) => at.includes('/ch03-beside'))
      const count = ctx.tabs.all().length
      const alone = site.view.getBounds()
      win.send({ type: 'voice-open-chat', chatId: id })
      const expand = `.chat-panel button[aria-label="Open as a page"]:not(:disabled)`
      await ctx.chrome.until(`return ${PANEL_SHOWN} && document.querySelector(${JSON.stringify(expand)}) ? true : null`, 8000, 'the chat in the side panel')
      await ctx.chrome.js(`document.querySelector(${JSON.stringify(expand)})?.click(); return true`)
      await ctx.chrome.until(
        `return document.querySelector('.chat-in-tab[data-state="open"] .chat-in-tab__chat .chat-composer') && document.querySelector('.chat-in-tab__page .pane__view') && !${PANEL_SHOWN} ? true : null`,
        8000,
        'the chat page in the tab with its page beside it',
      )
      assert(ctx.tabs.activeId() === site.id && ctx.tabs.all().length === count, 'the same tab holds the chat; no tab was opened')
      assert(!ctx.tabs.snapshot().split, 'split view is not involved')
      assert(site.view.webContents.getURL() === url, 'the tab keeps its page')
      assert(ctx.host.viewing().some(([surface, chat]) => surface === `page:${site.id}` && chat === id), 'main knows the tab shows the chat')
      await sleep(700)
      const pane = await rectOf(ctx.chrome, '.chat-in-tab__page .pane__view')
      const beside = site.view.getBounds()
      assert(pane && pane.width > 100, 'the page pane has a size')
      assert(Math.abs(beside.x - pane.x) <= 2 && Math.abs(beside.width - pane.width) <= 2, `the page view sits in the pane (view ${JSON.stringify(beside)}, pane ${JSON.stringify(pane)})`)
      assert(beside.x > alone.x + 100 && beside.width < alone.width, `the page moved right of the chat (alone ${JSON.stringify(alone)}, beside ${JSON.stringify(beside)})`)
      await ctx.shot('chat-in-tab')
      // ⌘J (the panel toggle) moves the chat back into the panel and the tab shows its page alone.
      ctx.chrome.ui.send(UI.command, 'toggle-agent')
      await ctx.chrome.until(`return !document.querySelector('.chat-in-tab') && ${PANEL_SHOWN} ? true : null`, 8000, 'the chat back in the side panel')
      await sleep(700)
      const back = site.view.getBounds()
      assert(back.x < beside.x && back.width > beside.width, `the page has the tab again (beside ${JSON.stringify(beside)}, back ${JSON.stringify(back)})`)
      assert(ctx.tabs.all().length === count && ctx.tabs.activeId() === site.id, 'the tab stays')
      await setPanel(ctx, false)
      // On a blank new tab there is no page to keep: the tab becomes the chat page.
      const blank = ctx.tabs.create('about:blank', { activate: true })
      blankId = blank.id
      win.send({ type: 'voice-open-chat', chatId: id })
      await ctx.chrome.until(`return ${PANEL_SHOWN} && document.querySelector(${JSON.stringify(expand)}) ? true : null`, 8000, 'the chat in the side panel over the new tab')
      await ctx.chrome.js(`document.querySelector(${JSON.stringify(expand)})?.click(); return true`)
      await waitFor(() => blank.internalUrl === chatPage(id), 8000, 'the new tab to become the chat page')
      assert(ctx.tabs.activeId() === blank.id, 'the new tab stays in front')
    } finally {
      await setPanel(ctx, false).catch(() => undefined)
      close(ctx, blankId)
      close(ctx, tab?.id)
    }
  },
}

const tabLinks: SmokeCheck = {
  name: 'tab links in a reply go to their tab (or reopen it once closed), and a page link goes to the tab already showing it',
  async run(ctx) {
    const win = firstWindow(ctx)
    ctx.server.page('/tablinks/a', '<!doctype html><title>Tab link A</title><p>A</p>')
    ctx.server.page('/tablinks/b', '<!doctype html><title>Tab link B</title><p>B</p>')
    const urlA = `${ctx.server.http}/tablinks/a`
    const urlB = `${ctx.server.http}/tablinks/b`
    const opened: string[] = []
    try {
      const a = ctx.tabs.create(urlA, { activate: true })
      opened.push(a.id)
      await waitForPage(a.view.webContents, 'tab link page A', 10_000, (at) => at.includes('/tablinks/a'))
      const b = ctx.tabs.create(urlB, { activate: true })
      opened.push(b.id)
      await waitForPage(b.view.webContents, 'tab link page B', 10_000, (at) => at.includes('/tablinks/b'))
      registerScenario(/^smoke-tablinks/, [{ kind: 'text', text: `Your [first page](tab:${a.id}) and the [second page](${urlB}#notes).` }])
      const id = ctx.host.start('smoke-tablinks: where are my pages')
      win.send({ type: 'voice-open-chat', chatId: id })
      const link = `${PANEL_SHOWN}?.querySelector('a.md-tab-link')`
      await ctx.chrome.until(`return ${link} ? true : null`, 15_000, 'the tab link in the scripted reply')
      const count = ctx.tabs.all().length
      // The tab link brings tab A to the front, without a new tab.
      await ctx.chrome.js(`${link}.click(); return true`)
      await waitFor(() => ctx.tabs.activeId() === a.id, 5000, 'the tab link to show its tab')
      assert(ctx.tabs.all().length === count, 'the tab link opened a new tab')
      // The page link goes to tab B, which already shows that page (the #fragment aside).
      const page = `Array.from(${PANEL_SHOWN}?.querySelectorAll('.md a') ?? []).find((el) => el.textContent === 'second page')`
      await ctx.chrome.js(`${page}.click(); return true`)
      await waitFor(() => ctx.tabs.activeId() === b.id, 5000, 'the page link to show the tab with that page')
      assert(ctx.tabs.all().length === count, 'the page link opened a duplicate tab')
      // Once tab A is closed, its link opens its page again.
      ctx.tabs.close(a.id)
      await ctx.chrome.js(`${link}.click(); return true`)
      await waitFor(() => ctx.tabs.all().some((t) => t.id !== b.id && t.requestedUrl === urlA), 5000, 'the closed tab to reopen')
      const again = ctx.tabs.all().find((t) => t.id !== b.id && t.requestedUrl === urlA)
      if (again) opened.push(again.id)
      assert(ctx.tabs.activeId() === again?.id, 'the reopened tab is in front')
    } finally {
      await setPanel(ctx, false).catch(() => undefined)
      for (const id of opened) close(ctx, id)
    }
  },
}

export const checks: SmokeCheck[] = [stripUnread, privateClose, chatInTab, tabLinks]
export const shots: ShotSpec[] = []
