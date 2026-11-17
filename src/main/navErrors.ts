/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PageError } from '@shared/sites'
import { classifyLoadFailure, type BlockReason } from '@shared/safety'

// Failed, crashed and unresponsive pages (SS-07).
// Each tab gets a tracker fed by its webContents events; TabInfo reads
// its state (pageError, crashed, unresponsive) and the chrome draws the error
// page in the pane while the page view is hidden. The failed address stays
// the tab's URL, so the pill and back/forward keep it.

/**
 * Why the mux cancelled a top-level request, so its ERR_BLOCKED_BY_CLIENT
 * becomes the dangerous-site or ad-blocker page rather than a generic error.
 * Keyed by webContents id; the entry lives until that tab's next failure.
 */
const blocked = new Map<number, { url: string; reason: BlockReason }>()

export const blockedNavigations = {
  note(webContentsId: number, url: string, reason: BlockReason): void {
    blocked.set(webContentsId, { url, reason })
  },
  take(webContentsId: number, url: string): BlockReason | null {
    const entry = blocked.get(webContentsId)
    blocked.delete(webContentsId)
    return entry && entry.url === url ? entry.reason : null
  },
  forget(webContentsId: number): void {
    blocked.delete(webContentsId)
  },
}

export interface PageErrorState {
  error: PageError | null
  crashed: boolean
  unresponsive: boolean
  /** A reload from the error or crash page is under way. */
  retrying: boolean
}

export const NO_PAGE_ERROR: PageErrorState = { error: null, crashed: false, unresponsive: false, retrying: false }

/** One tab's page state; each method returns whether anything the chrome shows changed. */
export class PageErrorTracker {
  #state: PageErrorState = { ...NO_PAGE_ERROR }

  state(): PageErrorState {
    return { ...this.#state, error: this.#state.error && { ...this.#state.error } }
  }

  /** Whether the chrome draws over the pane (the page view stays hidden). */
  get covering(): boolean {
    return this.#state.error !== null || this.#state.crashed
  }

  failed(code: number, url: string, isMainFrame: boolean, ctx: { online: boolean; blockedBy: BlockReason | null; httpsFallback?: boolean }): boolean {
    if (!isMainFrame) return false
    const kind = classifyLoadFailure(code, ctx)
    if (!kind) return this.#set({ retrying: false })
    return this.#set({ error: { kind, code, url }, crashed: false, unresponsive: false, retrying: false })
  }

  /** A page committed: whatever went wrong before is over. */
  navigated(): boolean {
    return this.#set({ ...NO_PAGE_ERROR })
  }

  startedLoading(): boolean {
    return this.covering ? this.#set({ retrying: true }) : false
  }

  stoppedLoading(): boolean {
    return this.#set({ retrying: false })
  }

  /** render-process-gone; a clean exit (the tab closing) isn't a crash. */
  crashed(reason: string): boolean {
    if (reason === 'clean-exit') return false
    return this.#set({ crashed: true, unresponsive: false, retrying: false })
  }

  unresponsive(): boolean {
    return this.#state.crashed ? false : this.#set({ unresponsive: true })
  }

  responsive(): boolean {
    return this.#set({ unresponsive: false })
  }

  /** The tab moved to an atelier:// page or the new tab, where nothing failed. */
  clear(): boolean {
    return this.#set({ ...NO_PAGE_ERROR })
  }

  #set(patch: Partial<PageErrorState>): boolean {
    const next = { ...this.#state, ...patch }
    const same =
      next.crashed === this.#state.crashed &&
      next.unresponsive === this.#state.unresponsive &&
      next.retrying === this.#state.retrying &&
      next.error?.kind === this.#state.error?.kind &&
      next.error?.code === this.#state.error?.code &&
      next.error?.url === this.#state.error?.url
    this.#state = next
    return !same
  }
}
