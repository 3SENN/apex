/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tab thumbnails for hover cards and the recent-tab switcher (SH-28, SH-29).
// Captures are cached per tab and refreshed when a tab is switched to; a
// playing media tab gets a throttled live frame while it is hovered.
// The capture itself is injected, so the cache rules are unit-tested.

export interface ThumbnailOptions {
  /** A media tab being hovered: refresh when the cached frame is older than LIVE_MS. */
  live?: boolean
}

/** Live frames for media tabs at most this often. */
export const LIVE_MS = 1000
/** A cached frame older than this is refreshed on the next ask while the tab shows. */
export const STALE_MS = 30_000
/** Wait after a switch so the page has painted before it is captured. */
export const SETTLE_MS = 700

interface Entry {
  dataUrl: string
  at: number
}

export class ThumbnailCache {
  readonly #capture: (tabId: string) => Promise<string | null>
  readonly #now: () => number
  readonly #entries = new Map<string, Entry>()
  readonly #inflight = new Map<string, Promise<string | null>>()
  readonly #limit: number

  constructor(capture: (tabId: string) => Promise<string | null>, { now = Date.now, limit = 120 }: { now?: () => number; limit?: number } = {}) {
    this.#capture = capture
    this.#now = now
    this.#limit = limit
  }

  /** The cached frame, refreshed when missing, stale, or live and older than LIVE_MS. */
  async get(tabId: string, { live = false }: ThumbnailOptions = {}): Promise<string | null> {
    const cached = this.#entries.get(tabId)
    const age = cached ? this.#now() - cached.at : Infinity
    if (cached && age < (live ? LIVE_MS : STALE_MS)) return cached.dataUrl
    const fresh = await this.refresh(tabId)
    return fresh ?? cached?.dataUrl ?? null
  }

  /** Captures now (one capture per tab at a time); a failed capture keeps the old frame. */
  refresh(tabId: string): Promise<string | null> {
    const running = this.#inflight.get(tabId)
    if (running) return running
    const job = this.#capture(tabId)
      .catch(() => null)
      .then((dataUrl) => {
        this.#inflight.delete(tabId)
        if (dataUrl) this.#store(tabId, dataUrl)
        return dataUrl
      })
    this.#inflight.set(tabId, job)
    return job
  }

  peek(tabId: string): string | null {
    return this.#entries.get(tabId)?.dataUrl ?? null
  }

  drop(tabId: string): void {
    this.#entries.delete(tabId)
  }

  get size(): number {
    return this.#entries.size
  }

  #store(tabId: string, dataUrl: string): void {
    this.#entries.delete(tabId)
    this.#entries.set(tabId, { dataUrl, at: this.#now() })
    // Oldest first out: Map keeps insertion order and #store re-inserts.
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }
}
