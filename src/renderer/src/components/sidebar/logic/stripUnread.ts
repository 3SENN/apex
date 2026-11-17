/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummary } from '@shared/chats'
import type { TabInfo } from '@shared/ipc'
import { chatIdOfUrl } from './order'

// SH-21: the strip's unread mark, the same signal the sidebar rows show. A
// tab is unread when a companion finished work in it while you were
// elsewhere, or when it shows a chat whose results you haven't read. Looking
// at the tab clears it.

export interface FinishedState {
  /** The chat driving each tab, while one does. */
  owners: ReadonlyMap<string, string>
  /** Tabs whose companion finished while they were in the background. */
  finished: ReadonlySet<string>
}

export const NO_FINISHED: FinishedState = { owners: new Map(), finished: new Set() }

type TabFields = Pick<TabInfo, 'id' | 'url' | 'agentChatId'>
type ChatFields = Pick<ChatSummary, 'id' | 'status' | 'unread'>

/** The next state after a tabs or chats update; `state` is returned as is when nothing changed. */
export function stepFinished(state: FinishedState, tabs: readonly TabFields[], activeId: string | null, chats: readonly ChatFields[] | null): FinishedState {
  const owners = new Map<string, string>()
  const done: string[] = []
  for (const tab of tabs) {
    const before = state.owners.get(tab.id)
    if (tab.agentChatId) owners.set(tab.id, tab.agentChatId)
    else if (before) {
      // The run let go of the tab: finished, unless it failed or you are looking at it.
      const chat = chats?.find((c) => c.id === before)
      if (tab.id !== activeId && chat?.status !== 'error') done.push(tab.id)
    }
  }
  const open = new Set(tabs.map((t) => t.id))
  const finished = new Set([...state.finished, ...done].filter((id) => open.has(id) && id !== activeId))
  const sameOwners = owners.size === state.owners.size && [...owners].every(([tab, chat]) => state.owners.get(tab) === chat)
  const sameFinished = finished.size === state.finished.size && [...finished].every((id) => state.finished.has(id))
  if (sameOwners && sameFinished) return state
  return { owners: sameOwners ? state.owners : owners, finished: sameFinished ? state.finished : finished }
}

/** The tabs that show the unread mark: finished in the background, or a chat page with unread results. */
export function unreadTabIds(tabs: readonly TabFields[], activeId: string | null, chats: readonly ChatFields[] | null, finished: ReadonlySet<string>): Set<string> {
  const unreadChats = new Set((chats ?? []).filter((c) => c.unread).map((c) => c.id))
  const out = new Set<string>()
  for (const tab of tabs) {
    if (tab.id === activeId) continue
    const chatId = chatIdOfUrl(tab.url)
    if (finished.has(tab.id) || (chatId !== null && unreadChats.has(chatId))) out.add(tab.id)
  }
  return out
}
