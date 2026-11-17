/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { chatDateGroup, type ChatDateGroup, type ChatListFilter, type ChatSort, type ChatSummary } from '@shared/chats'
import type { AgentStatus } from '@shared/ipc'
import { t } from '@shared/i18n/core'

// Pure rules for chat lists: All chats grouping and filters, row badges and
// range selection.

export type ChatGroupId = 'pinned' | 'matches' | ChatDateGroup

export interface ChatGroup {
  id: ChatGroupId
  label: string
  items: ChatSummary[]
}

const GROUP_LABELS: Record<ChatGroupId, string> = {
  get pinned() { return t('chat.list.pinned') },
  get matches() { return t('chat.list.bestMatches') },
  get today() { return t('chat.list.today') },
  get yesterday() { return t('chat.list.yesterday') },
  get week() { return t('chat.list.previous7Days') },
  get month() { return t('chat.list.previous30Days') },
  get older() { return t('chat.list.older') },
}

/**
 * Groups a list that main already sorted: pinned chats on top, then by date
 * of last use (in list order, so oldest-first lists run oldest group first).
 * Best-match results stay in rank order under one heading.
 */
export function groupChats(items: readonly ChatSummary[], sort: ChatSort, now = Date.now()): ChatGroup[] {
  const groups: ChatGroup[] = []
  const add = (id: ChatGroupId, chat: ChatSummary): void => {
    let group = groups.find((g) => g.id === id)
    if (!group) {
      group = { id, label: GROUP_LABELS[id], items: [] }
      groups.push(group)
    }
    group.items.push(chat)
  }
  for (const chat of items) if (chat.pinned) add('pinned', chat)
  for (const chat of items) {
    if (chat.pinned) continue
    add(sort === 'best-match' ? 'matches' : chatDateGroup(chat.lastActiveAt, now), chat)
  }
  return groups
}

export interface ChatFilters {
  query: string
  companionId: string | null
  routine: 'all' | 'only' | 'exclude'
  status: 'any' | 'unread' | 'needs-input' | 'archived'
  sort: ChatSort
}

export const DEFAULT_FILTERS: ChatFilters = { query: '', companionId: null, routine: 'all', status: 'any', sort: 'recent' }

export function hasFilters(filters: ChatFilters): boolean {
  return filters.query.trim() !== '' || filters.companionId !== null || filters.routine !== 'all' || filters.status !== 'any'
}

/** The service filter for a page of results. Best match needs words to rank by. */
export function toListFilter(filters: ChatFilters, limit: number): ChatListFilter {
  const query = filters.query.trim().replace(/\s+/g, ' ')
  return {
    ...(query ? { query } : {}),
    ...(filters.companionId ? { companionId: filters.companionId } : {}),
    ...(filters.routine !== 'all' ? { routine: filters.routine } : {}),
    ...(filters.status !== 'any' ? { status: filters.status } : {}),
    sort: filters.sort === 'best-match' && !query ? 'recent' : filters.sort,
    limit,
  }
}

export type ChatBadge = { status: 'working' | 'needs-input' | 'error' | 'unread' | 'success'; label: string } | null

/** The one badge a chat row shows, most urgent first. `live` overrides the saved status while a view follows the chat. */
export function chatBadge(chat: Pick<ChatSummary, 'status' | 'unread' | 'needsInput'>, live?: AgentStatus): ChatBadge {
  if (live === 'awaiting-approval' || chat.status === 'needs-approval') return { status: 'needs-input', label: t('chat.list.needsYourApproval') }
  if (live === 'running' || chat.status === 'running') return { status: 'working', label: t('chat.list.working') }
  if (chat.needsInput) return { status: 'needs-input', label: t('chat.list.waitingForYourAnswer') }
  if (chat.status === 'error') return { status: 'error', label: t('chat.list.stoppedWithAnError') }
  if (chat.unread) return { status: 'unread', label: t('chat.list.newResult') }
  return null
}

/** The ids from `anchor` to `target` inclusive, in list order (⇧-click). */
export function rangeBetween(order: readonly string[], anchor: string, target: string): string[] {
  const a = order.indexOf(anchor)
  const b = order.indexOf(target)
  if (a === -1 || b === -1) return [target]
  return order.slice(Math.min(a, b), Math.max(a, b) + 1)
}

/** Drops selected ids that are no longer listed. */
export function pruneSelection(selected: ReadonlySet<string>, listed: readonly ChatSummary[]): Set<string> {
  const ids = new Set(listed.map((c) => c.id))
  return new Set([...selected].filter((id) => ids.has(id)))
}
