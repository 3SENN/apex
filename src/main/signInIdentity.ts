/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OnBeforeSendHeadersListenerDetails, Session, WebContents } from 'electron'
import { isFlagOn } from '@shared/flags'
import { overrideSignInIdentity, signInIdentityFor, type SignInIdentity } from '@shared/signInHosts'
import { browserUserAgent } from './userAgent'
import { webRequestHooks, type WebRequestHooks } from './webRequest'

// Sign-in compatibility mode (signInHosts.ts): on a provider's sign-in pages
// whose identity is 'firefox', the tab presents a current desktop Firefox
// instead of Chromium. No provider has it by default: Google presents Chrome
// (with the chrome surface, preload/chromeSurfaceWorld.ts), and Experiments'
// "Google sign-in: present as Firefox" (GOOGLE_FIREFOX_FLAG) switches Google
// here without a rebuild, should Google start refusing that. Everywhere else
// nothing changes.
//
// Two halves, because neither reaches everything alone:
// - Requests (signInIdentityLayer, in the webRequest mux): every request to a
//   'firefox' page, and every request a tab makes while its page is one, goes
//   out with Firefox's User-Agent and no client hints (Firefox sends none).
//   This is what puts Firefox on the very first request, on redirects into
//   the sign-in host and on a popup's first load: a tab's own override only
//   reaches the request after the one being made when it changes.
// - The page (watchSignInIdentity): webContents.setUserAgent while the tab is
//   on such a page, so navigator.userAgent says Firefox; set back to the
//   session's User-Agent the moment the tab heads anywhere else. The
//   requests half also turns a Firefox header left over from that back into
//   Chromium's, so the page after sign-in (Gmail, YouTube) is Chromium from its
//   first request on. Cookies are the session's, so sign-in carries over.

/** A recent stable Firefox major (Mozilla's release calendar); move it up every few releases. */
export const FIREFOX_MAJOR = 156

/** Firefox's frozen platform tokens: macOS stays 10.15 on Intel and Apple silicon alike. */
const FIREFOX_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'Macintosh; Intel Mac OS X 10.15',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
}

/** Desktop Firefox's User-Agent on a platform. */
export function firefoxUserAgent(platform: NodeJS.Platform = process.platform, major = FIREFOX_MAJOR): string {
  return `Mozilla/5.0 (${FIREFOX_PLATFORM[platform] ?? FIREFOX_PLATFORM.linux}; rv:${major}.0) Gecko/20100101 Firefox/${major}.0`
}

// ---- the experiment ----

/** atelier://flags: Google's sign-in pages present Firefox instead of Chrome. */
export const GOOGLE_FIREFOX_FLAG = 'google-signin-firefox'

/** Applies the identity experiments to the sign-in registry. */
export function applyIdentityExperiments(flags: Record<string, string>): void {
  overrideSignInIdentity('google', isFlagOn(flags, GOOGLE_FIREFOX_FLAG) ? 'firefox' : null)
}

interface FlagSettings {
  get(): { flags?: Record<string, string> }
  on(event: 'changed', listener: (next: { flags?: Record<string, string> }) => void): unknown
}

/** Keeps the registry on the experiments' values: now, and whenever they change (no restart). */
export function followIdentityExperiments(settings: FlagSettings): void {
  applyIdentityExperiments(settings.get().flags ?? {})
  settings.on('changed', (next) => applyIdentityExperiments(next.flags ?? {}))
}

// ---- requests ----

interface RequestLike {
  url: string
  resourceType: string
}

/**
 * The identity one request goes out with: Firefox for a request to a 'firefox'
 * sign-in page, and for anything a page on one loads (its scripts, frames and
 * fetches, wherever they go); Chromium for everything else. A main-frame
 * request is the page it loads, so only its own URL counts.
 */
export function requestIdentity(d: RequestLike, topUrl: string | null): SignInIdentity {
  if (signInIdentityFor(d.url) === 'firefox') return 'firefox'
  if (d.resourceType === 'mainFrame' || !topUrl) return 'chromium'
  return signInIdentityFor(topUrl)
}

type Headers = Record<string, string>

const CLIENT_HINT = /^sec-ch-/i

/**
 * The request headers for an identity, or null when they are right already.
 * Firefox: its User-Agent and no client hints at all. Chromium: untouched,
 * except a Firefox User-Agent a tab still carried from a sign-in page.
 */
export function identityHeaders(headers: Headers, identity: SignInIdentity, ua: { firefox: string; chromium: string }): Headers | null {
  const uaKey = Object.keys(headers).find((k) => k.toLowerCase() === 'user-agent')
  if (identity === 'chromium') {
    if (!uaKey || headers[uaKey] !== ua.firefox) return null
    return { ...headers, [uaKey]: ua.chromium }
  }
  let changed = !uaKey || headers[uaKey] !== ua.firefox
  const out: Headers = {}
  for (const [k, v] of Object.entries(headers)) {
    if (CLIENT_HINT.test(k)) changed = true
    else out[k] = v
  }
  out[uaKey ?? 'User-Agent'] = ua.firefox
  return changed ? out : null
}

export interface SignInIdentityDeps {
  /** The top-level page's URL for a request (null for workers). */
  topUrl(d: { webContents?: WebContents; resourceType: string; url: string }): string | null
  firefox?(): string
  chromium?(): string
}

/** True when a request goes out as Firefox (the client hints layer leaves those alone, Accept-CH included). */
export function isFirefoxRequest(d: { webContents?: WebContents; resourceType: string; url: string }, topUrl: SignInIdentityDeps['topUrl']): boolean {
  return requestIdentity(d, topUrl(d)) === 'firefox'
}

/** One session's layer; it runs after the client hints layer, so it sees (and removes) the hints. */
export function signInIdentityLayer(deps: SignInIdentityDeps): WebRequestHooks {
  const firefox = deps.firefox ?? (() => firefoxUserAgent())
  const chromium = deps.chromium ?? browserUserAgent
  return {
    onBeforeSendHeaders(d: OnBeforeSendHeadersListenerDetails) {
      const identity = requestIdentity(d, deps.topUrl(d))
      const headers = identityHeaders(d.requestHeaders, identity, { firefox: firefox(), chromium: chromium() })
      return headers ? { requestHeaders: headers } : null
    },
  }
}

/** Adds the layer to a browsing session's webRequest mux (after installClientHints). */
export function installSignInIdentity(session: Session, deps: SignInIdentityDeps): () => void {
  return webRequestHooks.add(signInIdentityLayer(deps), { sessions: [session] })
}

// ---- the page ----
//
// How Electron 45 behaves, measured (the smokeBrowser sign-in check holds it to this):
// - setUserAgent from inside did-start-navigation reaches the new page's
//   navigator (not its first request: the requests half covers that).
// - setUserAgent while a redirect is reported stalls the main process, and a
//   turn later it makes Chromium reload the page the tab is leaving. So a
//   redirect that crosses into or out of a 'firefox' page is cancelled at
//   will-redirect and loaded again as a navigation of its own; Set-Cookie on
//   the redirect is kept, and the referrer goes along.
// - A popup's own navigations never take the tab's override (Chromium only
//   applies it once a navigation the browser started has committed), so a
//   popup heading to such a page first is loaded again the same way, from the
//   start; window.opener stays. Either reload is a GET: a POST into Google
//   sign-in as a popup's very first page, or a 307 into it, would lose its body.

interface TabState {
  identity: SignInIdentity
  /** A navigation the browser started (loadURL, history) has run here: renderer navigations then take the override. */
  browserLoaded: boolean
}

const tabs = new WeakMap<WebContents, TabState>()

/** What a webContents presents right now (tests and diagnostics). */
export function tabIdentity(wc: WebContents): SignInIdentity {
  return tabs.get(wc)?.identity ?? 'chromium'
}

export interface WatchOptions {
  firefox?: string
}

interface NavigationDetails {
  url: string
  isMainFrame: boolean
  isSameDocument?: boolean
  initiator?: { url: string } | null
  preventDefault?(): void
}

const initiatorUrl = (d: NavigationDetails): string | null => {
  try {
    const url = d.initiator?.url ?? ''
    return /^https?:/i.test(url) ? url : null
  } catch {
    // The initiating frame is gone.
    return null
  }
}

/**
 * navigator.userAgent follows the page: Firefox from the start of a
 * navigation to a 'firefox' sign-in page, the session's User-Agent from the
 * start of one anywhere else. A navigation that never commits leaves the tab
 * on its page, and the identity goes back to that page's.
 */
export function watchSignInIdentity(wc: WebContents, opts: WatchOptions = {}): void {
  if (tabs.has(wc)) return
  const state: TabState = { identity: 'chromium', browserLoaded: false }
  tabs.set(wc, state)
  const set = (identity: SignInIdentity): void => {
    if (state.identity === identity || wc.isDestroyed()) return
    state.identity = identity
    try {
      // The session's own string: setting it back leaves the tab as it was (client hints included).
      wc.setUserAgent(identity === 'firefox' ? (opts.firefox ?? firefoxUserAgent()) : wc.session.getUserAgent())
    } catch {
      // The tab is going away.
    }
  }
  /** Loads the URL again as a browser navigation, where the override holds; the old one is dropped. */
  const reload = (url: string, referrer: string | null): void => {
    setImmediate(() => {
      if (wc.isDestroyed()) return
      const options = referrer ? { httpReferrer: { url: referrer, policy: 'strict-origin-when-cross-origin' as const } } : undefined
      void wc.loadURL(url, options).catch(() => undefined)
    })
  }
  wc.on('did-start-navigation', (details: NavigationDetails) => {
    if (!details.isMainFrame || details.isSameDocument) return
    if (!details.initiator) state.browserLoaded = true
    const identity = signInIdentityFor(details.url)
    if (identity === 'firefox' && !state.browserLoaded) {
      // A popup's first steps: started again by the browser, it switches when that one starts.
      reload(details.url, initiatorUrl(details))
      return
    }
    set(identity)
  })
  wc.on('will-redirect', (details: NavigationDetails) => {
    if (!details.isMainFrame || signInIdentityFor(details.url) === state.identity) return
    details.preventDefault?.()
    reload(details.url, initiatorUrl(details))
  })
  // Only once nothing loads: a change mid-load would have Chromium reload the page.
  wc.on('did-stop-loading', () => {
    if (!wc.isDestroyed() && !wc.isLoading()) set(signInIdentityFor(wc.getURL()))
  })
}
