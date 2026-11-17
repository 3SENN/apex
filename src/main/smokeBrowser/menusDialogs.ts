/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { confirmSpec } from '@shared/dialogLogic'
import { viewSourceUrl } from '@shared/viewSource'
import { dialogs, toasts } from '../dialogs'
import { dialogsSmoke } from '../dialogsFeature'
import type { WindowContext } from '../features/types'
import { Chrome, assert, sleep, waitFor } from '../smokeKit'
import { waitForPage } from '../smokeLoad'
import type { ShotSpec, SmokeCheck, SmokeContext } from './types'

// The dialogs' smoke checks and light and dark shots: a confirm drawn by the
// overlay (or the chrome's fallback) with duplicates dropped, a page's own
// confirm() answered through Apex's dialog, a toast, the task manager, the
// QR card and view source. Pages come from the 127.0.0.1 fixture server only.

function windowOf(): WindowContext {
  const win = dialogsSmoke.window()
  assert(win, 'a focused window')
  return win
}

/** The document that drew `selector`: the interactive overlay tier, else the chrome (its fallback). */
async function drawnIn(ctx: SmokeContext, selector: string, what: string): Promise<Chrome> {
  let found: Chrome = ctx.chrome
  await waitFor(
    async () => {
      const wc = dialogsSmoke.window()?.overlay.tierWebContents('interactive')
      const docs = [...(wc && !wc.isDestroyed() ? [new Chrome(wc)] : []), ctx.chrome]
      for (const doc of docs) {
        if (await doc.js<boolean>(`return Boolean(document.querySelector(${JSON.stringify(selector)}))`).catch(() => false)) {
          found = doc
          return true
        }
      }
      return false
    },
    8000,
    what,
  )
  return found
}

async function press(doc: Chrome, selector: string): Promise<void> {
  const ok = await doc.js<boolean>(`const b = document.querySelector(${JSON.stringify(selector)}); if (b) b.click(); return Boolean(b)`)
  assert(ok, `pressed ${selector}`)
}

function page(ctx: SmokeContext, path: string, html: string): string {
  ctx.server.route(path, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
  })
  return `${ctx.server.http}${path}`
}

const spec = confirmSpec({ title: 'Delete the smoke note?', message: 'This is only a test.', confirmLabel: 'Delete', cancelLabel: 'Cancel', destructive: true, dedupeKey: 'menus-dialogs-smoke' })

const queuedConfirm: SmokeCheck = {
  name: 'dialogs: a confirm shows once for duplicates and answers both',
  async run(ctx) {
    const win = windowOf()
    const a = dialogs.confirm(win, spec)
    const b = dialogs.confirm(win, spec)
    const doc = await drawnIn(ctx, '.dlg [data-dlg-button="confirm"]', 'the confirm dialog')
    const count = await doc.js<number>(`return document.querySelectorAll('.dlg').length`)
    assert(count === 1, `one dialog for two asks (${count})`)
    await press(doc, '.dlg [data-dlg-button="confirm"]')
    assert((await a) && (await b), 'both callers hear Delete')
  },
}

const pageConfirm: SmokeCheck = {
  name: 'dialogs: a page’s confirm() is asked with Apex’s dialog',
  async run(ctx) {
    const url = page(ctx, '/menus-dialogs/confirm.html', '<!doctype html><title>Confirm</title><p>Confirm fixture</p>')
    const tab = ctx.tabs.create(url, { activate: true })
    try {
      await waitForPage(tab.view.webContents, 'the fixture page')
      // The previous check's dialog plays its exit first; wait until it is gone.
      const wc = dialogsSmoke.window()?.overlay.tierWebContents('interactive')
      if (wc && !wc.isDestroyed()) await new Chrome(wc).until(`return !document.querySelector('.dlg')`, 5000, 'the previous dialog to leave')
      const answer = tab.view.webContents.executeJavaScript('confirm("Keep going?")', true) as Promise<boolean>
      const doc = await drawnIn(ctx, '.dlg [data-dlg-button="ok"]', 'the page dialog')
      const title = await doc.js<string>(`return document.querySelector('.dlg__title')?.textContent || ''`)
      assert(title.includes('127.0.0.1'), `the title names the site (${title})`)
      await press(doc, '.dlg [data-dlg-button="ok"]')
      assert((await answer) === true, 'the page hears OK')
    } finally {
      ctx.tabs.close(tab.id)
    }
  },
}

const toastShows: SmokeCheck = {
  name: 'toasts: a toast shows at the top of the tab and reports how it ended',
  async run(ctx) {
    const win = windowOf()
    const outcome = toasts.show(win, { kind: 'info', text: 'Smoke toast', action: { id: 'open', label: 'Open' }, durationMs: 0 })
    const doc = await drawnIn(ctx, '.tst, .ui-toast', 'the toast')
    await press(doc, '.tst__close, .ui-toast__close')
    const how = await outcome
    assert(how === 'closed', `closed by its button (${how})`)
  },
}

const taskManager: SmokeCheck = {
  name: 'task manager: ⇧Esc’s sheet lists the browser and the tabs',
  async run(ctx) {
    const win = windowOf()
    dialogsSmoke.taskManager(win)
    const doc = await drawnIn(ctx, '.tm__row', 'the task manager rows')
    const rows = await doc.js<number>(`return document.querySelectorAll('.tm__row').length`)
    assert(rows >= 2, `rows for the browser and more (${rows})`)
    await press(doc, '.tm__close')
  },
}

const viewSource: SmokeCheck = {
  name: 'view source: apex://view-source shows numbered lines',
  async run(ctx) {
    const url = page(ctx, '/menus-dialogs/source.html', '<!doctype html><html><head><title>S</title></head><body><div><p>Source fixture</p></div></body></html>')
    ctx.tabs.openInternal(viewSourceUrl(url), { newTab: true })
    const opened = ctx.tabs.active()?.id
    await ctx.chrome.until(`return document.querySelectorAll('.vs__line').length > 0 && document.body.innerText.includes('Source fixture')`, 8000, 'the source lines')
    // Later passes (the layout audit) open their own source tab; this one would show as a second "Page source" row.
    if (opened) ctx.tabs.close(opened)
  },
}

export const dialogChecks: SmokeCheck[] = [queuedConfirm, pageConfirm, toastShows, taskManager, viewSource]

/** Opens something, waits for it, shoots it, then closes it with `close`. */
function shotOf(name: string, open: (ctx: SmokeContext, win: WindowContext) => unknown, selector: string, close: string | null): ShotSpec {
  return {
    name,
    async run(ctx) {
      const win = windowOf()
      void open(ctx, win)
      const doc = await drawnIn(ctx, selector, name)
      await sleep(250)
      await ctx.shot(name)
      if (close) await press(doc, close).catch(() => undefined)
    },
  }
}

export const dialogShots: ShotSpec[] = [
  shotOf('dialogs-confirm', (_c, win) => dialogs.show(win, { ...spec, dedupeKey: 'menus-dialogs-shot' }), '.dlg', '.dlg [data-dlg-button="cancel"]'),
  shotOf(
    'dialogs-sign-in',
    (_c, win) =>
      dialogs.show(win, {
        title: 'Sign in to 127.0.0.1',
        description: 'This site asks for a username and password.',
        icon: 'lock',
        inputs: [
          { id: 'username', label: 'Username', type: 'text' },
          { id: 'password', label: 'Password', type: 'password' },
        ],
        buttons: [
          { id: 'cancel', label: 'Cancel', style: 'secondary', escape: true },
          { id: 'ok', label: 'Sign In', style: 'primary', enter: true },
        ],
      }),
    '.dlg input',
    '.dlg [data-dlg-button="cancel"]',
  ),
  shotOf('dialogs-toast', (_c, win) => toasts.show(win, { kind: 'success', text: 'Link copied', detail: 'https://example.com/a/long/path', durationMs: 4000 }), '.tst, .ui-toast', null),
  shotOf('dialogs-toast-undo', (_c, win) => toasts.show(win, { kind: 'success', text: 'Chat deleted', undo: () => undefined, durationMs: 0 }), '.tst, .ui-toast', '.tst__close, .ui-toast__close'),
  shotOf('dialogs-toast-error', (_c, win) => toasts.show(win, { kind: 'error', text: 'The file couldn’t be saved.', durationMs: 0 }), '.tst, .ui-toast', '.tst__close, .ui-toast__close'),
  shotOf('dialogs-task-manager', (_c, win) => dialogsSmoke.taskManager(win), '.tm__row', '.tm__close'),
  {
    name: 'dialogs-qr-code',
    async run(ctx) {
      const win = windowOf()
      const tab = ctx.tabs.create(page(ctx, '/menus-dialogs/qr.html', '<!doctype html><title>QR fixture</title><p>QR</p>'), { activate: true })
      try {
        await waitForPage(tab.view.webContents, 'the QR fixture')
        dialogsSmoke.qrCode(win, tab.id)
        await drawnIn(ctx, '.qr img, .qr svg', 'the QR card')
        await sleep(250)
        await ctx.shot('dialogs-qr-code')
      } finally {
        ctx.tabs.close(tab.id)
      }
    },
  },
  {
    name: 'dialogs-view-source',
    async run(ctx) {
      const url = page(ctx, '/menus-dialogs/shot.html', '<!doctype html><html><head><title>Shot</title><!-- a comment --></head><body class="x"><main><h1>Hello</h1><p data-k="v">Apex</p></main></body></html>')
      ctx.tabs.openInternal(viewSourceUrl(url), { newTab: true })
      const opened = ctx.tabs.active()?.id
      await ctx.chrome.until(`return document.querySelectorAll('.vs__line').length > 0`, 8000, 'view source')
      await ctx.shot('dialogs-view-source')
      if (opened) ctx.tabs.close(opened)
    },
  },
]
