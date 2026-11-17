/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails, Session } from 'electron'
import { HIGH_ENTROPY_HINTS, highEntropyHint, lowEntropyHints, type BrowserIdentity, type HighEntropyHint } from './userAgent'
import { webRequestHooks, type WebRequestHooks } from './webRequest'

// User-Agent Client Hints on the wire (sign-in compatibility). Chromium's
// renderer adds Sec-CH-UA to a page's own fetches, but Electron has no client
// hints delegate, so navigations, frames and workers go out without them and
// Accept-CH is never honoured. Stock Chromium sends the three low-entropy
// hints on every request to a secure origin and, once an origin asks with
// Accept-CH on a top-level page, the high-entropy ones it named on that
// origin's own requests. This layer does exactly that, per session (so
// profiles and private windows keep their own Accept-CH answers, in memory),
// with the values navigator.userAgentData reports (userAgent.ts).

const HIGH = new Set<string>(HIGH_ENTROPY_HINTS)

/** https, or http on this machine (Chromium's potentially trustworthy origins). */
export function isTrustworthy(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  if (u.protocol !== 'http:') return false
  const host = u.hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '::1'
}

const originOf = (url: string): string | null => {
  try {
    const o = new URL(url).origin
    return o === 'null' ? null : o
  } catch {
    return null
  }
}

/** The hint names in an Accept-CH value, lowercased, high-entropy UA hints only. */
export function parseAcceptCh(values: readonly string[]): HighEntropyHint[] {
  const out: HighEntropyHint[] = []
  for (const value of values) {
    for (const raw of value.split(',')) {
      const name = raw.trim().toLowerCase()
      if (HIGH.has(name) && !out.includes(name as HighEntropyHint)) out.push(name as HighEntropyHint)
    }
  }
  return out
}

const headerValues = (headers: Record<string, string[] | string> | undefined, name: string): string[] | null => {
  if (!headers) return null
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return Array.isArray(v) ? v : [v]
  return null
}

export interface ClientHintsDeps {
  identity(): BrowserIdentity
  /** The top-level page's URL for a request (null for workers). */
  topUrl(d: { webContents?: Electron.WebContents; resourceType: string; url: string }): string | null
  /** Requests that present another browser (sign-in compatibility, signInIdentity.ts): no hints, and their Accept-CH goes unanswered. */
  exempt?(d: { webContents?: Electron.WebContents; resourceType: string; url: string }): boolean
}

/** One session's layer: Accept-CH answers by origin, and the hints each request should carry. */
export function clientHintsLayer(deps: ClientHintsDeps): WebRequestHooks & { accepted(origin: string): HighEntropyHint[] } {
  const accepted = new Map<string, HighEntropyHint[]>()
  return {
    accepted: (origin) => accepted.get(origin) ?? [],
    onHeadersReceived(d: OnHeadersReceivedListenerDetails) {
      // Only a top-level page's own answer counts, as in Chromium.
      if (d.resourceType !== 'mainFrame' || !isTrustworthy(d.url) || deps.exempt?.(d)) return null
      const values = headerValues(d.responseHeaders, 'accept-ch')
      const origin = originOf(d.url)
      if (values && origin) accepted.set(origin, parseAcceptCh(values))
      return null
    },
    onBeforeSendHeaders(d: OnBeforeSendHeadersListenerDetails) {
      if (d.resourceType === 'webSocket' || !isTrustworthy(d.url) || deps.exempt?.(d)) return null
      const id = deps.identity()
      const present = new Set(Object.keys(d.requestHeaders).map((k) => k.toLowerCase()))
      const add: Record<string, string> = {}
      for (const [name, value] of Object.entries(lowEntropyHints(id))) if (!present.has(name)) add[name] = value
      const origin = originOf(d.url)
      const wanted = origin ? accepted.get(origin) : undefined
      if (wanted?.length) {
        // The origin's own requests: its page, or anything it loads from itself (workers have no page).
        const top = deps.topUrl(d)
        const firstParty = d.resourceType === 'mainFrame' || top === null || originOf(top) === origin
        if (firstParty) {
          for (const hint of wanted) {
            if (present.has(hint)) continue
            const value = highEntropyHint(hint, id)
            if (value !== null) add[hint] = value
          }
        }
      }
      return Object.keys(add).length ? { requestHeaders: { ...d.requestHeaders, ...add } } : null
    },
  }
}

/** Adds the layer to a browsing session's webRequest mux. */
export function installClientHints(session: Session, deps: ClientHintsDeps): () => void {
  return webRequestHooks.add(clientHintsLayer(deps), { sessions: [session] })
}
