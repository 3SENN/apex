/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LogItem } from '../../agentLog'

// CH-13: apex://chat/<id>#<message> links. The fragment names one of your
// messages or a reply's turn; the chat scrolls to it and highlights it, loading
// older pages until it turns up. When it is gone, a notice offers the newest.

/** The message id in a chat link's fragment, or null. */
export function messageAnchor(url: string): string | null {
  const at = url.indexOf('#')
  if (at < 0) return null
  const raw = url.slice(at + 1).trim()
  if (!raw) return null
  try {
    const id = decodeURIComponent(raw)
    return /^[\w:.-]{1,200}$/.test(id) ? id : null
  } catch {
    return null
  }
}

/** Whether the loaded log holds the message: one of yours, or a reply turn. */
export function hasMessage(items: readonly LogItem[], id: string): boolean {
  return items.some((item) => (item.kind === 'user' || item.kind === 'assistant') && item.id === id)
}

export type AnchorStep = 'found' | 'load-older' | 'wait' | 'missing'

/** What to do next for an anchor: scroll to it, page back, wait for a page, or give up. */
export function anchorStep(input: { items: readonly LogItem[]; id: string; logStart: number; loading: boolean; failed: boolean }): AnchorStep {
  if (hasMessage(input.items, input.id)) return 'found'
  if (input.loading) return 'wait'
  if (input.logStart > 0 && !input.failed) return 'load-older'
  return 'missing'
}

/** How far down to scroll after older content was put above, so the reading position stays put. */
export function keepPosition(before: { scrollTop: number; scrollHeight: number }, afterHeight: number): number {
  return Math.max(0, before.scrollTop + (afterHeight - before.scrollHeight))
}

/** Close enough to the top that the next older page should load. */
export const OLDER_THRESHOLD = 120

export function nearTop(scrollTop: number): boolean {
  return scrollTop <= OLDER_THRESHOLD
}
