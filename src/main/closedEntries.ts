/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RECENTLY_CLOSED_LIMIT, type ClosedEntry, type SavedWindow } from '@shared/windows'

// Recently closed tabs, windows and chats across every window (SH-27). ⇧⌘T
// pops the newest into the current window with its history and position;
// History › Recently closed lists the last ten. Private windows never add
// anything. Kept free of Electron so it is unit-tested.

export type ClosedRecord =
  | { kind: 'tab'; title: string; url: string; closedAt: number; index: number; pinned: boolean; entries: { url: string; title: string }[]; entryIndex: number; groupId: string | null }
  | { kind: 'window'; title: string; tabCount: number; closedAt: number; saved: SavedWindow }
  | { kind: 'chat'; chatId: string; title: string; closedAt: number }

/** The stack keeps more than the menu shows, so several reopens in a row still work. */
export const CLOSED_STACK_LIMIT = 50

export class ClosedEntries {
  readonly #items: ClosedRecord[] = []
  readonly #limit: number
  readonly #listeners = new Set<() => void>()

  constructor(limit = CLOSED_STACK_LIMIT) {
    this.#limit = limit
  }

  push(record: ClosedRecord): void {
    // Blank tabs and empty windows are not worth reopening.
    if (record.kind === 'tab' && (record.url === '' || record.url === 'about:blank')) return
    if (record.kind === 'window' && record.tabCount === 0) return
    this.#items.push(record)
    if (this.#items.length > this.#limit) this.#items.shift()
    this.#changed()
  }

  get size(): number {
    return this.#items.length
  }

  /** Newest first, as the History menu shows them. */
  list(limit = RECENTLY_CLOSED_LIMIT): ClosedEntry[] {
    return this.#items
      .slice(-limit)
      .reverse()
      .map((r): ClosedEntry => {
        if (r.kind === 'tab') return { kind: 'tab', title: r.title, url: r.url, closedAt: r.closedAt }
        if (r.kind === 'window') return { kind: 'window', title: r.title, tabCount: r.tabCount, closedAt: r.closedAt }
        return { kind: 'chat', chatId: r.chatId, title: r.title, closedAt: r.closedAt }
      })
  }

  /** Takes the entry at `index` in list order (0 is the newest), or null. */
  take(index = 0): ClosedRecord | null {
    const at = this.#items.length - 1 - index
    if (index < 0 || at < 0) return null
    const [record] = this.#items.splice(at, 1)
    this.#changed()
    return record ?? null
  }

  /** Forgets entries for a chat that was deleted. */
  forgetChat(chatId: string): void {
    const before = this.#items.length
    for (let i = this.#items.length - 1; i >= 0; i--) {
      const r = this.#items[i]
      if (r?.kind === 'chat' && r.chatId === chatId) this.#items.splice(i, 1)
    }
    if (this.#items.length !== before) this.#changed()
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  #changed(): void {
    for (const fn of [...this.#listeners]) fn()
  }
}
