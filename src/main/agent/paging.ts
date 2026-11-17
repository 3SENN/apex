/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AgentEvent } from '@shared/ipc'

// CH-13: long chats load their newest events first and page back from there.
// A page starts at one of your messages where it can, so a reply is never
// split between two pages.

/** Chats with up to this many log events load whole. */
export const VIEW_PAGE = 400
export const OLDER_PAGE = 200

/** Where a page of at most `limit` events that ends before `end` starts, snapped back to a message of yours. */
export function pageStart(log: readonly AgentEvent[], end: number, limit: number): number {
  const stop = Math.max(0, Math.min(end, log.length))
  const raw = Math.max(0, stop - limit)
  if (raw === 0) return 0
  // Snap back to the nearest message you sent, within one more page; else take the raw cut.
  for (let i = raw; i >= Math.max(0, raw - limit); i--) {
    if (log[i]?.type === 'user-message') return i
  }
  return raw
}

/** The newest page of a log for the chat view. */
export function newestPage(log: readonly AgentEvent[], limit = VIEW_PAGE): { events: AgentEvent[]; start: number } {
  if (log.length <= limit) return { events: log.slice(), start: 0 }
  const start = pageStart(log, log.length, limit)
  return { events: log.slice(start), start }
}

/** The page before index `before` (chats.older). */
export function olderPage(log: readonly AgentEvent[], before: number, limit = OLDER_PAGE): { events: AgentEvent[]; hasOlder: boolean; start: number } {
  const end = Math.max(0, Math.min(before, log.length))
  const start = pageStart(log, end, limit)
  return { events: log.slice(start, end), hasOlder: start > 0, start }
}
