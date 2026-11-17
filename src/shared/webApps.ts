/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Websites saved as apps (WA-01): a site you use a lot, kept as an app in
// Apex. It stays a web address: nothing is converted or installed. Saving
// takes the site's own name and icon (its web app manifest when it has one,
// else its title and favicon); the app is listed in Workspace › Apps and the
// command bar, and opening it goes back to its tab when one is open, else
// opens one. Workspace › Apps also suggests the sites you visit most.

export interface WebApp {
  id: string
  name: string
  /** Where it opens: the site's own start page, else the page you saved it from. */
  url: string
  /** The site's icon as a data URL; null draws the app's initial. */
  icon: string | null
  addedAt: number
  lastOpenedAt: number | null
}

/** A site you visit a lot that isn't an app yet (Workspace › Apps offers to save it). */
export interface WebAppSuggestion {
  url: string
  host: string
  title: string
  visits: number
}

export const WEB_APP_LIMITS = { apps: 200, name: 60, url: 2048, icon: 256 * 1024 } as const

/** Visits in the last 30 days before a site is worth suggesting. */
export const SUGGEST_MIN_VISITS = 5

export interface WebAppsServices {
  webApps: {
    list(): WebApp[]
    /** Saves the site a tab shows as an app, with its own name and icon when it has them; the app already saved for that page if there is one. */
    saveTab(tabId: string): Promise<WebApp>
    /** Saves a suggested site (its name and icon come from its favicon and title). */
    saveUrl(url: string, name: string): Promise<WebApp>
    rename(id: string, name: string): WebApp
    remove(id: string): void
    /** Opens it in the asking window: its own tab when one is open (in any window), else a new one. */
    open(id: string): void
    /** Sites you visit a lot that aren't apps yet, most visited first. */
    suggestions(): WebAppSuggestion[]
  }
}

/** The address without its fragment, for telling apps apart. */
export function webAppKey(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    u.hash = ''
    return u.href
  } catch {
    return null
  }
}

/** True when a tab at `pageUrl` belongs to the app at `appUrl`: under its address, or (when `wholeSite`) anywhere on its site. */
export function pageOfApp(pageUrl: string, appUrl: string, wholeSite: boolean): boolean {
  try {
    const page = new URL(pageUrl)
    const app = new URL(appUrl)
    if (page.origin !== app.origin) return false
    if (wholeSite) return true
    const base = app.pathname.endsWith('/') ? app.pathname : `${app.pathname}/`
    return page.pathname === app.pathname || page.pathname.startsWith(base)
  } catch {
    return false
  }
}

/** A short app name from a page title: "Inbox (3) - Gmail" → "Gmail", "Figma" → "Figma". */
export function nameFromTitle(title: string, host: string): string {
  const clean = title.replace(/^\(\d+\)\s*/, '').trim()
  const parts = clean.split(/\s+[|·–—-]\s+/).map((p) => p.trim()).filter(Boolean)
  const short = parts.length > 1 ? (parts.at(-1) ?? clean) : clean
  const fallback = host.replace(/^www\./, '').split('.')[0] ?? host
  const name = short && short.length <= WEB_APP_LIMITS.name ? short : fallback.charAt(0).toUpperCase() + fallback.slice(1)
  return name.slice(0, WEB_APP_LIMITS.name)
}

export interface HistoryVisit {
  url: string
  title: string
  visits: number
  visitTimes?: number[]
}

/** The sites worth suggesting: visited at least SUGGEST_MIN_VISITS times in 30 days, not saved yet, most visited first. */
export function suggestWebApps(history: readonly HistoryVisit[], saved: readonly WebApp[], now: number, skipHosts: readonly string[] = [], limit = 6): WebAppSuggestion[] {
  const since = now - 30 * 24 * 60 * 60 * 1000
  const savedHosts = new Set(saved.flatMap((a) => {
    try {
      return [new URL(a.url).host]
    } catch {
      return []
    }
  }))
  const byHost = new Map<string, { visits: number; best: HistoryVisit; bestVisits: number; origin: string }>()
  for (const e of history) {
    let u: URL
    try {
      u = new URL(e.url)
    } catch {
      continue
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
    if (savedHosts.has(u.host) || skipHosts.includes(u.host)) continue
    const recent = e.visitTimes ? e.visitTimes.filter((t) => t >= since).length : e.visits
    if (recent === 0) continue
    const at = byHost.get(u.host)
    if (!at) byHost.set(u.host, { visits: recent, best: e, bestVisits: recent, origin: u.origin })
    else {
      at.visits += recent
      if (recent > at.bestVisits) {
        at.best = e
        at.bestVisits = recent
      }
    }
  }
  return [...byHost.entries()]
    .filter(([, v]) => v.visits >= SUGGEST_MIN_VISITS)
    .sort((a, b) => b[1].visits - a[1].visits)
    .slice(0, limit)
    .map(([host, v]) => ({ url: `${v.origin}/`, host, title: nameFromTitle(v.best.title, host), visits: v.visits }))
}
