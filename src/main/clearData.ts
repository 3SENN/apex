/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Session } from 'electron'
import type { ClearDataRequest, ClearRange } from '@shared/services/settings'
import { log } from './log'

// Clearing website data (ST-36): the cache, cookies and site data, and
// the combined clear-browsing-data dialog (⇧⌘⌫). Chromium can't clear cookies
// by age, so a time range other than "all time" clears site data for the
// origins visited in that range, which is what people expect it to reach.

const HOUR = 3_600_000

export const RANGE_MS: Readonly<Record<ClearRange, number | null>> = {
  hour: HOUR,
  day: 24 * HOUR,
  week: 7 * 24 * HOUR,
  month: 28 * 24 * HOUR,
  all: null,
}

/** The earliest moment a range reaches back to; null for all time. */
export function rangeStart(range: ClearRange, now = Date.now()): number | null {
  const span = RANGE_MS[range]
  return span === null ? null : now - span
}

/** The distinct http(s) origins among history entries visited since `since`. */
export function originsVisitedSince(entries: ReadonlyArray<{ url: string; lastVisit: number }>, since: number): string[] {
  const origins = new Set<string>()
  for (const entry of entries) {
    if (entry.lastVisit < since) continue
    try {
      const url = new URL(entry.url)
      if (url.protocol === 'http:' || url.protocol === 'https:') origins.add(url.origin)
    } catch {
      // Not a URL; nothing to clear for it.
    }
  }
  return [...origins].sort()
}

/** The site-data types Chromium clears for "cookies and site data". */
export const SITE_DATA_TYPES = ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch'] as const

/** What clearing site data (and cache) for a request means, as pure data so the option sets are testable. */
export function clearPlan(request: ClearDataRequest, history: ReadonlyArray<{ url: string; lastVisit: number }>, now = Date.now()): {
  historySince: number | null | false
  siteData: { origins: string[] | null } | false
  cache: { origins: string[] | null } | false
} {
  const since = rangeStart(request.range, now)
  const origins = since === null ? null : originsVisitedSince(history, since)
  return {
    historySince: request.history ? since : false,
    siteData: request.siteData ? { origins } : false,
    cache: request.cache ? { origins } : false,
  }
}

/** HTTP, code, cache-storage and host-resolver caches; cookies stay. */
export async function clearCache(sessions: readonly Session[]): Promise<void> {
  for (const s of sessions) {
    await s.clearCache()
    await s.clearCodeCaches({})
    await s.clearHostResolverCache()
    await s.clearStorageData({ storages: ['cachestorage', 'shadercache'] })
  }
}

/** Cookies, storage, databases, service workers and site caches, everywhere or for some origins. */
export async function clearSiteData(sessions: readonly Session[], origins: string[] | null = null): Promise<void> {
  if (origins && origins.length === 0) return
  for (const s of sessions) {
    await s.clearData({ dataTypes: [...SITE_DATA_TYPES, 'cache'], ...(origins ? { origins } : {}) })
    if (!origins) await s.clearAuthCache()
  }
}

/** Cache for some origins only (a ranged clear); all of it otherwise. */
async function clearCacheFor(sessions: readonly Session[], origins: string[] | null): Promise<void> {
  if (!origins) return clearCache(sessions)
  if (origins.length === 0) return
  for (const s of sessions) await s.clearData({ dataTypes: ['cache'], origins })
}

export interface ClearDeps {
  sessions(): Session[]
  history: {
    search(query: string, limit: number): Array<{ url: string; lastVisit: number }>
    remove(url: string): void
    clear(): void
  }
}

/** Runs the dialog's request: history first (it decides the origins), then site data and cache. */
export async function clearBrowsingData(request: ClearDataRequest, deps: ClearDeps, now = Date.now()): Promise<void> {
  const entries = deps.history.search('', 100_000)
  const plan = clearPlan(request, entries, now)
  if (plan.siteData) await clearSiteData(deps.sessions(), plan.siteData.origins)
  if (plan.cache) await clearCacheFor(deps.sessions(), plan.cache.origins)
  if (plan.historySince === null) deps.history.clear()
  else if (plan.historySince !== false) {
    const since = plan.historySince
    for (const entry of entries) if (entry.lastVisit >= since) deps.history.remove(entry.url)
  }
  log.info('settings', 'Browsing data cleared', { range: request.range, history: request.history, siteData: request.siteData, cache: request.cache })
}
