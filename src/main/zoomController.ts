/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Session } from 'electron'
import type { WindowContext } from './features/types'
import type { Tab } from './tabs'
import { ZOOM_DEFAULT, ZoomStore, stepZoom, zoomKey, clampZoom } from './zoom'

// Applies page zoom (SH-45): stepping a tab saves the level for its host and
// sets it on every tab of that host in every window of the same session;
// navigating to a host brings its saved level back. Emits TabManager's
// 'zoom-changed' so the pill's chip follows.

export interface ZoomController {
  step(tabId: string, delta: 1 | -1): number
  reset(tabId: string): number
  get(tabId: string): number
  set(tabId: string, percent: number): number
  /** A tab committed a navigation: give it its host's saved level. */
  restore(tab: Tab, win: WindowContext): void
  /** The zoom row the main menu shows: the active tab's level and whether each button does anything. */
  row(win: WindowContext | null): { percent: number; canZoomIn: boolean; canZoomOut: boolean; isDefault: boolean; applies: boolean }
}

export interface ZoomControllerDeps {
  windows(): readonly WindowContext[]
  storeFor(session: Session): ZoomStore
}

export function createZoomController(deps: ZoomControllerDeps): ZoomController {
  const locate = (tabId: string): { tab: Tab; win: WindowContext } | null => {
    for (const win of deps.windows()) {
      const tab = win.tabs.find(tabId)
      if (tab) return { tab, win }
    }
    return null
  }
  const alive = (tab: Tab): boolean => !tab.view.webContents.isDestroyed()
  const percentOf = (tab: Tab): number => (alive(tab) ? Math.round(tab.view.webContents.getZoomFactor() * 100) : ZOOM_DEFAULT)
  const urlOf = (tab: Tab): string => (alive(tab) ? tab.view.webContents.getURL() : '')

  const setOn = (tab: Tab, win: WindowContext, percent: number): void => {
    if (!alive(tab) || percentOf(tab) === percent) return
    tab.view.webContents.setZoomFactor(percent / 100)
    win.tabs.emit('zoom-changed', tab, percent)
  }

  /** Every tab on this host in this session takes the level. */
  const spread = (key: string, session: Session, percent: number): void => {
    for (const win of deps.windows()) {
      let touched = false
      for (const tab of win.tabs.all()) {
        if (tab.internalUrl || !alive(tab) || tab.view.webContents.session !== session || zoomKey(urlOf(tab)) !== key) continue
        setOn(tab, win, percent)
        touched = true
      }
      if (touched) win.tabs.refresh()
    }
  }

  const apply = (tabId: string, next: (current: number) => number): number => {
    const found = locate(tabId)
    if (!found) throw new Error('That tab is closed.')
    const { tab, win } = found
    // Atelier pages and the new tab are drawn by the chrome; their keys go to the interface zoom.
    if (win.tabs.isChromeDrawn(tab)) return ZOOM_DEFAULT
    const percent = clampZoom(next(percentOf(tab)))
    const key = zoomKey(urlOf(tab))
    const session = tab.view.webContents.session
    if (key) {
      deps.storeFor(session).set(key, percent)
      spread(key, session, percent)
    } else {
      setOn(tab, win, percent)
      win.tabs.refresh()
    }
    return percent
  }

  return {
    step: (tabId, delta) => apply(tabId, (current) => stepZoom(current, delta)),
    reset: (tabId) => apply(tabId, () => ZOOM_DEFAULT),
    set: (tabId, percent) => apply(tabId, () => percent),
    get(tabId) {
      const found = locate(tabId)
      return found && !found.win.tabs.isChromeDrawn(found.tab) ? percentOf(found.tab) : ZOOM_DEFAULT
    },
    restore(tab, win) {
      const key = zoomKey(urlOf(tab))
      if (!key || !alive(tab)) return
      const saved = deps.storeFor(tab.view.webContents.session).get(key)
      if (percentOf(tab) !== saved) {
        setOn(tab, win, saved)
        win.tabs.refresh()
      }
    },
    row(win) {
      const tab = win?.tabs.active() ?? null
      const applies = !!tab && !!win && !win.tabs.isChromeDrawn(tab)
      const percent = applies && tab ? percentOf(tab) : ZOOM_DEFAULT
      return { percent, canZoomIn: applies && percent < 500, canZoomOut: applies && percent > 25, isDefault: percent === ZOOM_DEFAULT, applies }
    },
  }
}
