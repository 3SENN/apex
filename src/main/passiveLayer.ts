/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BrowserWindow, type WebContents } from 'electron'

// The passive overlay tier (OV-01): a transparent, click-through,
// never-focused child window over the parent's content area. Tooltips, the
// link bubble, progress, flights and the full-screen notice draw here, so they
// can cross page views without ever catching a click. A child window moves
// with its parent on its own; size, full screen and restore are synced here.
// It is shown with showInactive only while something is drawn.

export class PassiveLayer {
  readonly window: BrowserWindow
  readonly #parent: BrowserWindow
  #wanted = false

  constructor(parent: BrowserWindow, opts: { preload: string; url: string }) {
    this.#parent = parent
    this.window = new BrowserWindow({
      parent,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: { preload: opts.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
    })
    this.window.setIgnoreMouseEvents(true)
    this.window.excludedFromShownWindowsMenu = true
    const sync = (): void => this.sync()
    // Listed one by one: BrowserWindow.on's overloads don't take a union of event names.
    parent.on('resize', sync)
    parent.on('move', sync)
    parent.on('restore', sync)
    parent.on('maximize', sync)
    parent.on('unmaximize', sync)
    // Full-screen transitions settle after the event; sync once more.
    parent.on('enter-full-screen', () => {
      sync()
      setTimeout(sync, 400)
    })
    parent.on('leave-full-screen', () => {
      sync()
      setTimeout(sync, 400)
    })
    // Minimise hides the layer with the parent; restore brings it back.
    parent.on('minimize', () => this.#apply())
    parent.on('restore', () => this.#apply())
    parent.on('show', () => this.#apply())
    parent.on('hide', () => {
      if (!this.window.isDestroyed()) this.window.hide()
    })
    parent.once('closed', () => {
      if (!this.window.isDestroyed()) this.window.destroy()
    })
    this.sync()
    void this.window.loadURL(opts.url).catch(() => undefined)
  }

  get webContents(): WebContents {
    return this.window.webContents
  }

  /** Covers the parent's content area exactly. */
  sync(): void {
    if (this.window.isDestroyed() || this.#parent.isDestroyed()) return
    const bounds = this.#parent.getContentBounds()
    this.window.setBounds(bounds)
  }

  /** Shows the layer (without focus) while surfaces are drawn; hidden layers cost almost nothing. */
  setVisible(visible: boolean): void {
    this.#wanted = visible
    this.#apply()
  }

  #apply(): void {
    if (this.window.isDestroyed() || this.#parent.isDestroyed()) return
    const show = this.#wanted && this.#parent.isVisible() && !this.#parent.isMinimized()
    if (show && !this.window.isVisible()) {
      this.sync()
      this.window.showInactive()
    } else if (!show && this.window.isVisible()) this.window.hide()
  }

  destroy(): void {
    if (!this.window.isDestroyed()) this.window.destroy()
  }
}
