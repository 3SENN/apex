/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Text and links dropped from pages or other apps: onto a
// tab it loads there, onto the list it opens a new tab at that place. A
// dropped address opens; any other text is searched. Pure, so it is tested.
import { omniboxToUrl, type EngineRef } from '@shared/url'

/** Our own row drags carry this type; they are moves, not drops of text. */
export const ENTRY_MIME = 'application/x-atelier-entry'

/** Whether a drag carries something a tab can open (and isn't one of our own rows). */
export function hasDroppable(types: readonly string[]): boolean {
  if (types.includes(ENTRY_MIME)) return false
  return types.includes('text/uri-list') || types.includes('text/plain')
}

/** The first address in a text/uri-list (comments start with #). */
export function firstUri(list: string): string | null {
  for (const line of list.split(/\r?\n/)) {
    const s = line.trim()
    if (s && !s.startsWith('#')) return s
  }
  return null
}

/** What was dropped, trimmed and capped; null when there's nothing usable. */
export function droppedText(get: (type: string) => string): string | null {
  const uri = firstUri(get('text/uri-list') || '')
  const text = (uri ?? get('text/plain') ?? '').trim().slice(0, 8192)
  return text || null
}

/**
 * Where a drop goes: an address loads as typed, anything else is searched.
 * Schemes a page can't open from a drop (javascript:, file:, data:) are searched as text.
 */
export function dropUrl(text: string, engine: EngineRef): string | null {
  const s = text.trim()
  if (!s) return null
  if (/^(javascript|data|file|vbscript|blob):/i.test(s)) return omniboxToUrl(` ${s}`, engine)
  return omniboxToUrl(s, engine)
}

/** Whether a drag event's pointer is inside a zone's box (0, 0 is where Chromium puts a pointer that left the window). */
export function pointInside(r: { left: number; top: number; right: number; bottom: number }, x: number, y: number): boolean {
  if (x === 0 && y === 0) return false
  return x > r.left && x < r.right && y > r.top && y < r.bottom
}
