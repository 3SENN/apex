/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apex's bar over an app whose web server runs (docs/packs.md › A web server
// of its own): trusted UI the app can't draw or hide, like the sharing bar
// over a page that uses the camera. It sits at the top of the app's tab,
// says whether the server is on this computer or shared on the Wi-Fi and how
// many are connected, and Stop ends the server. The first time on the Wi-Fi
// on a Mac it also says macOS will ask about incoming connections. It hides
// while another tab shows and comes back with the app's tab.
import type { WebContents } from 'electron'
import type { AppContext, WindowContext } from '../features/types'
import { log } from '../log'
import { paneAnchor, windowOfTab } from '../siteOverlay'
import type { ServerBarView, ServerIndicator } from './localServers'

interface Shown {
  win: WindowContext
  tabId: string
  instanceId: string | null
  view: ServerBarView
  onStop(): void
}

export function createServerIndicator(app: Pick<AppContext, 'windows' | 'tabsRegistry'>): ServerIndicator & { shown(contentsId: number): { win: WindowContext; instanceId: string | null } | null } {
  const shown = new Map<number, Shown>()

  const present = (contentsId: number, entry: Shown): void => {
    const tab = app.tabsRegistry.byWebContents(contentsId)
    const win = tab ? windowOfTab(app.windows, tab) : null
    if (!tab || !win) return
    entry.win = win
    entry.tabId = tab.id
    const host = win.overlay as typeof win.overlay & { openSurfaces?: () => { instanceId: string; surface: string }[] }
    const before = new Set((host.openSurfaces?.() ?? []).map((s) => s.instanceId))
    let result: Promise<unknown>
    try {
      result = win.overlay.open('server-bar', paneAnchor(win, tab), { tabId: tab.id, ...entry.view }, { tabId: tab.id })
    } catch (err) {
      log.warn('packs', 'The server bar could not open', { error: err instanceof Error ? err.message : String(err) })
      return
    }
    entry.instanceId = (host.openSurfaces?.() ?? []).find((s) => s.surface === 'server-bar' && !before.has(s.instanceId))?.instanceId ?? null
    void result.then(
      (outcome) => {
        if (shown.get(contentsId) !== entry) return
        const value = outcome && typeof outcome === 'object' && 'value' in outcome ? (outcome as { value: unknown }).value : null
        if (value === 'stop') return entry.onStop()
        // Gone some other way (the overlay reloaded, the tab moved to another window) while the server runs: bring it back.
        entry.instanceId = null
        setTimeout(() => {
          if (shown.get(contentsId) === entry) present(contentsId, entry)
        }, 250)
      },
      () => {
        // Before the overlay host is ready there is no bar; the next change tries again.
        if (shown.get(contentsId) === entry) entry.instanceId = null
      },
    )
  }

  return {
    show(contents: WebContents, view: ServerBarView, onStop: () => void): void {
      const old = shown.get(contents.id)
      if (old?.instanceId) old.win.overlay.close(old.instanceId)
      const entry: Shown = { win: null as unknown as WindowContext, tabId: '', instanceId: null, view, onStop }
      shown.set(contents.id, entry)
      present(contents.id, entry)
    },
    update(contents: WebContents, view: ServerBarView): void {
      const entry = shown.get(contents.id)
      if (!entry) return
      entry.view = view
      if (entry.instanceId) entry.win.overlay.update(entry.instanceId, { tabId: entry.tabId, ...view })
      else present(contents.id, entry)
    },
    hide(contents: WebContents): void {
      const entry = shown.get(contents.id)
      shown.delete(contents.id)
      if (entry?.instanceId && !entry.win.window.isDestroyed()) entry.win.overlay.close(entry.instanceId)
    },
    shown(contentsId: number) {
      const entry = shown.get(contentsId)
      return entry ? { win: entry.win, instanceId: entry.instanceId } : null
    },
  }
}
