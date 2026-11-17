/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which chats the sidebar's Chats section shows. Open chats behave like tabs:
// you open and close them, and the full history stays in All chats. New
// chats (yours or a routine's) open by themselves, and a closed chat comes
// back when it has new activity, so a result never goes unnoticed.
import type { ChatSummary } from '@shared/chats'

export interface OpenChatsState {
  /** Open chat ids, top first: the manual order. */
  order: string[]
  /** Chat id to when you closed it; activity after that reopens it. */
  closed: Record<string, number>
  /** Chats created after this open by themselves. */
  since: number
  /** False until the first chat list arrived and seeded the section. */
  seeded: boolean
}

/** Chats the section starts with on first use: pinned ones plus a few recent ones. */
export const SEED_RECENT = 5
const MAX_OPEN = 200

export function initialOpenChats(now: number): OpenChatsState {
  return { order: [], closed: {}, since: now, seeded: false }
}

/** Validates what localStorage held; anything malformed starts fresh. */
export function parseOpenChats(raw: unknown, now: number): OpenChatsState {
  if (typeof raw !== 'object' || raw === null) return initialOpenChats(now)
  const value = raw as Record<string, unknown>
  const order = Array.isArray(value.order) ? value.order.filter((id): id is string => typeof id === 'string').slice(0, MAX_OPEN) : []
  const closed: Record<string, number> = {}
  if (typeof value.closed === 'object' && value.closed !== null) {
    for (const [id, at] of Object.entries(value.closed as Record<string, unknown>)) if (typeof at === 'number' && Number.isFinite(at)) closed[id] = at
  }
  const since = typeof value.since === 'number' && Number.isFinite(value.since) ? value.since : now
  return { order: [...new Set(order)], closed, since, seeded: value.seeded === true }
}

const showable = (chat: ChatSummary): boolean => !chat.archived && !chat.draft

/**
 * Folds a new chat list into the state: seeds the section once, opens chats
 * created since `since`, reopens closed chats with newer activity, and drops
 * chats that were deleted or archived.
 */
export function syncOpenChats(state: OpenChatsState, chats: readonly ChatSummary[]): OpenChatsState {
  const byId = new Map(chats.map((c) => [c.id, c]))
  let order = state.order.filter((id) => {
    const chat = byId.get(id)
    return chat !== undefined && showable(chat)
  })
  const closed: Record<string, number> = {}
  for (const [id, at] of Object.entries(state.closed)) if (byId.has(id)) closed[id] = at

  if (!state.seeded) {
    const live = chats.filter(showable)
    const seed = [...live.filter((c) => c.pinned), ...live.filter((c) => !c.pinned).slice(0, SEED_RECENT)]
    order = [...new Set([...order, ...seed.map((c) => c.id)])]
  }

  const open = new Set(order)
  const added: string[] = []
  for (const chat of chats) {
    if (!showable(chat) || open.has(chat.id)) continue
    const closedAt = closed[chat.id]
    if (closedAt !== undefined) {
      if (chat.lastActiveAt > closedAt) {
        delete closed[chat.id]
        added.push(chat.id)
      }
    } else if (chat.createdAt >= state.since) {
      added.push(chat.id)
    }
  }
  order = [...added, ...order].slice(0, MAX_OPEN)
  const changed = !state.seeded || added.length > 0 || order.length !== state.order.length || Object.keys(closed).length !== Object.keys(state.closed).length
  return changed ? { order, closed, since: state.since, seeded: true } : state
}

/** Opens a chat at the top (opening it from All chats, or as a page). */
export function openChat(state: OpenChatsState, id: string): OpenChatsState {
  if (state.order.includes(id) && !(id in state.closed)) return state
  const closed = { ...state.closed }
  delete closed[id]
  return { ...state, order: [id, ...state.order.filter((x) => x !== id)].slice(0, MAX_OPEN), closed }
}

/** Closes a chat row; it stays closed until the chat has activity after `now`. */
export function closeChat(state: OpenChatsState, id: string, lastActiveAt: number, now: number): OpenChatsState {
  return { ...state, order: state.order.filter((x) => x !== id), closed: { ...state.closed, [id]: Math.max(now, lastActiveAt) } }
}

/** Undo for the Chats header's Clear: the chats come back on top in the order they had, no longer closed. */
export function reopenChats(state: OpenChatsState, ids: readonly string[]): OpenChatsState {
  const back = new Set(ids)
  const closed = { ...state.closed }
  for (const id of ids) delete closed[id]
  return { ...state, order: [...ids, ...state.order.filter((x) => !back.has(x))].slice(0, MAX_OPEN), closed }
}

/** The manual order after dragging a chat to `index`. */
export function reorderChat(state: OpenChatsState, id: string, index: number): OpenChatsState {
  const without = state.order.filter((x) => x !== id)
  without.splice(Math.max(0, Math.min(index, without.length)), 0, id)
  return { ...state, order: without }
}
