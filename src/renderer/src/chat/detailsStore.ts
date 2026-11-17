/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import type { DetailsSectionId } from './logic/details'

// The details panel's state per window (DS-123): shown or hidden (remembered
// for the window in sessionStorage), which sections you collapsed, which
// chats already decided for themselves (so it opens by itself only once),
// and the sub-task docked in it per chat (CH-32).

const OPEN_KEY = 'apex.details.open'
const COLLAPSE_KEY = 'apex.details.collapsed'

interface DetailsStoreState {
  open: boolean
  collapsed: Partial<Record<DetailsSectionId, boolean>>
  decided: ReadonlySet<string>
  docked: Readonly<Record<string, string | null>>
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be unavailable; the panel still works for this session.
  }
}

let state: DetailsStoreState = {
  open: read<boolean>(OPEN_KEY, false),
  collapsed: read<Partial<Record<DetailsSectionId, boolean>>>(COLLAPSE_KEY, {}),
  decided: new Set(),
  docked: {},
}
const listeners = new Set<() => void>()

function set(patch: Partial<DetailsStoreState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDetailsStore(): DetailsStoreState {
  return useSyncExternalStore(subscribe, () => state)
}

/** Shows or hides the panel; the chat counts as decided, so it never opens by itself afterwards. */
export function setDetailsOpen(open: boolean, chatId?: string): void {
  write(OPEN_KEY, open)
  set({ open, ...(chatId ? { decided: new Set([...state.decided, chatId]) } : {}) })
}

/** CH-35: the first plan or produced file opens it once per chat. */
export function autoOpenDetails(chatId: string): void {
  if (state.decided.has(chatId)) return
  set({ open: true, decided: new Set([...state.decided, chatId]) })
}

export function markDetailsDecided(chatId: string): void {
  if (!state.decided.has(chatId)) set({ decided: new Set([...state.decided, chatId]) })
}

export function setSectionCollapsed(id: DetailsSectionId, collapsed: boolean): void {
  const next = { ...state.collapsed, [id]: collapsed }
  write(COLLAPSE_KEY, next)
  set({ collapsed: next })
}

/** CH-32: docks a sub-task in the parent's details panel (null undocks), opening the panel. */
export function dockSubtask(parentChatId: string, childChatId: string | null): void {
  set({ docked: { ...state.docked, [parentChatId]: childChatId }, ...(childChatId ? { open: true } : {}) })
  if (childChatId) write(OPEN_KEY, true)
}
