/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReaderArticle, ReaderTabState } from '@shared/reader'

// Reader state per tab (RD-03), kept apart from Electron so the rules are
// testable: whether the page reads as an article, whether the reader is open,
// and the article it shows. Each change reports whether the tab's TabInfo
// changed, so main re-publishes only then.

interface Entry {
  /** The address the readerable report is about. */
  url: string
  readerable: boolean
  article: ReaderArticle | null
}

export class ReaderTabs {
  readonly #tabs = new Map<string, Entry>()

  #entry(tabId: string): Entry {
    let entry = this.#tabs.get(tabId)
    if (!entry) {
      entry = { url: '', readerable: false, article: null }
      this.#tabs.set(tabId, entry)
    }
    return entry
  }

  /** What TabInfo.reader says: 'open', 'available', or nothing. */
  tabState(tabId: string): ReaderTabState | undefined {
    const entry = this.#tabs.get(tabId)
    if (!entry) return undefined
    if (entry.article) return 'open'
    return entry.readerable ? 'available' : undefined
  }

  isOpen(tabId: string): boolean {
    return this.#tabs.get(tabId)?.article != null
  }

  article(tabId: string): ReaderArticle | null {
    return this.#tabs.get(tabId)?.article ?? null
  }

  /** The page's own report. A stale one (for an address the tab has left) is ignored by the caller. */
  report(tabId: string, url: string, readerable: boolean): boolean {
    const before = this.tabState(tabId)
    const entry = this.#entry(tabId)
    entry.url = url
    entry.readerable = readerable
    return this.tabState(tabId) !== before
  }

  opened(tabId: string, article: ReaderArticle): boolean {
    const before = this.tabState(tabId)
    const entry = this.#entry(tabId)
    entry.article = article
    // The page had an article, whatever its last report said.
    entry.readerable = true
    entry.url = article.url
    return this.tabState(tabId) !== before || before === 'open'
  }

  closed(tabId: string): boolean {
    const entry = this.#tabs.get(tabId)
    if (!entry?.article) return false
    entry.article = null
    return true
  }

  /**
   * The tab committed a new document (a link, a reload, back or forward): the
   * reader closes and the page must report again. A move inside the same
   * document (a fragment, history.pushState) keeps both.
   */
  navigated(tabId: string, url: string, inPage: boolean): boolean {
    const entry = this.#tabs.get(tabId)
    if (!entry) return false
    if (inPage) return false
    const before = this.tabState(tabId)
    entry.article = null
    entry.readerable = false
    entry.url = url
    return this.tabState(tabId) !== before
  }

  forget(tabId: string): void {
    this.#tabs.delete(tabId)
  }
}
