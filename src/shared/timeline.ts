/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Timeline contract: the timeline and site insights, a Workspace section.
// Built from the per-profile visits log (visits.sqlite) and, when on,
// activity memory.

/** One day in the timeline's strip. `day` is local 'YYYY-MM-DD'. */
export interface TimelineDay {
  day: string
  visits: number
  activeMs: number
  sessions: number
}

/** A run of browsing on one day, split by idle gaps over 20 minutes. */
export interface TimelineSession {
  id: string
  start: number
  end: number
  /** Thumbnails from activity memory when screenshots are on (JPEG data URLs, newest last). */
  thumbnails?: Array<{ at: number; url: string; media: string }>
  /** The sites in this session, most time first. */
  sites: Array<{ origin: string; title: string; visits: number; activeMs: number }>
  /** A short note from activity memory, when it was on. */
  note: string | null
}

export interface SiteInsight {
  origin: string
  title: string
  visits: number
  activeMs: number
  lastVisit: number
}

export interface Insight {
  id: string
  /** 'todo' is a possible to-do. */
  kind: 'habit' | 'focus' | 'routine-idea' | 'todo'
  title: string
  detail: string
  /** An apex:// address the insight's action opens, if any. */
  action: { label: string; url: string } | null
  at: number
}

export interface TimelineService {
  days(range: { from: number; to: number }): TimelineDay[]
  sessions(day: string): TimelineSession[]
  sites(q: { from: number; to: number; sort?: 'time' | 'visits' | 'recent'; query?: string }): SiteInsight[]
  /** Only while proactive.insights is on; written by a one-shot completion over activity notes, so it may take a moment. */
  insights(range: { from: number; to: number }): Promise<Insight[]>
  dismissInsight(id: string): void
}

/** TabManager's 'page-visited' payload: a committed main-frame http(s) navigation. */
export interface PageVisit {
  tabId: string
  url: string
  title: string
  at: number
  agentControlled: boolean
  privateWindow: boolean
  profileId: string
}

/** TabManager's 'page-left' payload: the page a tab navigated away from or closed, and how long it stayed. */
export interface PageLeft {
  tabId: string
  url: string
  dwellMs: number
}
