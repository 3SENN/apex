/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isBlankUrl, isInternalUrl } from '@shared/url'

// DS-65 (CH-03): a chat expanded from the side panel takes over the tab it sat
// beside. The tab keeps its web page, which shows as the chat page's side
// pane, and the chrome draws the chat page in the rest of the tab. Split view
// is not involved. This is the window's record of which tab holds which chat:
// tab id to chat id, one tab per chat. Pure, so tests can drive it.

export type HeldChats = ReadonlyMap<string, string>

export const NO_HELD_CHATS: HeldChats = new Map()

/** The page pane's share of the tab's width, beside the chat. */
export const PAGE_SHARE = { min: 0.3, max: 0.7, default: 0.5 } as const

export function clampPageShare(value: number): number {
  if (!Number.isFinite(value)) return PAGE_SHARE.default
  return Math.min(PAGE_SHARE.max, Math.max(PAGE_SHARE.min, value))
}

/** A tab can hold a chat beside its page while it shows a website (not the new tab or an Atelier page). */
export function canHoldChat(url: string): boolean {
  return !isBlankUrl(url) && !isInternalUrl(url)
}

/** The chat a tab holds, or null. */
export function heldChatOf(held: HeldChats, tabId: string | null | undefined): string | null {
  return tabId ? (held.get(tabId) ?? null) : null
}

/** The tab holding a chat, or null. */
export function tabHolding(held: HeldChats, chatId: string): string | null {
  for (const [tabId, chat] of held) if (chat === chatId) return tabId
  return null
}

/** `tabId` holds `chatId`; any other tab that held it lets go, so a chat shows in one tab at a time. */
export function holdIn(held: HeldChats, tabId: string, chatId: string): HeldChats {
  if (held.get(tabId) === chatId && tabHolding(held, chatId) === tabId) return held
  const next = new Map([...held].filter(([tab, chat]) => tab !== tabId && chat !== chatId))
  next.set(tabId, chatId)
  return next
}

/** The tab shows only its page again. */
export function releaseTab(held: HeldChats, tabId: string): HeldChats {
  if (!held.has(tabId)) return held
  const next = new Map(held)
  next.delete(tabId)
  return next
}

/** Every tab holding a chat lets go of it (the chat was deleted, say). */
export function releaseChat(held: HeldChats, chatId: string): HeldChats {
  const tab = tabHolding(held, chatId)
  return tab ? releaseTab(held, tab) : held
}

/**
 * Drops holds whose tab closed, left the window, or went to the new tab or an
 * Atelier page. Returns `held` itself when nothing changed.
 */
export function pruneHeld(held: HeldChats, tabs: ReadonlyArray<{ id: string; url: string }>): HeldChats {
  if (held.size === 0) return held
  const urls = new Map(tabs.map((tab) => [tab.id, tab.url]))
  let next: Map<string, string> | null = null
  for (const tabId of held.keys()) {
    const url = urls.get(tabId)
    if (url !== undefined && canHoldChat(url)) continue
    next ??= new Map(held)
    next.delete(tabId)
  }
  return next ?? held
}

/** Session storage form: [[tabId, chatId], ...]. */
export function serializeHeld(held: HeldChats): string {
  return JSON.stringify([...held])
}

export function parseHeld(raw: string | null | undefined): HeldChats {
  if (!raw) return NO_HELD_CHATS
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return NO_HELD_CHATS
    let held: HeldChats = NO_HELD_CHATS
    for (const entry of value) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[0] && entry[1]) held = holdIn(held, entry[0], entry[1])
    }
    return held
  } catch {
    return NO_HELD_CHATS
  }
}

/** What expanding from the panel does with the active tab. */
export type ExpandPlan =
  | { kind: 'hold'; tabId: string }
  | { kind: 'navigate'; tabId: string }
  | { kind: 'open' }

/**
 * A website tab holds the chat beside its page; a new tab becomes the chat
 * page itself; an Atelier page (or a destination over the content) leaves the
 * chat to open in its own tab.
 */
export function planExpand(active: { id: string; url: string } | null | undefined, railShown: boolean): ExpandPlan {
  if (!active || railShown) return { kind: 'open' }
  if (canHoldChat(active.url)) return { kind: 'hold', tabId: active.id }
  if (isBlankUrl(active.url)) return { kind: 'navigate', tabId: active.id }
  return { kind: 'open' }
}
