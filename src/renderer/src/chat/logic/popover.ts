/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummary } from '@shared/chats'

// The chat-list popover from the panel header (CH-50): recent
// chats with search and filters, and a routine inbox. The filtering and the
// keyboard model are pure, so they are tested.

export type PopoverFilter = 'all' | 'unread' | 'needs-input' | 'routines'
export const POPOVER_FILTERS: readonly PopoverFilter[] = ['all', 'unread', 'needs-input', 'routines']

/** How many recent chats the list shows. */
export const POPOVER_LIMIT = 30

function matches(chat: ChatSummary, terms: readonly string[]): boolean {
  if (terms.length === 0) return true
  const title = chat.title.toLocaleLowerCase()
  return terms.every((t) => title.includes(t))
}

/** The rows for a query and filter: never archived, private or child chats; newest first, pinned on top. */
export function popoverRows(chats: readonly ChatSummary[], query: string, filter: PopoverFilter): ChatSummary[] {
  const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return chats
    .filter((c) => !c.archived && !c.private && c.parentChatId === null && !c.draft)
    .filter((c) => {
      switch (filter) {
        case 'unread':
          return c.unread
        case 'needs-input':
          return c.needsInput || c.status === 'needs-approval'
        case 'routines':
          return c.routineId !== null
        case 'all':
          return true
      }
    })
    .filter((c) => matches(c, terms))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastActiveAt - a.lastActiveAt)
    .slice(0, POPOVER_LIMIT)
}

/** The routine inbox: unread routine results and runs waiting for you, newest first. */
export function routineInbox(chats: readonly ChatSummary[]): ChatSummary[] {
  return chats
    .filter((c) => c.routineId !== null && !c.archived && (c.unread || c.needsInput || c.status === 'needs-approval'))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
}

export type PopoverState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'no-matches' }
  | { kind: 'rows' }

export function popoverState(input: { loaded: boolean; failed: boolean; all: number; rows: number }): PopoverState {
  if (input.failed) return { kind: 'error' }
  if (!input.loaded) return { kind: 'loading' }
  if (input.all === 0) return { kind: 'empty' }
  if (input.rows === 0) return { kind: 'no-matches' }
  return { kind: 'rows' }
}

export type PopoverKeyResult =
  | { type: 'move'; index: number }
  | { type: 'open'; index: number; newTab: boolean }
  | { type: 'filter'; filter: PopoverFilter }
  | { type: 'close' }
  | { type: 'clear-query' }
  | { type: 'none' }

/**
 * Keys in the popover's search field drive the list: ↑/↓ (and ⌃P/⌃N) move,
 * Enter opens (⌘Enter in a new tab), ⌥←/⌥→ switch filters, Esc clears the
 * query first and then closes.
 */
export function popoverKey(
  key: { key: string; meta?: boolean; ctrl?: boolean; alt?: boolean },
  state: { index: number; count: number; query: string; filter: PopoverFilter },
): PopoverKeyResult {
  const last = state.count - 1
  if (key.key === 'ArrowDown' || (key.ctrl && key.key === 'n')) return state.count === 0 ? { type: 'none' } : { type: 'move', index: Math.min(last, state.index + 1) }
  if (key.key === 'ArrowUp' || (key.ctrl && key.key === 'p')) return state.count === 0 ? { type: 'none' } : { type: 'move', index: Math.max(0, state.index - 1) }
  if (key.key === 'Home' && state.count > 0) return { type: 'move', index: 0 }
  if (key.key === 'End' && state.count > 0) return { type: 'move', index: last }
  if (key.key === 'Enter') return state.count === 0 || state.index < 0 ? { type: 'none' } : { type: 'open', index: state.index, newTab: key.meta === true || key.ctrl === true }
  if (key.alt && (key.key === 'ArrowRight' || key.key === 'ArrowLeft')) {
    const at = POPOVER_FILTERS.indexOf(state.filter)
    const next = POPOVER_FILTERS[(at + (key.key === 'ArrowRight' ? 1 : -1) + POPOVER_FILTERS.length) % POPOVER_FILTERS.length] ?? 'all'
    return { type: 'filter', filter: next }
  }
  if (key.key === 'Escape') return state.query ? { type: 'clear-query' } : { type: 'close' }
  return { type: 'none' }
}
