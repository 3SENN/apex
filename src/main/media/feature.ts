/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcMain, type IpcMainEvent } from 'electron'
import { PAGE_MEDIA } from '@shared/media'
import type { AppContext, Feature, ServiceParts, WindowContext } from '../features/types'
import type { Tab } from '../tabs'
import { MediaHub } from './hub'
import { registerMediaMenu } from './menu'
import { setMediaReports } from './registry'
import { pageMediaMessageSchema } from './report'

// The media feature (MD-01 to MD-04): the hub, the page helpers' reports, the
// page menu on media and the window-scoped `media` service. Media keys and
// the system's Now Playing stay Chromium's own (its audio focus follows the
// source that started last, which the hub marks `active`); Apex registers no
// media-key shortcut that would take them over.

let hub: MediaHub | null = null
let offMenu: (() => void) | null = null
let onReport: ((event: IpcMainEvent, payload: unknown) => void) | null = null

function reportHandler(app: AppContext): (event: IpcMainEvent, payload: unknown) => void {
  return (event, payload) => {
    // Only a tab's own frames report; the chrome, overlays and other pages are ignored.
    const tab = app.tabsRegistry.byWebContents(event.sender.id)
    const frame = event.senderFrame
    if (!tab || !frame || !hub) return
    const parsed = pageMediaMessageSchema.safeParse(payload)
    if (!parsed.success) return
    hub.report(tab.id, { processId: frame.processId, routingId: frame.routingId }, parsed.data)
  }
}

function windowServices(win: WindowContext, h: MediaHub): ServiceParts {
  return {
    media: {
      state: () => h.state(win),
      control: (tabId, command) => h.control(tabId, command),
      setRate: (tabId, rate) => h.setRate(tabId, rate),
      pictureInPicture: (tabId) => h.pictureInPicture(tabId),
      focus: (tabId) => h.focus(tabId),
    },
  }
}

export const mediaFeature: Feature = {
  name: 'media',
  app(app) {
    hub = new MediaHub({ windows: () => app.windows.all() })
    const h = hub
    setMediaReports((tabId) => h.reportOf(tabId))
    onReport = reportHandler(app)
    ipcMain.on(PAGE_MEDIA.report, onReport)
    offMenu = registerMediaMenu()
  },
  window(win) {
    const h = hub
    if (!h) return
    const changed = (): void => h.schedule()
    // A tab moving to another window keeps its reports (its page helper only reports changes).
    const forget = (tab: Tab, how?: { moved?: boolean }): void => (how?.moved ? h.schedule() : h.forget(tab.id))
    const navigated = (tab: Tab, nav: { mainFrame: boolean; inPage: boolean }): void => {
      if (nav.mainFrame && !nav.inPage) h.forget(tab.id)
    }
    win.tabs.on('changed', changed)
    win.tabs.on('activated', changed)
    win.tabs.on('closed', forget)
    win.tabs.on('navigated', navigated)
    win.window.once('closed', () => {
      win.tabs.off('changed', changed)
      win.tabs.off('activated', changed)
      win.tabs.off('closed', forget)
      win.tabs.off('navigated', navigated)
      h.schedule()
    })
    return windowServices(win, h)
  },
  dispose() {
    if (onReport) ipcMain.off(PAGE_MEDIA.report, onReport)
    onReport = null
    offMenu?.()
    offMenu = null
    setMediaReports(null)
    hub?.dispose()
    hub = null
  },
}
