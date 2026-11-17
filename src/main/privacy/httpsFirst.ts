/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parse } from 'tldts'
import { isCertificateError } from '@shared/safety'

// HTTPS-First (privacy pack, Settings › Privacy). A tab's top-level http://
// navigation is sent to https:// first; when the secure version fails (no
// TLS on the host, a bad certificate, a refused or reset connection, or an
// https answer that redirects straight back to http), the tab shows Apex's
// "This site doesn't support a secure connection" page at the http address,
// with Continue to site (a remembered per-site exception) and Go back. The
// machine itself, the local network and names with no public suffix are
// never upgraded, and neither are explicit ports other than 80. Pure: the
// mux layer and the tab wiring live in ./feature.ts.

/** A host as the exception list keys it: lower case, no brackets or trailing dot. */
export function hostKey(host: string): string {
  return host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

/**
 * Hosts HTTPS-First leaves alone: localhost and *.localhost, IP literals,
 * *.local and *.home.arpa, single-label intranet names, and names under a
 * suffix nobody can register (.test, .lan, .internal), which only a local
 * resolver answers. The smoke fixture server is on 127.0.0.1, so it is never
 * upgraded either.
 */
export function isExemptHost(host: string): boolean {
  const h = hostKey(host)
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h === 'home.arpa' || h.endsWith('.home.arpa')) return true
  if (!h.includes('.')) return true
  const info = parse(h)
  if (info.isIp) return true
  return info.isIcann !== true && info.isPrivate !== true
}

/** The https address to try for a top-level http one, or null to load it as it is. */
export function upgradeTarget(url: string, enabled: boolean, isAllowed: (host: string) => boolean): string | null {
  if (!enabled) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'http:') return null
  // URL drops :80, so any port left is a server that chose it (dev servers): https rarely answers there.
  if (u.port !== '') return null
  const host = hostKey(u.hostname)
  if (isExemptHost(host) || isAllowed(host)) return null
  u.protocol = 'https:'
  return u.href
}

/**
 * The http address to fall back to when the address bar sent a typed bare
 * host (no scheme) to https, or null. Only portless, upgradable hosts: the
 * same ones an http:// address would be upgraded from.
 */
export function typedFallback(input: string, url: string): string | null {
  const text = input.trim()
  if (text === '' || /\s/.test(text) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.port !== '' || isExemptHost(u.hostname)) return null
  u.protocol = 'http:'
  return u.href
}

/** Failures that say nothing about the site's https: the person stopped, or the network itself is down. */
const NOT_THE_SITE = new Set([-3, -21, -105, -106, -109, -130, -137, -138])

/**
 * Whether a failed upgraded load means the site has no working https: a
 * certificate error, a TLS or connection failure (-100 to -199 apart from
 * the network being down), a timeout, an empty answer or a redirect loop. A
 * name that does not resolve fails over http too, so it keeps its own page.
 */
export function isUpgradeFailure(code: number): boolean {
  if (code === 0 || NOT_THE_SITE.has(code)) return false
  if (isCertificateError(code)) return true
  if (code <= -100 && code > -200) return true
  return code === -7 || code === -15 || code === -310 || code === -324
}

interface Pending {
  httpUrl: string
  httpsUrl: string
  host: string
  /** The https answer redirected back to http on the same host. */
  downgraded: boolean
  /** A typed bare host the address bar sent to https, not an http:// address Apex upgraded. */
  typed?: boolean
}

export type UpgradeDecision = { redirectURL: string } | { cancel: true } | null

export interface UpgradeOptions {
  enabled: boolean
  isAllowed(host: string): boolean
}

/**
 * Upgrades in flight, per tab (webContents id). One navigation at a time per
 * tab: a new top-level navigation clears the last one's state, a commit or a
 * failure ends it. After a failure, reloading the failed https address is
 * treated as the same upgrade, so ⌘R on the page shows it again.
 */
export class HttpsUpgrades {
  readonly #pending = new Map<number, Pending>()
  readonly #failed = new Map<number, Pending>()
  readonly #upgraded = new Map<number, string>()
  readonly #typed = new Map<number, Pending>()

  /**
   * The address bar is about to load a typed bare host over https: when that
   * load fails the way a failed upgrade does, the tab offers the http
   * address on the same page. A host with a remembered Continue goes
   * straight to http.
   */
  typed(webContentsId: number, input: string, url: string): void {
    const httpUrl = typedFallback(input, url)
    if (httpUrl) this.#typed.set(webContentsId, { httpUrl, httpsUrl: url, host: hostOf(url), downgraded: false, typed: true })
    else this.#typed.delete(webContentsId)
  }

  /** A tab's top-level request: where to send it instead, a refusal when an upgrade bounced back to http, or null. */
  beforeRequest(webContentsId: number, url: string, opts: UpgradeOptions): UpgradeDecision {
    const pending = this.#pending.get(webContentsId)
    if (pending?.downgraded && /^http:/i.test(url) && hostOf(url) === pending.host) return { cancel: true }
    const typed = this.#typed.get(webContentsId)
    if (typed) {
      this.#typed.delete(webContentsId)
      if (opts.enabled && url === typed.httpsUrl) {
        if (opts.isAllowed(typed.host)) return { redirectURL: typed.httpUrl }
        this.#pending.set(webContentsId, typed)
        return null
      }
    }
    const failed = this.#failed.get(webContentsId)
    if (failed && url === failed.httpsUrl) {
      this.#pending.set(webContentsId, { ...failed, downgraded: false })
      return null
    }
    const target = upgradeTarget(url, opts.enabled, (h) => opts.isAllowed(h))
    if (!target) return null
    this.#pending.set(webContentsId, { httpUrl: url, httpsUrl: target, host: hostOf(url), downgraded: false })
    return { redirectURL: target }
  }

  /** A new top-level navigation started (before its request): whatever the last one left is over. A stopped load fires no failure, so this is what clears it. */
  started(webContentsId: number): void {
    this.#pending.delete(webContentsId)
  }

  /** A top-level response: an https redirect back to http on the upgraded host fails the upgrade. */
  headersReceived(webContentsId: number, url: string, statusCode: number, location: string | null): void {
    const pending = this.#pending.get(webContentsId)
    if (!pending || statusCode < 300 || statusCode >= 400 || !location || !/^https:/i.test(url)) return
    let target: URL
    try {
      target = new URL(location, url)
    } catch {
      return
    }
    if (target.protocol === 'http:' && hostKey(target.hostname) === pending.host) pending.downgraded = true
  }

  /** The tab's top-level load failed: the http address to offer when it was a failed upgrade, else null. */
  failed(webContentsId: number, code: number): string | null {
    const pending = this.#pending.get(webContentsId)
    this.#pending.delete(webContentsId)
    if (!pending) return null
    const failedUpgrade = (pending.downgraded && (code === -20 || code === -27)) || isUpgradeFailure(code)
    if (!failedUpgrade) return null
    this.#failed.set(webContentsId, pending)
    return pending.httpUrl
  }

  /** A page committed: the upgrade (if any) worked when the page is the https one. */
  committed(webContentsId: number, url: string): void {
    const pending = this.#pending.get(webContentsId)
    this.#pending.delete(webContentsId)
    this.#failed.delete(webContentsId)
    if (pending && !pending.typed && /^https:/i.test(url) && hostOf(url) === pending.host) this.#upgraded.set(webContentsId, pending.host)
    else this.#upgraded.delete(webContentsId)
  }

  /** Whether the tab's current page was reached by upgrading its http address. */
  wasUpgraded(webContentsId: number, url: string): boolean {
    return this.#upgraded.get(webContentsId) === hostOf(url)
  }

  forget(webContentsId: number): void {
    this.#pending.delete(webContentsId)
    this.#failed.delete(webContentsId)
    this.#upgraded.delete(webContentsId)
    this.#typed.delete(webContentsId)
  }
}

function hostOf(url: string): string {
  try {
    return hostKey(new URL(url).hostname)
  } catch {
    return ''
  }
}

/** The app's tracker (feature.ts feeds it; sitesSafety asks it when a tab's load fails). */
export const httpsUpgrades = new HttpsUpgrades()
