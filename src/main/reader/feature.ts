/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { READER_CHANNEL, readerAllowedUrl, sameDocument, type ReaderArticle, type ReaderServices } from '@shared/reader'
import type { CommandId } from '@shared/shortcuts'
import { toasts } from '../dialogs'
import type { AppContext, Feature, WindowContext } from '../features/types'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import type { Tab } from '../tabs'
import { READER_TEXT_SIZE, nextTextSize } from '@shared/readerPrefs'
import { pageResultSchema, pageStateSchema } from './schemas'
import { ReaderTabs } from './state'

// Reader, main side (RD-01 to RD-04). The page preload reports whether its
// page reads as an article; TabInfo.reader carries that to the address pill.
// Opening asks the page for its article, checks it again (schemas.ts) and
// keeps it per tab; a view cover hides the page while the chrome draws the
// reader in its pane. A new document closes the reader. ⌥⌘R and View › Reader
// run the 'toggle-reader' command; ⌘+, ⌘- and ⌘0 size the reader's text.

const EXTRACT_TIMEOUT_MS = 10_000

interface Pending {
  webContentsId: number
  resolve(article: ReaderArticle): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface Located {
  tab: Tab
  win: WindowContext
}

/** The reader's error when a page has no article (or answered with something unusable). */
const noArticle = (): Error => new Error(mainT('reader.error.noArticle'))

export function createReaderFeature(): Feature {
  const state = new ReaderTabs()
  const pending = new Map<number, Pending>()
  const opening = new Map<string, Promise<boolean>>()
  let nextId = 1
  let ctx: AppContext | null = null
  const stops: (() => void)[] = []

  const sendTo = (wc: WebContents, channel: string, payload?: unknown): void => {
    if (!wc.isDestroyed()) wc.send(channel, payload)
  }

  const extract = (wc: WebContents): Promise<ReaderArticle> => {
    const requestId = nextId++
    return new Promise<ReaderArticle>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(mainT('reader.error.timeout')))
      }, EXTRACT_TIMEOUT_MS)
      pending.set(requestId, { webContentsId: wc.id, resolve, reject, timer })
      sendTo(wc, READER_CHANNEL.extract, { requestId })
    })
  }

  const failPending = (webContentsId: number, reason: Error): void => {
    for (const [id, p] of pending) {
      if (p.webContentsId !== webContentsId) continue
      clearTimeout(p.timer)
      pending.delete(id)
      p.reject(reason)
    }
  }

  /** Main-frame messages from a tab's own page only. */
  const locate = (event: IpcMainEvent): Located | null => {
    if (event.senderFrame !== event.sender.mainFrame || !ctx) return null
    const win = ctx.windows.fromWebContents(event.sender.id)
    const tab = win?.tabs.byWebContents(event.sender)
    return win && tab ? { tab, win } : null
  }

  const onState = (event: IpcMainEvent, raw: unknown): void => {
    const at = locate(event)
    const parsed = pageStateSchema.safeParse(raw)
    if (!at || !parsed.success) return
    const wc = at.tab.view.webContents
    // A report about a page the tab has already left is stale.
    if (wc.isDestroyed() || !sameDocument(parsed.data.url, wc.getURL()) || !readerAllowedUrl(parsed.data.url)) return
    if (state.report(at.tab.id, wc.getURL(), parsed.data.readerable)) at.win.tabs.refresh()
  }

  const onResult = (event: IpcMainEvent, raw: unknown): void => {
    const requestId = raw && typeof raw === 'object' ? (raw as { requestId?: unknown }).requestId : undefined
    const p = typeof requestId === 'number' ? pending.get(requestId) : undefined
    // Only the main frame of the tab that was asked may answer.
    if (!p || event.sender.id !== p.webContentsId || event.senderFrame !== event.sender.mainFrame) return
    clearTimeout(p.timer)
    pending.delete(requestId as number)
    const parsed = pageResultSchema.safeParse(raw)
    if (!parsed.success) {
      log.warn('reader', `A page sent an article ${BRAND_NAME} could not use`, { issue: parsed.error.issues[0]?.message ?? 'unknown' })
      p.reject(noArticle())
    } else if (!parsed.data.ok) p.reject(noArticle())
    else p.resolve(parsed.data.article)
  }

  const webTab = (win: WindowContext, tabId: string): Tab => {
    const tab = win.tabs.find(tabId)
    if (!tab || tab.internalUrl || tab.sandbox || tab.view.webContents.isDestroyed() || !readerAllowedUrl(tab.view.webContents.getURL())) {
      throw new Error(mainT('reader.error.notHere'))
    }
    return tab
  }

  const open = (win: WindowContext, tabId: string): Promise<boolean> => {
    if (state.isOpen(tabId)) return Promise.resolve(true)
    const running = opening.get(tabId)
    if (running) return running
    const run = (async (): Promise<boolean> => {
      const tab = webTab(win, tabId)
      const wc = tab.view.webContents
      const url = wc.getURL()
      const article = await extract(wc)
      // The tab moved on while the page worked: nothing to show.
      if (wc.isDestroyed() || !sameDocument(wc.getURL(), url)) throw new Error(mainT('reader.error.moved'))
      state.opened(tabId, { ...article, url })
      win.tabs.recover()
      // Keys go to the reader (Space, arrows) rather than the hidden page.
      if (win.tabs.active()?.id === tabId && !win.chrome.isDestroyed()) win.chrome.focus()
      return true
    })().finally(() => opening.delete(tabId))
    opening.set(tabId, run)
    return run
  }

  const close = (win: WindowContext, tabId: string): void => {
    if (!state.closed(tabId)) return
    win.tabs.recover()
    const tab = win.tabs.find(tabId)
    if (tab && win.tabs.active()?.id === tabId && !tab.view.webContents.isDestroyed()) tab.view.webContents.focus()
  }

  const toggle = (win: WindowContext, tabId: string): Promise<boolean> => {
    if (state.isOpen(tabId)) {
      close(win, tabId)
      return Promise.resolve(false)
    }
    return open(win, tabId)
  }

  const activeTab = (win: WindowContext | null): Tab | null => win?.tabs.active() ?? null
  const activeOpen = (win: WindowContext | null): boolean => {
    const tab = activeTab(win)
    return tab !== null && state.isOpen(tab.id)
  }

  /** ⌘+, ⌘- and ⌘0 size the reader's text while it shows (the hidden page keeps its zoom). */
  const sizeText = (step: -1 | 0 | 1): void => {
    if (!ctx) return
    const current = ctx.settings.get().readerTextSize
    const next = step === 0 ? READER_TEXT_SIZE.default : nextTextSize(current, step)
    if (next !== current) ctx.settings.update({ readerTextSize: next })
  }

  return {
    name: 'reader',
    app(app) {
      ctx = app
      ipcMain.on(READER_CHANNEL.state, onState)
      ipcMain.on(READER_CHANNEL.result, onResult)
      stops.push(() => ipcMain.off(READER_CHANNEL.state, onState), () => ipcMain.off(READER_CHANNEL.result, onResult))
      stops.push(
        app.commands.register(
          'toggle-reader',
          async (win) => {
            const tab = activeTab(win)
            if (!win || !tab) return false
            try {
              await toggle(win, tab.id)
              return true
            } catch (err) {
              void toasts.show(win, { kind: 'error', text: err instanceof Error ? err.message : String(err), tabId: tab.id })
              return false
            }
          },
          {
            enabled: (win) => {
              const tab = activeTab(win)
              return tab !== null && state.tabState(tab.id) !== undefined
            },
            checked: (win) => activeOpen(win),
          },
        ),
      )
      const zoom: [CommandId, -1 | 0 | 1][] = [
        ['zoom-in', 1],
        ['zoom-in-equal', 1],
        ['zoom-out', -1],
        ['zoom-reset', 0],
      ]
      for (const [id, step] of zoom) stops.push(app.commands.intercept(id, { when: activeOpen, run: () => sizeText(step) }))
    },
    window(win) {
      win.tabs.decorate((tab) => {
        const reader = state.tabState(tab.id)
        return reader ? { reader } : {}
      })
      win.tabs.cover((tab) => tab.internalUrl === null && state.isOpen(tab.id))
      const services: ReaderServices['reader'] = {
        toggle: (tabId) => toggle(win, tabId),
        open: (tabId) => open(win, tabId),
        close: (tabId) => close(win, tabId),
        article: (tabId) => state.article(tabId),
      }
      win.tabs.on('navigated', (tab, nav) => {
        if (!nav.mainFrame || tab.view.webContents.isDestroyed()) return
        const wc = tab.view.webContents
        // The address changed inside the page (a single-page app): it looks again, and an open reader stays.
        if (nav.inPage) return sendTo(wc, READER_CHANNEL.check)
        failPending(wc.id, new Error(mainT('reader.error.moved')))
        if (state.navigated(tab.id, nav.url, false)) win.tabs.recover()
      })
      win.tabs.on('view-replaced', (_tab, old) => failPending(old.id, new Error(mainT('reader.error.moved'))))
      win.tabs.on('closed', (tab) => {
        if (!tab.view.webContents.isDestroyed()) failPending(tab.view.webContents.id, new Error(mainT('reader.error.moved')))
        state.forget(tab.id)
      })
      return { reader: services }
    },
    dispose() {
      for (const stop of stops.splice(0)) stop()
    },
  }
}
