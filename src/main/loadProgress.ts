/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LoadStage } from '@shared/tabs'
import type { WindowContext } from './features/types'
import type { Tab } from './tabs'

// Page-load stages (SS-01 part, DS-28): started, response, DOM ready and
// finished, with when the load started, for the progress bar and the
// pill's "Still loading" notice after 8 s. TabManager reads them through a
// decorator; nothing here runs between loads.

export interface LoadInfo {
  loadStage: LoadStage
  loadStartedAt: number | null
}

const IDLE: LoadInfo = { loadStage: 'idle', loadStartedAt: null }

export class LoadProgress {
  readonly #loads = new Map<string, LoadInfo>()

  info(tabId: string): LoadInfo | undefined {
    return this.#loads.get(tabId)
  }

  /** Watches one tab; `onChange` hears each new stage (the page-progress bar). Returns the cleanup. */
  attach(tab: Tab, win: WindowContext, onChange?: (info: LoadInfo) => void): () => void {
    const wc = tab.view.webContents
    const set = (next: LoadInfo): void => {
      const prev = this.#loads.get(tab.id) ?? IDLE
      if (prev.loadStage === next.loadStage && prev.loadStartedAt === next.loadStartedAt) return
      this.#loads.set(tab.id, next)
      win.tabs.refresh()
      onChange?.(next)
    }
    const started = (): void => set({ loadStage: 'started', loadStartedAt: Date.now() })
    const stage = (loadStage: LoadStage) => (): void => {
      const prev = this.#loads.get(tab.id)
      // A late event from a load that already finished changes nothing.
      if (!prev || prev.loadStage === 'finished' || prev.loadStage === 'idle') return
      set({ loadStage, loadStartedAt: prev.loadStartedAt })
    }
    const response = stage('response')
    const domReady = stage('dom-ready')
    const finished = (): void => set({ loadStage: 'finished', loadStartedAt: null })
    wc.on('did-start-loading', started)
    wc.on('did-navigate', response)
    wc.on('dom-ready', domReady)
    wc.on('did-stop-loading', finished)
    return () => {
      this.#loads.delete(tab.id)
      if (wc.isDestroyed()) return
      wc.off('did-start-loading', started)
      wc.off('did-navigate', response)
      wc.off('dom-ready', domReady)
      wc.off('did-stop-loading', finished)
    }
  }
}
