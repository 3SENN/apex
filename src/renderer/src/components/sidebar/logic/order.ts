/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure ordering rules for the sidebar and the strip: the pinned grid, tab and
// chat sorting, "no reshuffle under the pointer", and the order ⌘1–8 follow.
// No DOM or window.apex here, so it is unit-tested directly.
import type { ChatSummary } from '@shared/chats'
import type { ChatSort as SidebarChatSort, OrderEntry, SidebarSections, TabInfo, TabSort } from '@shared/ipc'
import { parseInternalUrl } from '@shared/url'

/**
 * Columns for the pinned favicon grid: one or two tiles use one or two
 * columns; more use three or four, whichever leaves fewer empty cells in the
 * last row (ties go to four, which needs fewer rows).
 */
export function pinnedColumns(count: number): number {
  if (count <= 2) return Math.max(1, count)
  const empty = (cols: number): number => (cols - (count % cols)) % cols
  return empty(3) < empty(4) ? 3 : 4
}

/** The chat a tab shows as a page (apex://chat/<id>), or null. */
export function chatIdOfUrl(url: string): string | null {
  const route = parseInternalUrl(url)
  return route?.page === 'chat' ? route.id : null
}

/**
 * Keeps the previous order of ids that still exist and slots new ids in
 * where the live order puts them: right after the known id before them, or
 * at the top when nothing known comes first (a new tab, a routine's chat).
 * Used while the pointer is over the sidebar, so rows never move under it.
 */
export function stableOrder(previous: readonly string[], live: readonly string[]): string[] {
  const liveSet = new Set(live)
  const result = previous.filter((id) => liveSet.has(id))
  const known = new Set(result)
  let anchor: string | null = null
  for (const id of live) {
    if (known.has(id)) {
      anchor = id
      continue
    }
    result.splice(anchor === null ? 0 : result.indexOf(anchor) + 1, 0, id)
    known.add(id)
    anchor = id
  }
  return result
}

/** Where a tab sits in recent-activity order after you dropped it: at the top, or right after another tab. */
export type Placement = { after: string | null; at: number }

/**
 * Recent-activity order with drop overrides. A dropped tab keeps its spot
 * (after `after`, or at the top) until it is used again (lastActiveAt past
 * the drop time).
 */
export function sortTabs(tabs: readonly TabInfo[], sort: TabSort, placements: Readonly<Record<string, Placement>> = {}): TabInfo[] {
  if (sort === 'manual') return tabs.slice()
  const sorted = tabs.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  const placed = sorted.filter((t) => {
    const p = placements[t.id]
    return p !== undefined && t.lastActiveAt <= p.at
  })
  if (placed.length === 0) return sorted
  const result = sorted.filter((t) => !placed.includes(t))
  // Oldest drops first, so a later drop next to the same tab lands closer to it.
  placed.sort((a, b) => (placements[a.id]?.at ?? 0) - (placements[b.id]?.at ?? 0))
  for (const tab of placed) {
    const after = placements[tab.id]?.after ?? null
    const index = after === null ? -1 : result.findIndex((t) => t.id === after)
    result.splice(after === null ? 0 : index === -1 ? 0 : index + 1, 0, tab)
  }
  return result
}

/** Progress order: waiting for you, then working, then results to read, then the rest. */
export function chatProgressRank(chat: ChatSummary): number {
  if (chat.status === 'needs-approval' || chat.needsInput) return 0
  if (chat.status === 'running') return 1
  if (chat.unread || chat.status === 'error') return 2
  return 3
}

/**
 * The Chats section's order. Pinned chats always sit on top. 'progress' only
 * applies while both sections show; otherwise it reads as 'recent'.
 * `manual` lists chat ids in your drag order (newest opens first).
 */
export function sortChats(chats: readonly ChatSummary[], sort: SidebarChatSort, sections: SidebarSections, manual: readonly string[] = []): ChatSummary[] {
  const mode = sort === 'progress' && sections !== 'tabs-and-chats' ? 'recent' : sort
  const recent = (a: ChatSummary, b: ChatSummary): number => b.lastActiveAt - a.lastActiveAt
  const position = (id: string): number => {
    const i = manual.indexOf(id)
    return i === -1 ? -1 : i
  }
  const compare = (a: ChatSummary, b: ChatSummary): number => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (mode === 'progress') {
      const rank = chatProgressRank(a) - chatProgressRank(b)
      if (rank !== 0) return rank
      return recent(a, b)
    }
    if (mode === 'manual') {
      const pa = position(a.id)
      const pb = position(b.id)
      // Chats missing from the manual list (just opened) go first, newest first.
      if (pa === -1 || pb === -1) return pa === pb ? recent(a, b) : pa === -1 ? -1 : 1
      return pa - pb
    }
    return recent(a, b)
  }
  return chats.slice().sort(compare)
}

/** Every word of the filter appears in one of the fields (case-insensitive). */
export function matchesFilter(query: string, ...fields: Array<string | null | undefined>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = fields.filter(Boolean).join(' ').toLowerCase()
  return words.every((w) => haystack.includes(w))
}

/**
 * The order ⌘1–8 and next/previous follow: pinned tiles, then the chat rows
 * shown, then the tab rows. A chat-page tab is represented by its chat row,
 * and a split pair counts once (its first tab).
 */
export function visibleOrder(pinned: readonly TabInfo[], chatIds: readonly string[], rows: readonly TabInfo[]): OrderEntry[] {
  const entries: OrderEntry[] = []
  const chats = new Set(chatIds)
  for (const tab of pinned) entries.push({ kind: 'tab', id: tab.id })
  for (const id of chatIds) entries.push({ kind: 'chat', id })
  for (const tab of rows) {
    const chatId = chatIdOfUrl(tab.url)
    if (chatId && chats.has(chatId)) continue
    entries.push({ kind: 'tab', id: tab.id })
  }
  return entries
}

/** Rows of the tab list: a split pair becomes one row, placed where its first tab is. */
export type TabRowItem = { kind: 'tab'; tab: TabInfo } | { kind: 'split'; primary: TabInfo; secondary: TabInfo }

export function tabRows(tabs: readonly TabInfo[], split: { primaryId: string; secondaryId: string } | null): TabRowItem[] {
  if (!split) return tabs.map((tab) => ({ kind: 'tab', tab }))
  const primary = tabs.find((t) => t.id === split.primaryId)
  const secondary = tabs.find((t) => t.id === split.secondaryId)
  if (!primary || !secondary) return tabs.map((tab) => ({ kind: 'tab', tab }))
  const rows: TabRowItem[] = []
  let placed = false
  for (const tab of tabs) {
    if (tab.id === primary.id || tab.id === secondary.id) {
      if (!placed) rows.push({ kind: 'split', primary, secondary })
      placed = true
    } else rows.push({ kind: 'tab', tab })
  }
  return rows
}

/** Content card limits: below these the sidebar hides itself. */
export const CONTENT_MIN_WITH_PANEL = 600
export const CONTENT_MIN = 480

/** Whether the sidebar fits next to the content card (and the panel, when open). */
export function sidebarFits(windowWidth: number, sidebarWidth: number, panelWidth: number | null): boolean {
  const content = windowWidth - sidebarWidth - (panelWidth ?? 0)
  return content >= (panelWidth === null ? CONTENT_MIN : CONTENT_MIN_WITH_PANEL)
}

/** The insertion index for a drop at `y` over rows with these vertical midpoints. */
export function dropIndex(midpoints: readonly number[], y: number): number {
  const index = midpoints.findIndex((mid) => y < mid)
  return index === -1 ? midpoints.length : index
}

/**
 * Where a manual-order drop lands in main's order. `rowIds` are the list's
 * rows top to bottom (without the dragged tab); main's order still holds it,
 * so the target is the index of the row it lands before, adjusted for its
 * own old position.
 */
export function manualMoveIndex(order: readonly string[], dragged: string, rowIds: readonly string[], index: number): number {
  const without = order.filter((id) => id !== dragged)
  const before = rowIds.filter((id) => id !== dragged)[index]
  if (before === undefined) {
    const last = rowIds.filter((id) => id !== dragged).at(-1)
    return last === undefined ? without.length : without.indexOf(last) + 1
  }
  return Math.max(0, without.indexOf(before))
}

/** Moves `id` to `index` in a list of ids (the Chats section's manual order). */
export function moveId(ids: readonly string[], id: string, index: number): string[] {
  const without = ids.filter((x) => x !== id)
  without.splice(Math.max(0, Math.min(index, without.length)), 0, id)
  return without
}

/** The time until the soonest enabled routine runs, or null. */
export function nextRoutineRun(routines: ReadonlyArray<{ enabled: boolean; nextRunAt: number | null }>): number | null {
  let soonest: number | null = null
  for (const r of routines) {
    if (!r.enabled || r.nextRunAt === null) continue
    if (soonest === null || r.nextRunAt < soonest) soonest = r.nextRunAt
  }
  return soonest
}
