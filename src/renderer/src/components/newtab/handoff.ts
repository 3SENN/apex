/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The new tab's ask field hands off to the chat composer as a shared
// element (DS-74): on send the new tab notes where its field was, and the
// chat page that replaces it in the same tab glides its composer from there.
// A note older than a moment is ignored, so a later chat page never jumps.

export interface AskOrigin {
  tabId: string
  /** Viewport rectangle of the field when it was sent. */
  rect: { left: number; top: number; width: number; height: number }
  /** DS-73: the standing figure, which flies into the first reply's face once the chat opens. */
  figure: { rect: { left: number; top: number; width: number; height: number }; image: string | null } | null
  at: number
}

const FRESH_MS = 2500
let origin: AskOrigin | null = null

const plain = (r: { left: number; top: number; width: number; height: number }): AskOrigin['rect'] => ({ left: r.left, top: r.top, width: r.width, height: r.height })

export function noteAskOrigin(tabId: string, rect: DOMRect, figure?: { rect: DOMRect; image: string | null } | null): void {
  const standing = figure && figure.rect.width > 0 ? { rect: plain(figure.rect), image: figure.image } : null
  origin = { tabId, rect: plain(rect), figure: standing, at: Date.now() }
}

/** The field the chat composer in `tabId` should glide from, once; null when there is none or it is stale. */
export function takeAskOrigin(tabId: string, now = Date.now()): AskOrigin['rect'] | null {
  return takeAskHandoff(tabId, now)?.rect ?? null
}

/** The whole note (the field and the standing figure), once; null when there is none or it is stale. */
export function takeAskHandoff(tabId: string, now = Date.now()): Pick<AskOrigin, 'rect' | 'figure'> | null {
  const note = origin
  if (!note || note.tabId !== tabId) return null
  origin = null
  return now - note.at <= FRESH_MS ? { rect: note.rect, figure: note.figure } : null
}
