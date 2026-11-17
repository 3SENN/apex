/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WebContents } from 'electron'
import { isSignInUrl } from '@shared/signInHosts'

// A ref-counted Chrome DevTools Protocol session per webContents. Agent
// input, force dark, website languages and storage queries share
// one debugger attachment: the first acquire attaches, the last release
// detaches. An attachment someone else made first (DevTools, a test) is
// reused and never detached here. No holder enables the Runtime or Page
// domains, so a page can't tell a DevTools client is there.
//
// Two kinds of holder:
// - acquire(): a feature acting right now (the agent driving the tab, a
//   storage query). It holds until it releases.
// - hold(): a standing override that should last while the tab is open
//   (force dark, a custom website language list). It steps aside on account
//   sign-in pages (signInHosts.ts): when the tab heads to one the override is
//   cleared and, with no other holder, the debugger detaches before the page
//   loads; leaving the page attaches again and re-applies it.

interface Entry {
  count: number
  /** False when someone else attached first; then we never detach. */
  owned: boolean
}

interface Standing {
  apply(): Promise<unknown> | void
  clear?(): Promise<unknown> | void
  release: (() => void) | null
}

const entries = new WeakMap<WebContents, Entry>()
const standing = new WeakMap<WebContents, Set<Standing>>()
/** Tabs on a sign-in page: their standing holders are stepped aside. */
const paused = new WeakMap<WebContents, boolean>()

function acquire(wc: WebContents): () => void {
  let entry = entries.get(wc)
  if (!entry) {
    const owned = !wc.debugger.isAttached()
    if (owned) wc.debugger.attach('1.3')
    entry = { count: 0, owned }
    entries.set(wc, entry)
    wc.debugger.once('detach', () => entries.delete(wc))
  }
  entry.count++
  let released = false
  return () => {
    if (released) return
    released = true
    const current = entries.get(wc)
    if (!current || --current.count > 0) return
    entries.delete(wc)
    if (current.owned && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
  }
}

const quietly = (run: () => Promise<unknown> | void): void => {
  try {
    void Promise.resolve(run()).catch(() => undefined)
  } catch {
    // The page went away or the debugger is busy; the next navigation tries again.
  }
}

function engage(wc: WebContents, h: Standing): void {
  if (h.release || wc.isDestroyed()) return
  try {
    h.release = acquire(wc)
  } catch {
    h.release = null
    return
  }
  quietly(() => h.apply())
}

function disengage(wc: WebContents, h: Standing): void {
  const release = h.release
  if (!release) return
  h.release = null
  // Others keep the debugger attached: undo this override so the page doesn't carry it.
  if ((entries.get(wc)?.count ?? 0) > 1 && h.clear) quietly(() => h.clear?.())
  release()
}

function setPaused(wc: WebContents, next: boolean): void {
  if ((paused.get(wc) ?? false) === next) return
  paused.set(wc, next)
  for (const h of standing.get(wc) ?? []) {
    if (next) disengage(wc, h)
    else engage(wc, h)
  }
}

function watch(wc: WebContents, pendingUrl = ''): Set<Standing> {
  let set = standing.get(wc)
  if (set) return set
  set = new Set()
  standing.set(wc, set)
  // A new tab's first navigation may have started already: nothing is committed yet, so its URL decides.
  paused.set(wc, isSignInUrl(wc.getURL() || pendingUrl))
  // Main-frame navigations decide it before the new page's first request goes out. In-page ones count
  // too: some providers' sign-in is a route of their app (x.com/i/flow/login, signInHosts.ts).
  const onNavigation = (details: { url: string; isMainFrame: boolean }): void => {
    if (details.isMainFrame) setPaused(wc, isSignInUrl(details.url))
  }
  wc.on('did-start-navigation', onNavigation)
  wc.on('did-redirect-navigation', onNavigation)
  // A navigation that never committed leaves the tab where it was.
  wc.on('did-stop-loading', () => setPaused(wc, isSignInUrl(wc.getURL())))
  // A detach someone else caused (DevTools closing, a crash) drops the overrides: re-apply them.
  wc.debugger.on('detach', () => {
    for (const h of set) h.release = null
    setImmediate(() => {
      if (wc.isDestroyed() || paused.get(wc)) return
      for (const h of set) engage(wc, h)
    })
  })
  return set
}

export interface StandingOverride {
  /** Sends the override; runs after every (re)attach. */
  apply(): Promise<unknown> | void
  /** Undoes it while someone else keeps the debugger attached. */
  clear?(): Promise<unknown> | void
}

export const cdp = {
  /** Attaches if needed and returns the release. */
  acquire,

  /**
   * A standing override: applied now and after each re-attach, stepped aside
   * on sign-in pages. `pendingUrl` is where a just-created tab is headed.
   * Returns the release.
   */
  hold(wc: WebContents, override: StandingOverride, pendingUrl?: string): () => void {
    const set = watch(wc, pendingUrl)
    const h: Standing = { apply: override.apply, clear: override.clear, release: null }
    set.add(h)
    if (!paused.get(wc)) engage(wc, h)
    return () => {
      if (!set.delete(h)) return
      if (!wc.isDestroyed()) disengage(wc, h)
    }
  },

  /** `sessionId`: a child target's flat session (an out-of-process iframe or a worker), from Target.attachedToTarget. */
  send<T = unknown>(wc: WebContents, method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    return (sessionId ? wc.debugger.sendCommand(method, params, sessionId) : wc.debugger.sendCommand(method, params)) as Promise<T>
  },

  /** How many holders a webContents has (tests and diagnostics). */
  holders(wc: WebContents): number {
    return entries.get(wc)?.count ?? 0
  },

  /** True while the tab shows a sign-in page, where standing overrides step aside. */
  onSignInPage(wc: WebContents): boolean {
    return paused.get(wc) ?? isSignInUrl(wc.getURL())
  },
}
