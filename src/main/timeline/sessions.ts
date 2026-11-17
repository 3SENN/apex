/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The timeline's arithmetic, kept pure for tests: visits
// grouped into sessions split on idle gaps, per-day totals, and the site
// insights table. Excluded sites are filtered out before any of this.
import { localDayBounds, localDayKey } from '@shared/activity'
import type { SiteInsight, TimelineDay, TimelineSession } from '@shared/timeline'

/** A gap longer than this starts a new session. */
export const SESSION_GAP_MS = 20 * 60_000
/** One visit counts at most this much active time, so a tab left open overnight doesn't dominate. */
export const ACTIVE_CAP_MS = 30 * 60_000

export interface Visit {
  id: number
  url: string
  /** scheme://host, the site the visit counts for. */
  origin: string
  title: string
  at: number
  dwellMs: number
}

export function activeMs(v: Pick<Visit, 'dwellMs'>): number {
  return Math.min(Math.max(0, v.dwellMs), ACTIVE_CAP_MS)
}

/** "https://www.example.com" → "example.com", for display (shown in mono). */
export function siteLabel(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '')
  } catch {
    return origin
  }
}

/** Groups visits (any order) into sessions, oldest first. Each site lists its visits and time, most time first. */
export function groupSessions(visits: readonly Visit[], gapMs = SESSION_GAP_MS): TimelineSession[] {
  const sorted = [...visits].sort((a, b) => a.at - b.at || a.id - b.id)
  const groups: Visit[][] = []
  let end = Number.NEGATIVE_INFINITY
  for (const visit of sorted) {
    const current = groups[groups.length - 1]
    // A session ends when its last page was left; a gap after that splits it.
    if (!current || visit.at - end > gapMs) {
      groups.push([visit])
      end = visit.at + activeMs(visit)
    } else {
      current.push(visit)
      end = Math.max(end, visit.at + activeMs(visit))
    }
  }
  return groups.map((group) => {
    const sites = new Map<string, { origin: string; title: string; visits: number; activeMs: number; lastAt: number }>()
    for (const v of group) {
      const site = sites.get(v.origin) ?? { origin: v.origin, title: '', visits: 0, activeMs: 0, lastAt: 0 }
      site.visits += 1
      site.activeMs += activeMs(v)
      if (v.at >= site.lastAt && v.title) {
        site.title = v.title
        site.lastAt = v.at
      }
      sites.set(v.origin, site)
    }
    const first = group[0] as Visit
    return {
      id: `s-${first.id}`,
      start: first.at,
      end: Math.max(...group.map((v) => v.at + activeMs(v))),
      sites: [...sites.values()]
        .sort((a, b) => b.activeMs - a.activeMs || b.visits - a.visits || a.origin.localeCompare(b.origin))
        .map(({ origin, title, visits, activeMs: ms }) => ({ origin, title: title || siteLabel(origin), visits, activeMs: ms })),
      note: null,
    }
  })
}

/** One entry per local day in [from, to] that had visits, newest first. */
export function summarizeDays(visits: readonly Visit[]): TimelineDay[] {
  const byDay = new Map<string, Visit[]>()
  for (const v of visits) {
    const day = localDayKey(v.at)
    const list = byDay.get(day) ?? []
    list.push(v)
    byDay.set(day, list)
  }
  return [...byDay.entries()]
    .map(([day, list]) => ({ day, visits: list.length, activeMs: list.reduce((n, v) => n + activeMs(v), 0), sessions: groupSessions(list).length }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}

/** The site insights table: one row per site, sorted and filtered (the query matches the site and its last title). */
export function siteInsights(visits: readonly Visit[], options: { sort?: 'time' | 'visits' | 'recent'; query?: string } = {}): SiteInsight[] {
  const sites = new Map<string, SiteInsight>()
  for (const v of visits) {
    const site = sites.get(v.origin) ?? { origin: v.origin, title: '', visits: 0, activeMs: 0, lastVisit: 0 }
    site.visits += 1
    site.activeMs += activeMs(v)
    if (v.at >= site.lastVisit) {
      site.lastVisit = v.at
      if (v.title) site.title = v.title
    }
    sites.set(v.origin, site)
  }
  const words = (options.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const rows = [...sites.values()]
    .map((s) => ({ ...s, title: s.title || siteLabel(s.origin) }))
    .filter((s) => words.every((w) => s.origin.toLowerCase().includes(w) || s.title.toLowerCase().includes(w)))
  const sort = options.sort ?? 'time'
  return rows.sort((a, b) =>
    sort === 'visits' ? b.visits - a.visits || b.activeMs - a.activeMs : sort === 'recent' ? b.lastVisit - a.lastVisit : b.activeMs - a.activeMs || b.visits - a.visits,
  )
}

/** The visits of one local day. */
export function dayRange(day: string): { from: number; to: number } {
  const { from, to } = localDayBounds(day)
  return { from, to: to - 1 }
}
