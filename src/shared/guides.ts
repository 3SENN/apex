/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Guides contract: the Guides destination
// (apex://guides, SH-07's Guides row). Apex's own guides,
// each optionally bundling skills, routines (installed paused) and
// connector suggestions behind a Try it button.
import type { RoutineDraft } from './routines'

export interface Guide {
  id: string
  title: string
  summary: string
  category: string
  minutes: number
  /** Markdown, rendered with guideMarkdown. */
  body: string
  bundle: { skills: string[]; routines: RoutineDraft[]; connectors: string[] } | null
  tryIt: 'install-bundle' | 'start-chat' | 'open'
}

export interface GuideTryResult {
  installedSkills: string[]
  routines: string[]
  connectorSuggestions: string[]
  chatId: string | null
}

export interface GuidesService {
  list(q?: { category?: string; query?: string }): Guide[]
  get(id: string): Guide
  tryIt(id: string): GuideTryResult
  /** Guides for the use cases picked in setup's questions step. */
  forUseCases(ids: string[]): Guide[]
}

/** Guide categories, in filter order. */
export const GUIDE_CATEGORIES = [
  { id: 'basics', label: 'Basics' },
  { id: 'research', label: 'Research' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'shopping', label: 'Shopping' },
  { id: 'travel', label: 'Travel' },
  // The gallery's further shelves.
  { id: 'writing', label: 'Writing' },
  { id: 'everyday', label: 'Everyday' },
] as const
export type GuideCategory = (typeof GUIDE_CATEGORIES)[number]['id']

/** Category and search filtering, shared by the page and the service. Search matches title, summary and body words. */
export function filterGuides<T extends Pick<Guide, 'title' | 'summary' | 'category' | 'body'>>(guides: readonly T[], q: { category?: string; query?: string } = {}): T[] {
  const words = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  return guides.filter((g) => {
    if (q.category && q.category !== 'all' && g.category !== q.category) return false
    if (words.length === 0) return true
    const hay = `${g.title} ${g.summary} ${g.body}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

/** apex://guides or apex://guides/<id>. */
export function guideUrl(id?: string): string {
  return id ? `apex://guides/${encodeURIComponent(id)}` : 'apex://guides'
}

/**
 * ST-04: the guide a long settings or destination page links to from its
 * header (`<PageHeader guide={SETTINGS_GUIDES[pageId]} />`).
 */
export const SETTINGS_GUIDES: Readonly<Record<string, string>> = {
  memory: 'memory-basics',
  activity: 'memory-basics',
  connectors: 'connect-your-apps',
  skills: 'skills-in-a-minute',
  routines: 'morning-digest',
  meetings: 'meeting-notes',
  companions: 'meet-your-companion',
  agent: 'meet-your-companion',
}
