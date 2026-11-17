/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { OrderEntry } from '@shared/ipc'
import { isInternalUrl, parseInternalUrl } from '@shared/url'
import { writeAtomic } from './settings'

// Pure tab bookkeeping, kept apart from TabManager so it can be tested
// without Electron: the visible order for shortcuts, the reopen stack and
// the pinned-tab file.

/** What order helpers need to know about a tab. */
export interface OrderTab {
  id: string
  /** Set when the tab shows apex://chat/<id>: the sidebar shows its chat row instead of a tab row. */
  chatId: string | null
}

export function chatIdOf(url: string | null): string | null {
  if (!url) return null
  const route = parseInternalUrl(url)
  return route?.page === 'chat' ? route.id : null
}

/**
 * The order ⌘1–8 and next/previous follow. The chrome reports what it shows;
 * tabs it hasn't reported yet (just created) are appended, except a chat-page
 * tab whose chat row is already listed, which would otherwise count twice.
 * Without a report, main's own order is used.
 */
export function effectiveOrder(reported: readonly OrderEntry[] | null, tabs: readonly OrderTab[]): OrderEntry[] {
  if (!reported) return tabs.map((t) => ({ kind: 'tab', id: t.id }))
  const ids = new Set(tabs.map((t) => t.id))
  const order = reported.filter((e) => e.kind === 'chat' || ids.has(e.id))
  const listedTabs = new Set(order.filter((e) => e.kind === 'tab').map((e) => e.id))
  const listedChats = new Set(order.filter((e) => e.kind === 'chat').map((e) => e.id))
  for (const tab of tabs) {
    if (listedTabs.has(tab.id) || (tab.chatId && listedChats.has(tab.chatId))) continue
    order.push({ kind: 'tab', id: tab.id })
  }
  return order
}

/** Where the active tab sits in the order: its own entry, or its chat's row. -1 if neither. */
export function currentIndex(order: readonly OrderEntry[], active: OrderTab | null): number {
  if (!active) return -1
  const own = order.findIndex((e) => e.kind === 'tab' && e.id === active.id)
  if (own !== -1 || !active.chatId) return own
  return order.findIndex((e) => e.kind === 'chat' && e.id === active.chatId)
}

/** The next (delta 1) or previous (delta -1) entry, wrapping around. */
export function stepEntry(order: readonly OrderEntry[], current: number, delta: number): OrderEntry | null {
  if (order.length === 0) return null
  const start = current === -1 ? (delta > 0 ? -1 : 0) : current
  return order[(((start + delta) % order.length) + order.length) % order.length] ?? null
}

/** ⌘1–8 pick the nth entry; ⌘9 (n = 'last') the last one. */
export function nthEntry(order: readonly OrderEntry[], n: number | 'last'): OrderEntry | null {
  return (n === 'last' ? order[order.length - 1] : order[n]) ?? null
}

export interface ClosedTab {
  url: string
  title: string
  pinned: boolean
  /** Where it sat in main's order, so it comes back in place. */
  index: number
}

/** The ⇧⌘T stack, newest last. Blank tabs are not worth reopening, nor what `setSkip` names (a private chat's page, CH-30). */
export class ClosedTabStack {
  readonly #items: Array<ClosedTab & { seq: number }> = []
  readonly #limit: number
  #skip: ((url: string) => boolean) | null = null
  #seq = 0

  constructor(limit = 25) {
    this.#limit = limit
  }

  setSkip(fn: ((url: string) => boolean) | null): void {
    this.#skip = fn
  }

  push(tab: ClosedTab): void {
    if (tab.url === '' || tab.url === 'about:blank' || this.#skip?.(tab.url) === true) return
    this.#items.push({ ...tab, seq: ++this.#seq })
    if (this.#items.length > this.#limit) this.#items.shift()
  }

  pop(): ClosedTab | null {
    const item = this.#items.pop()
    if (!item) return null
    const { seq: _seq, ...tab } = item
    return tab
  }

  /** A point to drop back to: what is pushed after it can be forgotten (a clear that was undone). */
  mark(): number {
    return this.#seq
  }

  /** Forgets the tabs pushed since `mark`, so ⇧⌘T doesn't bring back tabs that are open again. */
  dropSince(mark: number): void {
    for (let i = this.#items.length - 1; i >= 0; i--) if ((this.#items[i]?.seq ?? 0) > mark) this.#items.splice(i, 1)
  }

  get size(): number {
    return this.#items.length
  }
}

export interface PinnedTab {
  url: string
  title: string
}

const pinnedSchema = z.object({ url: z.string().min(1).max(8192), title: z.string().max(1024) })

/** Restorable addresses only: web pages and known Apex pages. */
export function isRestorableUrl(url: string): boolean {
  if (isInternalUrl(url)) return parseInternalUrl(url) !== null
  return /^https?:\/\//i.test(url)
}

/** Pinned tabs in pinned-tabs.json, shared by every window of the profile. */
export class PinnedTabsStore {
  readonly #path: string

  constructor(dataDir: string) {
    this.#path = join(dataDir, 'pinned-tabs.json')
  }

  load(): PinnedTab[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, 'utf8'))
      if (!Array.isArray(raw)) return []
      return raw
        .map((item) => pinnedSchema.safeParse(item))
        .flatMap((r) => (r.success && isRestorableUrl(r.data.url) ? [r.data] : []))
        .slice(0, 50)
    } catch {
      return []
    }
  }

  save(tabs: readonly PinnedTab[]): void {
    writeAtomic(this.#path, JSON.stringify(tabs.filter((t) => isRestorableUrl(t.url)).slice(0, 50), null, 2))
  }
}
