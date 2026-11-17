/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the compact address pill shows for a URL. Pure, so it is unit-tested.
import { BRAND_NAME } from '@shared/branding'
import { describeHost } from '@shared/domains'
import type { LoadStage } from '@shared/tabs'
import { isBlankUrl, isInsecureUrl, isInternalUrl } from '@shared/url'

export type PillKind = 'web' | 'apex' | 'blank' | 'other'

export interface PillParts {
  kind: PillKind
  /** The host without www, shortened in the middle when long. */
  host: string
  /** The page title after a slash, when the URL has a path, query or fragment. */
  detail: string | null
  /** Plain http, except on this machine. */
  insecure: boolean
  /** Apex pages: "Chat", "<title>". */
  crumbs: string[] | null
  /** The host mixes scripts or looks like a popular domain: it shows as punycode, in the warning tone. */
  lookalike: boolean
}

export const HOST_MAX = 32

/** Shortens long text in the middle: "very-long-sub…example.com". */
export function middleEllipsis(text: string, max: number): string {
  if (text.length <= max || max < 5) return text
  const keep = max - 1
  const tail = Math.ceil(keep / 2)
  return `${text.slice(0, keep - tail)}…${text.slice(text.length - tail)}`
}

/** The host as people read it: lowercase, without a leading www. */
export function displayHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}

/** True when the URL has more than its origin: a path, query or fragment. */
export function hasDetail(url: URL): boolean {
  return (url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== ''
}

export function pillParts(url: string, title: string, crumbs: string[] | null): PillParts {
  if (isBlankUrl(url)) return { kind: 'blank', host: '', detail: null, insecure: false, crumbs: null, lookalike: false }
  if (isInternalUrl(url)) return { kind: 'apex', host: '', detail: null, insecure: false, crumbs: crumbs && crumbs.length ? crumbs : [BRAND_NAME], lookalike: false }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { kind: 'other', host: url, detail: null, insecure: false, crumbs: null, lookalike: false }
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    return { kind: 'other', host: url, detail: null, insecure: false, crumbs: null, lookalike: false }
  }
  // Unicode only when it is safe to read; punycode when a label mixes scripts or imitates a popular domain.
  const shown = describeHost(parsed.hostname)
  const host = middleEllipsis(shown.display || displayHost(parsed.hostname), HOST_MAX)
  const cleanTitle = title.trim()
  // A title that only repeats the address adds nothing.
  const detail = hasDetail(parsed) && cleanTitle && cleanTitle !== url && cleanTitle !== parsed.hostname ? cleanTitle : null
  return { kind: 'web', host, detail, insecure: isInsecureUrl(url), crumbs: null, lookalike: shown.lookalike }
}

/** After this long, a load that hasn't finished shows "Still loading" with Stop in the pill (SS-01). */
export const STILL_LOADING_MS = 8000

export function stillLoading(stage: LoadStage, startedAt: number | null, now: number): boolean {
  if (stage === 'idle' || stage === 'finished' || startedAt === null) return false
  return now - startedAt >= STILL_LOADING_MS
}

/** What a drop on the pill carries: the first link of a uri-list, else the plain text, trimmed to one line. */
export function droppedText(data: Pick<DataTransfer, 'getData'>): string {
  const list = data
    .getData('text/uri-list')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
  const text = list || data.getData('text/plain')
  return text.replace(/\s+/g, ' ').trim().slice(0, 2048)
}

/** The full address for the editor and the full-URL option: decoded where that is safe to read. */
export function fullAddress(url: string): string {
  if (isBlankUrl(url)) return ''
  try {
    const decoded = decodeURI(url)
    // Spaces, control and direction characters could disguise the address; keep those encoded.
    return /[\s\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/.test(decoded) ? url : decoded
  } catch {
    return url
  }
}

// ── bookmarks bar (SH-47) ──

/** Where a bookmark opens: here, or in a new tab behind or in front. */
export type Disposition = 'here' | 'background' | 'foreground'

export function dispositionFor(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): Disposition {
  const mod = e.metaKey || e.ctrlKey
  if (e.button === 1) return 'background'
  if (mod && e.shiftKey) return 'foreground'
  return mod ? 'background' : 'here'
}

/** How many leading items fit in `available` px when the overflow button needs room once any don't. */
export function fittingCount(widths: readonly number[], available: number, overflowWidth = 32): number {
  let used = 0
  for (let i = 0; i < widths.length; i++) {
    used += widths[i] ?? 0
    const rest = i < widths.length - 1 ? overflowWidth : 0
    if (used + rest > available) return i
  }
  return widths.length
}

/**
 * SH-47: how many bookmarks the bar shows and the widest any may be. The
 * longest titles shrink to a shared cap (no lower than `floor`) before an
 * item goes behind the overflow button; items narrower than the cap keep
 * their width. `widths` are natural widths, already within `ceiling`.
 */
export function barLayout(widths: readonly number[], available: number, { floor = 120, ceiling = 180, gap = 2, overflow = 32 } = {}): { count: number; cap: number } {
  const fits = (count: number, cap: number): boolean =>
    widths.slice(0, count).reduce((sum, w) => sum + Math.min(w, cap) + gap, 0) + (count < widths.length ? overflow : 0) <= available
  let count = widths.length
  while (count > 0 && !fits(count, floor)) count--
  if (fits(count, ceiling)) return { count, cap: ceiling }
  // The widest cap those items fit at, to the pixel.
  let lo = floor
  let hi = ceiling
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (fits(count, mid)) lo = mid
    else hi = mid
  }
  return { count, cap: lo }
}

/** DS-90: how far down the window the palette's top sits (about a quarter), and its floor in small windows. */
export const PALETTE_TOP_FRACTION = 0.25
export const PALETTE_TOP_MIN = 48

/**
 * DS-90: the window-sized anchor for the universal-search palette. Its top
 * edge is where the card's top sits ('top-center' placement with no gap), so
 * the palette is centred on the window about a quarter of the way down.
 */
export function paletteAnchor(viewport: { width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const width = Math.max(0, Math.round(viewport.width))
  const height = Math.max(0, Math.round(viewport.height))
  const y = Math.min(Math.max(PALETTE_TOP_MIN, Math.round(height * PALETTE_TOP_FRACTION)), Math.max(0, height - PALETTE_TOP_MIN))
  return { x: 0, y, width, height: Math.max(0, height - y) }
}
