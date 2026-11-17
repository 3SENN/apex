/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The recent-tab switcher's cards (SH-29): up to eight, most recently used
// first. A split pair is one card (both pages, left then right) and a chat
// tab shows the chat's icon. Pure, so it is tested.
import type { TabInfo, TabsSnapshot } from '@shared/ipc'
import type { RecentCard, TabCardPage } from '@shared/overlay/tabs'
import { chatIdOfUrl } from './order'

export const SWITCHER_MAX = 8

function pageOf(tab: TabInfo, host: (url: string) => string): TabCardPage {
  return { tabId: tab.id, title: tab.title, host: host(tab.url), favicon: tab.favicon, thumbnail: null }
}

export function recentCards(recent: readonly string[], snapshot: Pick<TabsSnapshot, 'tabs' | 'split'>, host: (url: string) => string, max = SWITCHER_MAX): RecentCard[] {
  const byId = new Map(snapshot.tabs.map((t) => [t.id, t]))
  // Tabs main hasn't ranked yet (just opened elsewhere) follow in list order.
  const ids = [...recent, ...snapshot.tabs.map((t) => t.id).filter((id) => !recent.includes(id))]
  const seen = new Set<string>()
  const cards: RecentCard[] = []
  const split = snapshot.split
  for (const id of ids) {
    if (cards.length >= max) break
    const tab = byId.get(id)
    if (!tab || seen.has(id)) continue
    seen.add(id)
    if (split && (split.primaryId === id || split.secondaryId === id)) {
      const left = byId.get(split.primaryId)
      const right = byId.get(split.secondaryId)
      seen.add(split.primaryId)
      seen.add(split.secondaryId)
      if (left && right) {
        cards.push({ tabId: id, kind: 'split', pages: [pageOf(left, host), pageOf(right, host)] })
        continue
      }
    }
    cards.push({ tabId: id, kind: chatIdOfUrl(tab.url) ? 'chat' : 'tab', pages: [pageOf(tab, host)] })
  }
  return cards
}

/** The card a step lands on, wrapping both ways. */
export function stepSelection(selected: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (((selected + delta) % count) + count) % count
}

/** Where the switcher opens: on the previous tab, so one ⌃Tab flips back. */
export function initialSelection(count: number, delta: 1 | -1): number {
  if (count <= 1) return 0
  return delta === 1 ? 1 : count - 1
}
