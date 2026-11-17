/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { WebContentsView, type BrowserWindow, type Input, type Session, type WebContents } from 'electron'
import { anchorBelow, clampPopupSize, type ExtensionInfo } from '@shared/extensions'
import type { Bounds } from '@shared/ipc'
import { log } from '../log'

// An extension's popup (SH-32, SH-65): its page in a view of the profile's
// session, anchored under the toolbar button, sized to what the page asks
// for within Chrome's limits, and closed on blur, Esc, window.close() or a
// window resize. One popup at a time per window, as in Chrome.

export interface PopupOpenOptions {
  window: BrowserWindow
  /** The chrome's webContents: anchors arrive in its CSS px. */
  chrome: WebContents
  session: Session
  extension: Pick<ExtensionInfo, 'id' | 'name'>
  url: string
  anchor: Bounds
  /** Links the popup opens go to a tab, never a new window. */
  openTab(url: string): void
  onClosed(): void
}

interface Open {
  view: WebContentsView
  extensionId: string
  window: BrowserWindow
  cleanup: () => void
  onClosed: () => void
}

const START = { width: 25, height: 25 }
/** Native pickers (a <select>, a file chooser) blur the page briefly; wait before treating a blur as a click elsewhere. */
const BLUR_GRACE_MS = 120

export class PopupHost {
  #open: Open | null = null

  /** The extension whose popup is open in this window, if any. */
  get extensionId(): string | null {
    return this.#open?.extensionId ?? null
  }

  /** The popup's webContents id, for routing window.close() from its page. */
  webContentsId(): number | null {
    const wc = this.#open?.view.webContents
    return wc && !wc.isDestroyed() ? wc.id : null
  }

  open(opts: PopupOpenOptions): void {
    const again = this.#open?.extensionId === opts.extension.id
    this.close()
    // A second click on the same button closes its popup, like a toggle.
    if (again) return
    const zoom = opts.chrome.isDestroyed() ? 1 : opts.chrome.getZoomFactor() || 1
    const anchor: Bounds = { x: opts.anchor.x * zoom, y: opts.anchor.y * zoom, width: opts.anchor.width * zoom, height: opts.anchor.height * zoom }
    const view = new WebContentsView({
      webPreferences: { session: opts.session, sandbox: true, contextIsolation: true, nodeIntegration: false, enablePreferredSizeMode: true, spellcheck: false },
    })
    view.setBorderRadius(10)
    const place = (size: { width: number; height: number }): void => {
      if (opts.window.isDestroyed()) return
      const [width, height] = opts.window.getContentSize()
      view.setBounds(anchorBelow(anchor, clampPopupSize(size), { width: width ?? 0, height: height ?? 0 }))
    }
    place(START)
    view.setVisible(false)
    opts.window.contentView.addChildView(view)

    const wc = view.webContents
    const onSize = (_e: unknown, size: { width: number; height: number }): void => {
      place(size)
      view.setVisible(true)
    }
    wc.on('preferred-size-changed', onSize)
    wc.on('did-finish-load', () => {
      view.setVisible(true)
      wc.focus()
    })
    wc.on('blur', () => {
      setTimeout(() => {
        if (this.#open?.view === view && !wc.isDestroyed() && !wc.isFocused() && !wc.isDevToolsOpened()) this.close()
      }, BLUR_GRACE_MS)
    })
    wc.on('before-input-event', (event, input: Input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && !input.meta && !input.control && !input.alt) {
        event.preventDefault()
        this.close()
      }
    })
    // Links leave the popup for a tab; the popup itself never navigates off its extension.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:|^chrome-extension:/i.test(url)) opts.openTab(url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (event, url) => {
      if (url.startsWith(`chrome-extension://${opts.extension.id}/`)) return
      event.preventDefault()
      if (/^https?:/i.test(url)) opts.openTab(url)
      this.close()
    })
    wc.on('render-process-gone', () => this.close())

    const onResize = (): void => this.close()
    opts.window.on('resize', onResize)
    opts.window.on('blur', onResize)
    const cleanup = (): void => {
      if (!opts.window.isDestroyed()) {
        opts.window.off('resize', onResize)
        opts.window.off('blur', onResize)
      }
    }
    this.#open = { view, extensionId: opts.extension.id, window: opts.window, cleanup, onClosed: opts.onClosed }
    wc.loadURL(opts.url).catch((err: unknown) => {
      log.warn('extensions', 'A popup failed to load', { extension: opts.extension.id, error: err instanceof Error ? err.message : String(err) })
      this.close()
    })
  }

  close(): void {
    const open = this.#open
    if (!open) return
    this.#open = null
    open.cleanup()
    // Deferred: tearing a view down inside one of its own events can hang the app's exit.
    setImmediate(() => {
      if (!open.window.isDestroyed()) open.window.contentView.removeChildView(open.view)
      if (!open.view.webContents.isDestroyed()) open.view.webContents.close()
    })
    open.onClosed()
  }
}
