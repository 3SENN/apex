/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Tab } from './tabs'

// The global tab registry. Tab ids are unique across windows ('t<n>'),
// so a tab keeps its id when it moves to another window (tear-off).

let next = 1

/** The next global tab id. */
export function nextTabId(): string {
  return `t${next++}`
}

/** Closed tabs remembered for a chat's tab links (`tab:<id>`): enough to reopen the page. */
const CLOSED_KEPT = 200

export class TabRegistry {
  readonly #tabs = new Map<string, { tab: Tab; windowId: number }>()
  readonly #closed = new Map<string, { url: string; private: boolean }>()

  add(tab: Tab, windowId: number): void {
    this.#tabs.set(tab.id, { tab, windowId })
  }

  /** Moves a tab to another window's bookkeeping (TabManager.release then adopt). */
  move(tabId: string, windowId: number): void {
    const entry = this.#tabs.get(tabId)
    if (entry) entry.windowId = windowId
  }

  /** `private`: the tab was in a private window, so its page is never reopened elsewhere. */
  remove(tabId: string, info: { private?: boolean } = {}): void {
    const entry = this.#tabs.get(tabId)
    if (entry) {
      const { tab } = entry
      const wc = tab.view.webContents as Electron.WebContents | undefined
      let url = tab.internalUrl ?? ''
      try {
        if (!url && wc && !wc.isDestroyed()) url = wc.getURL()
      } catch {
        // A view going away mid-close.
      }
      url ||= tab.requestedUrl
      if (url && url !== 'about:blank') {
        this.#closed.delete(tabId)
        this.#closed.set(tabId, { url, private: info.private === true })
        if (this.#closed.size > CLOSED_KEPT) this.#closed.delete(this.#closed.keys().next().value as string)
      }
    }
    this.#tabs.delete(tabId)
  }

  /** Where a closed tab was, for reopening it from a chat's tab link; undefined when it's open or long gone. */
  closedTab(tabId: string): { url: string; private: boolean } | undefined {
    return this.#tabs.has(tabId) ? undefined : this.#closed.get(tabId)
  }

  get(tabId: string): Tab | undefined {
    return this.#tabs.get(tabId)?.tab
  }

  windowOf(tabId: string): number | undefined {
    return this.#tabs.get(tabId)?.windowId
  }

  byWebContents(id: number): Tab | undefined {
    for (const { tab } of this.#tabs.values()) {
      // A destroyed view can report no webContents at all.
      const wc = tab.view.webContents as Electron.WebContents | undefined
      if (wc && !wc.isDestroyed() && wc.id === id) return tab
    }
    return undefined
  }

  all(): Tab[] {
    return [...this.#tabs.values()].map((e) => e.tab)
  }
}
