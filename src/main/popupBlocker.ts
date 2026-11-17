/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getDomain } from 'tldts'
import type { SiteToggle } from '@shared/sites'

// The pop-up and redirect blocker. Electron has no pop-up
// blocker of its own and window.open carries no gesture flag, so Apex keeps
// each tab's last real input (a click, key or tap) and treats it like
// Chromium's transient activation: it lasts a few seconds and one pop-up
// uses it up. A script pop-up without one is blocked unless the site is
// allowed, and the tab shows the popup-blocked notice with Allow once or
// Always for this site. The same input clock decides whether a cross-site
// frame that sends the whole tab elsewhere was asked to.

/** How long an input counts as a gesture (Chromium's transient activation). */
export const GESTURE_MS = 5000

export class GestureClock {
  readonly #last = new Map<number, number>()

  /** A real input reached the page. */
  note(webContentsId: number, at = Date.now()): void {
    this.#last.set(webContentsId, at)
  }

  had(webContentsId: number, now = Date.now()): boolean {
    const at = this.#last.get(webContentsId)
    return at !== undefined && now - at <= GESTURE_MS
  }

  /** Like had(), but the gesture is spent: one pop-up per click. */
  consume(webContentsId: number, now = Date.now()): boolean {
    const ok = this.had(webContentsId, now)
    if (ok) this.#last.delete(webContentsId)
    return ok
  }

  forget(webContentsId: number): void {
    this.#last.delete(webContentsId)
  }
}

/** The app's clock; popups.ts asks it for PopupRequest.userGesture. */
export const gestures = new GestureClock()

/** Input types that count as the person asking for something. */
export function isGestureInput(type: string): boolean {
  return type === 'mouseDown' || type === 'mouseUp' || type === 'keyDown' || type === 'rawKeyDown' || type === 'char' || type === 'gestureTap' || type === 'touchStart' || type === 'touchEnd'
}

/**
 * The popup policy's answer: a site set to allow always gets its pop-ups and
 * one set to block never does; otherwise, with blocking on, only a pop-up the
 * person asked for opens. null leaves the decision to the next policy.
 */
export function popupDecision(d: { blockingOn: boolean; siteRule: SiteToggle; userGesture: boolean }): 'allow' | 'block' | null {
  if (d.siteRule === 'allow') return 'allow'
  if (d.siteRule === 'block') return 'block'
  if (!d.blockingOn || d.userGesture) return null
  return 'block'
}

function siteOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return getDomain(host, { allowPrivateDomains: true }) ?? host
  } catch {
    return ''
  }
}

/**
 * A top-level navigation started by a frame is a blocked redirect when the
 * frame is cross-site to the page, it sends the tab to yet another site, and
 * nobody touched the page just before. Navigations the page itself starts
 * are never judged here.
 */
export function redirectBlocked(d: { pageUrl: string; frameUrl: string | null; targetUrl: string; frameIsTop: boolean; userGesture: boolean; siteRule: SiteToggle; blockingOn: boolean }): boolean {
  if (d.frameIsTop || !d.frameUrl || d.userGesture || d.siteRule === 'allow' || (!d.blockingOn && d.siteRule !== 'block')) return false
  const page = siteOf(d.pageUrl)
  const frame = siteOf(d.frameUrl)
  const target = siteOf(d.targetUrl)
  return page !== '' && frame !== page && target !== page
}

/** What a tab had blocked on its current page, for the notice and Allow once. */
export class BlockedOnPage {
  readonly #byTab = new Map<string, { urls: string[]; count: number }>()

  add(tabId: string, url: string): number {
    const entry = this.#byTab.get(tabId) ?? { urls: [], count: 0 }
    entry.count++
    // Keep the latest few: Allow once opens what the page tried last.
    entry.urls = [...entry.urls.filter((u) => u !== url), url].slice(-3)
    this.#byTab.set(tabId, entry)
    return entry.count
  }

  /** The pop-ups to open on Allow; the tab starts over. */
  take(tabId: string): string[] {
    const urls = this.#byTab.get(tabId)?.urls ?? []
    this.#byTab.delete(tabId)
    return urls
  }

  count(tabId: string): number {
    return this.#byTab.get(tabId)?.count ?? 0
  }

  clear(tabId: string): void {
    this.#byTab.delete(tabId)
  }
}

/**
 * Automatic downloads: with the site set to block, a page gets its
 * first download and later ones without a fresh gesture are cancelled.
 */
export function downloadBlocked(d: { siteRule: SiteToggle; downloadsThisPage: number; userGesture: boolean }): boolean {
  return d.siteRule === 'block' && d.downloadsThisPage >= 1 && !d.userGesture
}
