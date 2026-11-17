/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, BrowserWindow, ipcMain, webContents as allWebContents, type BaseWindow, type IpcMainEvent, type WebContents, type WebFrameMain } from 'electron'
import { PAGE, type PageWindowBounds } from '@shared/ipc'
import { popups } from './popups'

// What a page reads of the window around it: window.outerWidth/outerHeight
// and screenX/screenY. Chromium on macOS hands a page in a WebContentsView its
// window's frame only once the view has been laid out and drawn in the window
// (RenderWidgetHostViewCocoa learns it from the window's move and resize
// notifications and the first layout). Until then, a fresh tab's first page
// (about a second when the window is behind other apps or the screen is
// locked) and a background tab until it is first shown read a 0 x 0 window at
// 0,0. Stock Chrome reports the browser window's frame from the first script
// on, and sign-in risk scripts (Google's) treat a zero outer size as a
// headless or embedded tell. Nothing in Electron or the view's bounds pushes
// the frame sooner, and CDP emulation would attach the debugger.
//
// So the page preload (preload/page/windowGeometry.ts) asks, before any page
// script runs and only while Chromium still reports 0, for the host window's
// bounds, and stands in for those getters until Chromium's own value arrives.
// Main answers here and keeps the frames that asked current as their window
// moves and resizes, until each says it has settled.

/** Moves and resizes reach waiting pages at most this often (and once more after the last). */
export const WINDOW_GEOMETRY_THROTTLE_MS = 50

/** The window's outer frame, what Chromium reports as outerWidth/outerHeight/screenX/screenY. */
export function windowBounds(win: BaseWindow | null | undefined): PageWindowBounds | null {
  if (!win || win.isDestroyed()) return null
  const { x, y, width, height } = win.getBounds()
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

/** The window a page is in: a browser window, or the window around a popup (a view in a BaseWindow, which BrowserWindow doesn't find). */
function windowOf(wc: WebContents): BaseWindow | null {
  return BrowserWindow.fromWebContents(wc) ?? popups.windowOf(wc.id)
}

function hostOf(frame: WebFrameMain): BaseWindow | null {
  const wc = allWebContents.fromFrame(frame)
  return wc && !wc.isDestroyed() ? windowOf(wc) : null
}

/** Answers PAGE.window and follows every window's moves; returns the stop. */
export function registerWindowGeometry(): () => void {
  /** The frames standing in for Chromium's window frame, still waiting for its own. */
  const waiting = new Set<WebFrameMain>()
  const stops: (() => void)[] = []

  const onPage = (event: IpcMainEvent, message?: unknown): void => {
    const frame = event.senderFrame
    if (message === 'settled') {
      if (frame) waiting.delete(frame)
      return
    }
    const host = windowOf(event.sender)
    const bounds = windowBounds(host)
    event.returnValue = bounds
    if (bounds && frame) waiting.add(frame)
    // A popup's window isn't a BrowserWindow, so it is followed from its first page's question.
    if (host) follow(host)
  }
  ipcMain.on(PAGE.window, onPage)
  stops.push(() => ipcMain.off(PAGE.window, onPage))

  const push = (win: BaseWindow): void => {
    const bounds = windowBounds(win)
    if (!bounds) return
    for (const frame of waiting) {
      if (frame.isDestroyed() || frame.detached) {
        waiting.delete(frame)
        continue
      }
      if (hostOf(frame) !== win) continue
      try {
        frame.send(PAGE.window, bounds)
      } catch {
        waiting.delete(frame)
      }
    }
  }

  const followed = new WeakSet<BaseWindow>()
  function follow(win: BaseWindow): void {
    if (followed.has(win)) return
    followed.add(win)
    let timer: ReturnType<typeof setTimeout> | null = null
    const changed = (): void => {
      if (timer || waiting.size === 0) return
      timer = setTimeout(() => {
        timer = null
        push(win)
      }, WINDOW_GEOMETRY_THROTTLE_MS)
      timer.unref?.()
    }
    // A window that closes before the timer fires pushes nothing (windowBounds is null).
    win.on('move', changed)
    win.on('resize', changed)
  }
  for (const win of BrowserWindow.getAllWindows()) follow(win)
  const onWindow = (_event: unknown, win: BrowserWindow): void => follow(win)
  app.on('browser-window-created', onWindow)
  stops.push(() => app.off('browser-window-created', onWindow))

  return () => {
    for (const stop of stops) stop()
    waiting.clear()
  }
}
