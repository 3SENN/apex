/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// One window's dialog queue (OV-07), free of Electron so the rules are
// unit-tested. One dialog shows at a time; the rest wait in order, and a
// duplicate (same dedupeKey as one waiting or showing) is dropped onto the
// one already there. A tab dialog only shows while its tab is on screen, so
// a page's alert in a background tab never holds up the window's own
// questions; it waits, hidden, until you come back.

export interface QueuedDialog<T> {
  id: string
  /** null for a window dialog. */
  tabId: string | null
  dedupeKey?: string
  payload: T
}

export type PushResult = { accepted: true } | { accepted: false; sameAs: string }

export class DialogQueue<T> {
  #pending: QueuedDialog<T>[] = []
  /** Started dialogs by scope: 'window' or a tab id. */
  readonly #active = new Map<string, QueuedDialog<T>>()

  push(item: QueuedDialog<T>): PushResult {
    if (item.dedupeKey) {
      const same = [...this.#active.values(), ...this.#pending].find((d) => d.dedupeKey === item.dedupeKey)
      if (same) return { accepted: false, sameAs: same.id }
    }
    this.#pending.push(item)
    return { accepted: true }
  }

  /**
   * The next dialog to start, now marked active, or null. Nothing starts
   * while a started dialog is on screen; a waiting tab dialog starts only
   * while its tab is visible.
   */
  next(visibleTabs: readonly string[]): QueuedDialog<T> | null {
    const onScreen = (d: QueuedDialog<T>): boolean => d.tabId === null || visibleTabs.includes(d.tabId)
    if ([...this.#active.values()].some(onScreen)) return null
    const index = this.#pending.findIndex((d) => onScreen(d) && !this.#active.has(scope(d)))
    if (index < 0) return null
    const [item] = this.#pending.splice(index, 1)
    if (!item) return null
    this.#active.set(scope(item), item)
    return item
  }

  /** Takes a dialog out, started or waiting; returns it, or null when it was not here. */
  remove(id: string): QueuedDialog<T> | null {
    for (const [key, d] of this.#active) {
      if (d.id !== id) continue
      this.#active.delete(key)
      return d
    }
    const index = this.#pending.findIndex((d) => d.id === id)
    if (index < 0) return null
    return this.#pending.splice(index, 1)[0] ?? null
  }

  /** Every dialog of a tab (it closed or navigated), started ones first. */
  forTab(tabId: string): QueuedDialog<T>[] {
    const active = this.#active.get(tabId)
    return [...(active ? [active] : []), ...this.#pending.filter((d) => d.tabId === tabId)]
  }

  isActive(id: string): boolean {
    return [...this.#active.values()].some((d) => d.id === id)
  }

  get(id: string): QueuedDialog<T> | null {
    return [...this.#active.values(), ...this.#pending].find((d) => d.id === id) ?? null
  }

  all(): QueuedDialog<T>[] {
    return [...this.#active.values(), ...this.#pending]
  }

  get size(): number {
    return this.#active.size + this.#pending.length
  }
}

function scope(d: QueuedDialog<unknown>): string {
  return d.tabId ?? 'window'
}
