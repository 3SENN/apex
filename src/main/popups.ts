/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BaseWindow, BrowserWindow, WebContentsView, ipcMain, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import type { PopupStripState } from '@shared/api'
import { UI } from '@shared/ipc'
import { CHROME_BACKGROUND, type ThemeMode } from '@shared/theme'
import { log } from './log'
import { uiOriginOf } from '@shared/url'

// Scripted popups (SH-62): sign-in and payment windows keep
// window.opener, so they stay real windows. Each gets a read-only origin
// strip at the top (#popup-strip: host, a secure or not-secure marker and a
// loading state, updated as it navigates) above the page itself. When the
// popup closes, focus returns to the tab that opened it.

/** The strip's height in window px. */
export const POPUP_STRIP_PX = 32
const DEFAULT_SIZE = { width: 520, height: 700 }

export interface PopupDeps {
  uiUrl: string
  /** The ui preload, for the strip. */
  preload: string
  mode(): ThemeMode
  /** Focus goes back to the opener's tab when the popup closes. */
  returnFocus(opener: WebContents): void
}

interface OpenPopup {
  window: BaseWindow | BrowserWindow
  page: WebContents
  strip: WebContents | null
  opener: WebContents
}

const open = new Set<OpenPopup>()
const strips = new Map<number, OpenPopup>()

/** The strip's state for a page right now. */
export function stripState(page: WebContents): PopupStripState {
  const url = page.isDestroyed() ? '' : page.getURL()
  let host = ''
  let secure = false
  try {
    const parsed = new URL(url)
    host = parsed.host || parsed.protocol.replace(':', '')
    secure = parsed.protocol === 'https:'
  } catch {
    host = url ? url.slice(0, 80) : ''
  }
  return { host, secure, loading: !page.isDestroyed() && page.isLoading(), title: page.isDestroyed() ? '' : page.getTitle() }
}

let ipcReady = false
function registerStripIpc(): void {
  if (ipcReady) return
  ipcReady = true
  // The strip asks for its state once it listens; only strips get an answer.
  ipcMain.on(UI.popupStrip, (event) => {
    const popup = strips.get(event.sender.id)
    if (popup && event.senderFrame === event.sender.mainFrame) event.sender.send(UI.popupStrip, stripState(popup.page))
  })
}

/** Popups open right now (⌘W closes a focused one first, SH-26). */
export const popups = {
  all(): { window: BaseWindow | BrowserWindow; page: WebContents }[] {
    return [...open].map((p) => ({ window: p.window, page: p.page }))
  },
  /** The popup window in front, if one is. */
  focused(): { window: BaseWindow | BrowserWindow; page: WebContents } | null {
    for (const p of open) if (!p.window.isDestroyed() && p.window.isFocused()) return { window: p.window, page: p.page }
    return null
  },
  /** Every popup's origin strip, so theme changes reach them (OV-04). */
  strips(): WebContents[] {
    return [...open].map((p) => p.strip).filter((w): w is WebContents => w !== null && !w.isDestroyed())
  },
  /** The popup whose strip this is, if any. */
  stripOwner(id: number): { window: BaseWindow | BrowserWindow; page: WebContents; opener: WebContents } | null {
    const p = strips.get(id)
    return p ? { window: p.window, page: p.page, opener: p.opener } : null
  },
  /** The window around a popup's page, which isn't a BrowserWindow (its window frame for windowGeometry.ts). */
  windowOf(pageId: number): BaseWindow | BrowserWindow | null {
    for (const p of open) if (!p.page.isDestroyed() && p.page.id === pageId) return p.window.isDestroyed() ? null : p.window
    return null
  },
  /** The page that opened a popup's page, so its permission requests go to the opener's tab. */
  openerOf(pageId: number): WebContents | null {
    for (const p of open) if (!p.page.isDestroyed() && p.page.id === pageId) return p.opener.isDestroyed() ? null : p.opener
    return null
  },
  /** Whether a webContents belongs to a popup (its page or strip). */
  owns(id: number): boolean {
    for (const p of open) if ((!p.page.isDestroyed() && p.page.id === id) || (p.strip && !p.strip.isDestroyed() && p.strip.id === id)) return true
    return false
  },
}

/**
 * setWindowOpenHandler's createWindow: a window holding the strip and the
 * page, adopting the guest webContents Electron hands over. Without a guest
 * (an older Electron) it falls back to a plain popup window, strip-less.
 */
export function createPopupWindow(options: BrowserWindowConstructorOptions & { webContents?: WebContents }, opener: WebContents, deps: PopupDeps): WebContents {
  registerStripIpc()
  const width = options.width ?? DEFAULT_SIZE.width
  const height = (options.height ?? DEFAULT_SIZE.height) + POPUP_STRIP_PX
  const guest = options.webContents
  if (!guest) {
    const plain = new BrowserWindow({ ...options, width, height: height - POPUP_STRIP_PX, backgroundColor: CHROME_BACKGROUND[deps.mode()], autoHideMenuBar: true })
    track({ window: plain, page: plain.webContents, strip: null, opener }, deps)
    return plain.webContents
  }
  const window = new BaseWindow({
    width,
    height,
    ...(options.x !== undefined && options.y !== undefined ? { x: options.x, y: options.y } : {}),
    minWidth: 320,
    minHeight: 240 + POPUP_STRIP_PX,
    title: options.title ?? '',
    backgroundColor: CHROME_BACKGROUND[deps.mode()],
    autoHideMenuBar: true,
    show: options.show ?? true,
  })
  const page = new WebContentsView({ webContents: guest, webPreferences: options.webPreferences })
  const strip = new WebContentsView({ webPreferences: { preload: deps.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false } })
  strip.setBackgroundColor(CHROME_BACKGROUND[deps.mode()])
  window.contentView.addChildView(page)
  window.contentView.addChildView(strip)
  const layout = (): void => {
    if (window.isDestroyed()) return
    const { width: w, height: h } = window.getContentBounds()
    strip.setBounds({ x: 0, y: 0, width: w, height: POPUP_STRIP_PX })
    page.setBounds({ x: 0, y: POPUP_STRIP_PX, width: w, height: Math.max(0, h - POPUP_STRIP_PX) })
  }
  layout()
  window.on('resize', layout)
  // The strip only ever shows Atelier's UI.
  const uiOrigin = uiOriginOf(deps.uiUrl)
  strip.webContents.on('will-navigate', (event) => {
    if (uiOrigin === null || uiOriginOf(event.url) !== uiOrigin) event.preventDefault()
  })
  strip.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void strip.webContents.loadURL(`${deps.uiUrl.split('#')[0]}#popup-strip`).catch(() => undefined)
  track({ window, page: guest, strip: strip.webContents, opener }, deps)
  page.webContents.on('page-title-updated', (_e, title) => {
    if (!window.isDestroyed()) window.setTitle(title)
  })
  return guest
}

function track(popup: OpenPopup, deps: PopupDeps): void {
  open.add(popup)
  if (popup.strip) strips.set(popup.strip.id, popup)
  const { window, page, strip, opener } = popup
  const push = (): void => {
    if (strip && !strip.isDestroyed()) strip.send(UI.popupStrip, stripState(page))
  }
  for (const event of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) page.on(event as 'did-start-loading', push)
  // window.close() in the page destroys its webContents; the window goes with it.
  page.once('destroyed', () => {
    if (!window.isDestroyed()) window.close()
  })
  window.once('closed', () => {
    open.delete(popup)
    if (strip) strips.delete(strip.id)
    // A closed window doesn't destroy the pages of its views.
    if (!page.isDestroyed()) page.close()
    if (strip && !strip.isDestroyed()) strip.close()
    if (!opener.isDestroyed()) {
      try {
        deps.returnFocus(opener)
      } catch (err) {
        log.warn('popups', 'Could not return focus to the opener', { error: err instanceof Error ? err.message : String(err) })
      }
    }
  })
}
