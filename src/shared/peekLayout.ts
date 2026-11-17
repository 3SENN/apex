/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where Peek's card goes (SH-43). Main places the peeked page's native
// view with this, and the peek-frame surface draws the card, its header and
// the backdrop with the same numbers, so the two always line up.
import type { Bounds } from './ipc'

export const PEEK_HEADER_PX = 44
export const PEEK_CARD_MAX_WIDTH = 1180
export const PEEK_RADIUS_PX = 12

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))

/** The card and the page inside it, in CSS px of a window (or overlay) `viewport` wide and tall. */
export function peekLayout(viewport: { width: number; height: number }): { card: Bounds; page: Bounds } {
  const vw = Math.max(0, viewport.width)
  const vh = Math.max(0, viewport.height)
  const marginX = Math.round(clamp(vw * 0.06, 16, 96))
  const top = Math.round(clamp(vh * 0.06, 16, 64))
  const bottom = Math.round(clamp(vh * 0.04, 12, 32))
  const width = Math.max(0, Math.min(PEEK_CARD_MAX_WIDTH, vw - 2 * marginX))
  const height = Math.max(PEEK_HEADER_PX, vh - top - bottom)
  const x = Math.round((vw - width) / 2)
  const card = { x, y: top, width: Math.round(width), height: Math.round(height) }
  return { card, page: { x, y: top + PEEK_HEADER_PX, width: card.width, height: Math.max(0, card.height - PEEK_HEADER_PX) } }
}

/** What the header shows at rest: the host and path, with a lock for https. */
export function peekHeaderParts(url: string): { host: string; path: string; secure: boolean; kind: 'web' | 'file' | 'other' } {
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return { host: decodeURIComponent(u.pathname.split('/').pop() || u.pathname), path: '', secure: false, kind: 'file' }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { host: url, path: '', secure: false, kind: 'other' }
    const path = `${u.pathname === '/' ? '' : u.pathname}${u.search}`
    return { host: u.hostname.replace(/^www\./, ''), path, secure: u.protocol === 'https:', kind: 'web' }
  } catch {
    return { host: url, path: '', secure: false, kind: 'other' }
  }
}
