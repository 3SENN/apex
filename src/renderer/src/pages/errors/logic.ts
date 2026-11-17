/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// What each Atelier error page says and offers (SS-07).
// Pure, so the copy and the action order are unit-tested; the view
// renders whatever this returns.
import type { MessageKey } from '@shared/i18n/core'
import type { PageErrorKind } from '@shared/sites'

export type ErrorAction = 'retry' | 'reload' | 'search' | 'clear-cookies' | 'back' | 'back-to-safety' | 'allow-adblock' | /* privacy pack */ 'continue-insecure' | 'go-back'

/** neutral: a network hiccup; warning: Atelier stopped it on purpose; danger: going on could hurt. */
export type ErrorTone = 'neutral' | 'warning' | 'danger'

export interface ErrorCopy {
  title: MessageKey
  body: MessageKey
  tone: ErrorTone
  /** The big button. */
  primary: ErrorAction
  /** Quieter buttons beside it. */
  secondary: ErrorAction[]
  /** A details disclosure with the way past (Proceed or Visit anyway). */
  bypass: 'proceed' | 'visit' | null
}

export type ErrorView = PageErrorKind | 'crashed'

export function errorCopy(kind: ErrorView, canGoBack: boolean): ErrorCopy {
  const back: ErrorAction[] = canGoBack ? ['back'] : []
  switch (kind) {
    case 'offline':
      return { title: 'safety.error.offline.title', body: 'safety.error.offline.body', tone: 'neutral', primary: 'retry', secondary: back, bypass: null }
    case 'not-found':
      return { title: 'safety.error.notFound.title', body: 'safety.error.notFound.body', tone: 'neutral', primary: 'retry', secondary: ['search', ...back], bypass: null }
    case 'refused':
      return { title: 'safety.error.refused.title', body: 'safety.error.refused.body', tone: 'neutral', primary: 'retry', secondary: back, bypass: null }
    case 'timed-out':
      return { title: 'safety.error.timedOut.title', body: 'safety.error.timedOut.body', tone: 'neutral', primary: 'retry', secondary: back, bypass: null }
    case 'too-many-redirects':
      return { title: 'safety.error.redirects.title', body: 'safety.error.redirects.body', tone: 'neutral', primary: 'clear-cookies', secondary: ['retry', ...back], bypass: null }
    case 'blocked-by-adblock':
      return { title: 'safety.error.adblock.title', body: 'safety.error.adblock.body', tone: 'warning', primary: 'allow-adblock', secondary: back, bypass: null }
    case 'dangerous-site':
      return { title: 'safety.error.dangerous.title', body: 'safety.error.dangerous.body', tone: 'danger', primary: 'back-to-safety', secondary: [], bypass: 'visit' }
    case 'certificate':
      return { title: 'safety.error.certificate.title', body: 'safety.error.certificate.body', tone: 'danger', primary: 'back-to-safety', secondary: [], bypass: 'proceed' }
    case 'crashed':
      return { title: 'safety.error.crashed.title', body: 'safety.error.crashed.body', tone: 'neutral', primary: 'reload', secondary: back, bypass: null }
    // Privacy pack (HTTPS-First): the site has no working https; the address shown is the http one.
    case 'https-unavailable':
      return { title: 'privacyPack.https.error.title', body: 'privacyPack.https.error.body', tone: 'warning', primary: 'continue-insecure', secondary: ['go-back'], bypass: null }
    case 'other':
      return { title: 'safety.error.other.title', body: 'safety.error.other.body', tone: 'neutral', primary: 'retry', secondary: back, bypass: null }
  }
}

export const ACTION_LABEL: Record<ErrorAction, MessageKey> = {
  retry: 'safety.error.retry',
  reload: 'safety.error.reload',
  search: 'safety.error.search',
  'clear-cookies': 'safety.error.clearCookies',
  back: 'safety.error.back',
  'back-to-safety': 'safety.error.backToSafety',
  'allow-adblock': 'safety.error.allowAdblock',
  'continue-insecure': 'privacyPack.https.error.continue',
  'go-back': 'privacyPack.https.error.back',
}

/** The host to name, without www, falling back to the address itself. */
export function displayHostOf(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/** Seconds before the Connectors page checks again: quick at first, then every 30 s (SS-06). */
export function reconnectDelay(attempt: number): number {
  const steps = [5, 10, 20, 30]
  return steps[Math.min(Math.max(0, attempt), steps.length - 1)] ?? 30
}

/** A blocked pop-up or redirect target as the notice names it: host and a short path. */
export function noticeTarget(url: string, max = 48): string {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol.replace(/:$/, '')
    const host = u.hostname.replace(/^www\./, '')
    const path = u.pathname === '/' ? '' : u.pathname
    const text = host + path
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url
  }
}
