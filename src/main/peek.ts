/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { Bounds } from '@shared/ipc'
import type { PeekState } from '@shared/services'
import { PEEK_RADIUS_PX, peekLayout } from '@shared/peekLayout'
import { canPeek } from '@shared/links'
import type { Tab, TabManager } from './tabs'

/**
 * Peek (SH-43): a link shown in a card over the page. The page is a
 * native view placed above the overlay layer, where the peek-frame surface
 * draws the backdrop and the header; both use peekLayout, so they line up.
 * Only web pages and local files qualify. A page a chat keeps is borrowed
 * (shown here, never closed), and goes back hidden. Peek can't open while a
 * page fills the screen, the peeked page can't go full screen, and a
 * borrowed page that moves to another window closes the peek.
 */
export class PeekManager {
  readonly #window: BrowserWindow
  readonly #session: Session
  readonly #tabs: TabManager
  readonly #emit: (state: PeekState) => void
  #view: WebContentsView | null = null
  /** The chat-kept tab shown instead of a view of our own. */
  #borrowed: Tab | null = null
  /** What had focus before, so it gets it back. */
  #returnFocus: WebContents | null = null
  /** Extra listeners (the peek-frame surface); the constructor's emit stays the chrome's. */
  readonly #listeners = new Set<(state: PeekState) => void>()

  constructor(window: BrowserWindow, session: Session, tabs: TabManager, emit: (state: PeekState) => void) {
    this.#window = window
    this.#session = session
    this.#tabs = tabs
    this.#emit = emit
    window.on('resize', () => this.#place())
    tabs.on('closed', (tab) => {
      if (this.#borrowed === tab) {
        this.#borrowed = null
        this.close()
      }
    })
    // TabManager's own layout passes would hide a borrowed page again.
    tabs.on('changed', () => {
      if (this.#borrowed) this.#place()
    })
  }

  /** Hears every peek state change; returns the unsubscribe. */
  onChange(fn: (state: PeekState) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  isOpen(): boolean {
    return this.#view !== null || this.#borrowed !== null
  }

  open(url: string): void {
    if (!canPeek(url)) throw new Error('Only web pages and files can be peeked.')
    if (this.#tabs.pageFullScreen()) throw new Error('Peek can’t open while a page is full screen.')
    if (this.#borrowed) this.#giveBack()
    this.#remember()
    if (!this.#view) {
      const view = new WebContentsView({
        webPreferences: { session: this.#session, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, safeDialogs: true },
      })
      view.setBorderRadius(PEEK_RADIUS_PX)
      this.#wire(view.webContents)
      this.#view = view
    }
    // Above the tabs and the overlay layer: re-adding moves it to the top.
    this.#window.contentView.addChildView(this.#view)
    this.#place()
    void this.#view.webContents.loadURL(url).catch(() => undefined)
    this.#view.webContents.focus()
    this.#publish()
  }

  /** Shows a tab a chat keeps (its used pages) in the peek card, without moving or closing it. */
  showTab(tabId: string): void {
    if (this.#tabs.pageFullScreen()) throw new Error('Peek can’t open while a page is full screen.')
    const tab = this.#tabs.get(tabId)
    if (this.#tabs.isChromeDrawn(tab)) throw new Error('Only web pages can be peeked.')
    this.#remember()
    this.#closeOwnView()
    if (this.#borrowed && this.#borrowed !== tab) this.#giveBack()
    this.#borrowed = tab
    this.#wire(tab.view.webContents)
    this.#window.contentView.addChildView(tab.view)
    this.#place()
    tab.view.webContents.focus()
    this.#publish()
  }

  /** The window's layout report; Peek places itself now, so this only re-applies. */
  setBounds(_bounds: Bounds | null): void {
    this.#place()
  }

  close(): void {
    if (!this.isOpen()) return
    this.#closeOwnView()
    if (this.#borrowed) this.#giveBack()
    this.#publish()
    const back = this.#returnFocus
    this.#returnFocus = null
    if (back && !back.isDestroyed()) back.focus()
    else this.#tabs.active()?.view.webContents.focus()
  }

  /** Moves the previewed page into a real tab (a borrowed one becomes the active tab). */
  promote(): void {
    const borrowed = this.#borrowed
    if (borrowed) {
      this.close()
      this.#tabs.activate(borrowed.id)
      return
    }
    const url = this.#view?.webContents.getURL()
    this.close()
    if (url) this.#tabs.create(url, { afterId: this.#tabs.activeId() ?? undefined })
  }

  #remember(): void {
    if (this.isOpen()) return
    const active = this.#tabs.active()
    this.#returnFocus = active && !this.#tabs.isChromeDrawn(active) ? active.view.webContents : this.#window.webContents
  }

  #closeOwnView(): void {
    const view = this.#view
    if (!view) return
    this.#view = null
    this.#window.contentView.removeChildView(view)
    view.webContents.close()
  }

  #giveBack(): void {
    const tab = this.#borrowed
    this.#borrowed = null
    if (!tab || tab.view.webContents.isDestroyed()) return
    // Hidden again; the tab manager's next layout pass puts it where it belongs.
    tab.view.setVisible(false)
    this.#tabs.setHidden('peek', false)
  }

  #place(): void {
    const view = this.#view ?? this.#borrowed?.view ?? null
    if (!view || this.#window.isDestroyed()) return
    const zoom = this.#window.webContents.getZoomFactor() || 1
    const { width, height } = this.#window.getContentBounds()
    const { page } = peekLayout({ width: width / zoom, height: height / zoom })
    view.setBounds({ x: Math.round(page.x * zoom), y: Math.round(page.y * zoom), width: Math.round(page.width * zoom), height: Math.round(page.height * zoom) })
    view.setVisible(true)
  }

  #wire(wc: WebContents): void {
    if (wiredContents.has(wc)) return
    wiredContents.add(wc)
    const publish = (): void => {
      if (this.#current() === wc) this.#publish()
    }
    wc.on('page-title-updated', publish)
    wc.on('did-start-loading', publish)
    wc.on('did-stop-loading', publish)
    wc.on('did-navigate', publish)
    wc.on('before-input-event', (event, input) => {
      if (this.#current() === wc && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        this.close()
      }
    })
    // A peeked page stays in its card.
    wc.on('enter-html-full-screen', () => {
      if (this.#current() !== wc) return
      void wc.executeJavaScriptInIsolatedWorld(999, [{ code: 'document.fullscreenElement && document.exitFullscreen()' }]).catch(() => undefined)
    })
  }

  #current(): WebContents | null {
    return this.#view?.webContents ?? this.#borrowed?.view.webContents ?? null
  }

  #publish(): void {
    const wc = this.#current()
    const state: PeekState = wc && !wc.isDestroyed()
      ? { open: true, url: wc.getURL(), title: wc.getTitle() || wc.getURL(), loading: wc.isLoading() }
      : { open: false, url: '', title: '', loading: false }
    this.#emit(state)
    for (const fn of this.#listeners) fn(state)
  }
}

// One set of listeners per webContents, however often it is peeked.
const wiredContents = new WeakSet<WebContents>()
