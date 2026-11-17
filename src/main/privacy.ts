/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getDomain } from 'tldts'
import type { OnBeforeSendHeadersListenerDetails, OnHeadersReceivedListenerDetails } from 'electron'
import { isSignInUrl } from '@shared/signInHosts'
import type { SiteToggle } from '@shared/sites'
import type { WebRequestHooks } from './webRequest'

// Privacy: blocking third-party cookies and sending Global
// Privacy Control, as the mux's second layer, plus what clear-on-exit wipes.
// navigator.globalPrivacyControl is set in the page by preload/page/privacy.ts
// from PAGE.config.

export interface PrivacyConfig {
  blockThirdPartyCookies: boolean
  globalPrivacyControl: boolean
}

/** The page a request belongs to (the tab's top URL) and the cookie switch of an origin. */
export interface PrivacyContext {
  config(): PrivacyConfig
  /** The top-level page's URL for a request, or null when there is no page (service workers, downloads). */
  topUrl(details: { webContents?: Electron.WebContents; resourceType: string; url: string }): string | null
  cookieRule(origin: string): SiteToggle
}

function siteOf(url: string): string | null {
  try {
    const { protocol, hostname } = new URL(url)
    if (protocol !== 'http:' && protocol !== 'https:') return null
    const host = hostname.replace(/^\[|\]$/g, '')
    return getDomain(host, { allowPrivateDomains: true }) ?? host
  } catch {
    return null
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

/** A request is third-party when its registrable domain differs from the page's. */
export function isThirdParty(requestUrl: string, topUrl: string | null): boolean {
  if (!topUrl) return false
  const top = siteOf(topUrl)
  const req = siteOf(requestUrl)
  return top !== null && req !== null && top !== req
}

/**
 * Whether a request's cookies are stripped: a site blocked outright never gets
 * them; an allowed site (as the request's or the page's origin) keeps them;
 * otherwise third-party requests lose them while the switch is on, except a
 * sign-in provider's (signInHosts.ts): its embedded sign-in widgets and
 * silent token iframes (accounts.google.com, login.microsoftonline.com) need
 * their session, and so do a sign-in page's own cross-site requests.
 */
export function cookiesBlocked(requestUrl: string, topUrl: string | null, blockThirdParty: boolean, rule: (origin: string) => SiteToggle): boolean {
  const requestOrigin = originOf(requestUrl)
  const requestRule = requestOrigin ? rule(requestOrigin) : 'default'
  if (requestRule === 'block') return true
  if (requestRule === 'allow') return false
  if (!blockThirdParty || !isThirdParty(requestUrl, topUrl)) return false
  if (isSignInUrl(requestUrl) || (topUrl !== null && isSignInUrl(topUrl))) return false
  const topOrigin = topUrl ? originOf(topUrl) : null
  return !(topOrigin && rule(topOrigin) === 'allow')
}

function withoutHeader<T extends Record<string, string | string[]>>(headers: T, name: string): { headers: T; removed: boolean } {
  let removed = false
  const out = {} as Record<string, string | string[]>
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) removed = true
    else out[key] = value
  }
  return { headers: out as T, removed }
}

/**
 * Whether a request carries Sec-GPC: every request while the switch is on,
 * except on account sign-in pages (signInHosts.ts) and their own requests.
 * Those pages keep the engine's own world, so they get no
 * navigator.globalPrivacyControl either (preload/page.ts): the header and
 * the property always agree. The property is set in every other frame,
 * iframes included; workers send the header without the property.
 */
export function sendsGpc(requestUrl: string, topUrl: string | null, on: boolean): boolean {
  if (!on) return false
  return !isSignInUrl(requestUrl) && !(topUrl !== null && isSignInUrl(topUrl))
}

/** The mux's privacy layer: Sec-GPC on every request (sendsGpc), and cookies stripped both ways where blocked. */
export function privacyLayer(ctx: PrivacyContext): WebRequestHooks {
  return {
    onBeforeSendHeaders(d: OnBeforeSendHeadersListenerDetails) {
      const cfg = ctx.config()
      let headers = d.requestHeaders
      let changed = false
      if (sendsGpc(d.url, ctx.topUrl(d), cfg.globalPrivacyControl) && headers['Sec-GPC'] !== '1') {
        headers = { ...headers, 'Sec-GPC': '1' }
        changed = true
      }
      if (cookiesBlocked(d.url, ctx.topUrl(d), cfg.blockThirdPartyCookies, ctx.cookieRule)) {
        const stripped = withoutHeader(headers, 'cookie')
        if (stripped.removed) {
          headers = stripped.headers
          changed = true
        }
      }
      return changed ? { requestHeaders: headers } : null
    },
    onHeadersReceived(d: OnHeadersReceivedListenerDetails) {
      if (!d.responseHeaders) return null
      if (!cookiesBlocked(d.url, ctx.topUrl(d), ctx.config().blockThirdPartyCookies, ctx.cookieRule)) return null
      const stripped = withoutHeader(d.responseHeaders, 'set-cookie')
      return stripped.removed ? { responseHeaders: stripped.headers } : null
    },
  }
}

/** What clear-on-exit wipes, in the order it runs. */
export type ClearOnExit = { cookies: boolean; cache: boolean; history: boolean }

export interface ClearTargets {
  clearCookies(): Promise<void>
  clearCache(): Promise<void>
  clearHistory(): Promise<void>
}

/** Runs the chosen wipes; one failing doesn't stop the others. Resolves to what failed. */
export async function clearOnExit(what: ClearOnExit, targets: ClearTargets): Promise<string[]> {
  const failed: string[] = []
  const steps: [keyof ClearOnExit, () => Promise<void>][] = [
    ['cookies', targets.clearCookies],
    ['cache', targets.clearCache],
    ['history', targets.clearHistory],
  ]
  for (const [name, run] of steps) {
    if (!what[name]) continue
    try {
      await run()
    } catch {
      failed.push(name)
    }
  }
  return failed
}

export function wantsClearOnExit(what: ClearOnExit): boolean {
  return what.cookies || what.cache || what.history
}
