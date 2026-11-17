/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The getting-started plan (apex://first-week): its record's contract and the
// pure rules for what the page shows. Main keeps the record
// (src/main/firstWeek.ts); the chrome renders the view
// (src/renderer/src/first-week/).

import { BRAND_NAME } from './branding'
import { t, type MessageKey } from './i18n/core'

/** The record's file format. A file with a higher version comes from a newer Apex and is reset with a notice. */
export const FIRST_WEEK_VERSION = 1

/** The page shows this many cards before "Show more". */
export const PLAN_COLLAPSED = 6
/** Dismiss all unlocks this long after setup. */
export const DISMISS_ALL_AFTER_MS = 30 * 86_400_000
/** Snooze hides the plan until this local hour the next day. */
export const SNOOZE_HOUR = 9
/** At most this many starter chats are kept. */
export const STARTERS_MAX = 8

/** Glyphs a card can show; the chrome maps each to a lucide icon. */
export const FIRST_WEEK_GLYPHS = [
  'compass', 'pen', 'search', 'calendar', 'list', 'lightbulb', 'mail', 'cart', 'book', 'chart', 'globe', 'sparkles',
  'import', 'browser', 'plug', 'palette', 'clock', 'mic', 'wave', 'shapes',
] as const
export type FirstWeekGlyph = (typeof FIRST_WEEK_GLYPHS)[number]
/** Glyphs a generated starter may pick (the rest belong to the automatic items). */
export const STARTER_GLYPHS = ['compass', 'pen', 'search', 'calendar', 'list', 'lightbulb', 'mail', 'cart', 'book', 'chart', 'globe', 'sparkles'] as const satisfies readonly FirstWeekGlyph[]

/** Apex's card hues; the chrome defines each as a light and dark token. */
export const FIRST_WEEK_HUES = ['teal', 'green', 'amber', 'blue', 'violet', 'rose', 'coral', 'sky', 'lime', 'indigo'] as const
export type FirstWeekHue = (typeof FIRST_WEEK_HUES)[number]

/** A first chat to try, opened with the active companion and this prompt. */
export interface StarterChat {
  /** s1…s8, stable for one set of starters. */
  id: string
  title: string
  description: string
  prompt: string
  glyph: FirstWeekGlyph
  hue: FirstWeekHue
}

/** Items that complete on their own signal. */
export const AUTO_ITEMS = ['import-data', 'default-browser', 'connect-app', 'customise-companion', 'set-up-routine', 'try-dictation', 'record-meeting', 'build-artifact', 'search-web'] as const
export type AutoItemId = (typeof AUTO_ITEMS)[number]

/** What Apex can observe for the automatic items. */
export type FirstWeekSignals = Record<AutoItemId, boolean>

/** Signals that stay done once seen. Default browser is checked live on every refresh, since it can be changed back. */
export const STICKY_SIGNALS: readonly AutoItemId[] = ['import-data', 'connect-app', 'customise-companion', 'set-up-routine', 'try-dictation', 'record-meeting', 'build-artifact', 'search-web']

/** Voice dictation is available, so its item shows; it completes on the transcription-ready signal. */
export const DICTATION_AVAILABLE = true

export type FirstWeekAction =
  | { kind: 'chat'; prompt: string }
  /** An apex:// page; `companion` opens the active companion's card. */
  | { kind: 'page'; url: string }
  | { kind: 'companion' }
  | { kind: 'default-browser' }
  /** NT-01: a new tab with its composer set to search the web. */
  | { kind: 'web-search' }

export interface FirstWeekItem {
  id: string
  /** starter: a chat, done once opened or by hand; auto: done on its signal. */
  kind: 'starter' | 'auto'
  title: string
  description: string
  glyph: FirstWeekGlyph
  hue: FirstWeekHue
  done: boolean
  action: FirstWeekAction
}

/** Why the plan was hidden; recorded so the reason can inform later changes. */
export const HIDE_REASONS = ['know-my-way', 'not-now', 'too-much', 'other'] as const
export type FirstWeekHideReason = (typeof HIDE_REASONS)[number]
export const HIDE_REASON_LABELS: Record<FirstWeekHideReason, string> = {
  'know-my-way': 'I already know my way around',
  'not-now': 'Not right now',
  'too-much': 'It’s too much at once',
  other: 'Something else',
}
export const HIDE_NOTE_MAX = 500

/**
 * off: hidden or switched off. not-created: setup hasn't finished. invalid:
 * the saved file couldn't be used and was started over (the notice says why
 * until acknowledged). ready: the plan as normal.
 */
export type FirstWeekStatus = 'off' | 'not-created' | 'invalid' | 'ready'

export interface FirstWeekView {
  status: FirstWeekStatus
  /** Shown once after the file was reset. */
  notice: string | null
  /** Visible items, unfinished first; dismissed ones are left out. */
  items: FirstWeekItem[]
  done: number
  total: number
  createdAt: number | null
  /** Set while snoozed; the page shows the plan again at this time. */
  snoozedUntil: number | null
  dismissAllAt: number | null
  canDismissAll: boolean
  /** Starters are being written from what Apex knows; curated ones show meanwhile. */
  personalizing: boolean
  startersSource: 'personal' | 'curated' | null
  hiddenReason: FirstWeekHideReason | null
}

// ---- guides ----

export interface FirstWeekGuide {
  id: string
  title: string
  summary: string
  /** Reading time, shown on the preview's badge. */
  minutes: number
}

/** Apex's own short guides, shipped as Markdown in the chrome (first-week/guides/<id>.md). */
export const FIRST_WEEK_GUIDES: readonly FirstWeekGuide[] = [
  { id: 'meet-your-companion', title: 'Meet your companion', summary: 'What your companion can do, how to ask, and how to make it look like yours.', minutes: 2 },
  { id: 'chats-and-tabs', title: 'Chats and tabs', summary: 'Start a chat from anywhere, keep it beside a page, and find it again later.', minutes: 3 },
  { id: 'skills-and-routines', title: 'Skills and routines', summary: 'Save a prompt you use often, then let it run on a schedule.', minutes: 3 },
  { id: 'memory-and-connectors', title: 'Memory and connectors', summary: 'Teach your companion what matters to you and connect the apps you use.', minutes: 2 },
]

export function guideById(id: string | null | undefined): FirstWeekGuide | null {
  return FIRST_WEEK_GUIDES.find((g) => g.id === id) ?? null
}

/** Each guide's title and summary in the catalogue; the English above stays the data's own. */
const GUIDE_KEYS: Record<string, { title: MessageKey; summary: MessageKey }> = {
  'meet-your-companion': { title: 'firstRun.weekGuide.meetYourCompanion.title', summary: 'firstRun.weekGuide.meetYourCompanion.summary' },
  'chats-and-tabs': { title: 'firstRun.weekGuide.chatsAndTabs.title', summary: 'firstRun.weekGuide.chatsAndTabs.summary' },
  'skills-and-routines': { title: 'firstRun.weekGuide.skillsAndRoutines.title', summary: 'firstRun.weekGuide.skillsAndRoutines.summary' },
  'memory-and-connectors': { title: 'firstRun.weekGuide.memoryAndConnectors.title', summary: 'firstRun.weekGuide.memoryAndConnectors.summary' },
}

/** A guide's title in the app language, or null for an unknown guide. */
export function firstWeekGuideTitle(id: string): string | null {
  const keys = Object.hasOwn(GUIDE_KEYS, id) ? GUIDE_KEYS[id] : undefined
  return keys ? t(keys.title) : (guideById(id)?.title ?? null)
}

/** A guide's one-line summary in the app language, or null for an unknown guide. */
export function firstWeekGuideSummary(id: string): string | null {
  const keys = Object.hasOwn(GUIDE_KEYS, id) ? GUIDE_KEYS[id] : undefined
  return keys ? t(keys.summary) : (guideById(id)?.summary ?? null)
}

export function guideUrl(id: string): string {
  return `apex://first-week/${id}`
}

// ---- rules ----

/** 9:00 on the next local day after `now`. */
export function nextMorning(now: number): number {
  const date = new Date(now)
  date.setDate(date.getDate() + 1)
  date.setHours(SNOOZE_HOUR, 0, 0, 0)
  return date.getTime()
}

export function dismissAllUnlocksAt(createdAt: number): number {
  return createdAt + DISMISS_ALL_AFTER_MS
}

interface AutoDefinition {
  id: AutoItemId
  title: string
  description: string
  glyph: FirstWeekGlyph
  hue: FirstWeekHue
  action: FirstWeekAction
}

/** The automatic items. */
export const AUTO_DEFINITIONS: Record<AutoItemId, AutoDefinition> = {
  'import-data': { id: 'import-data', title: 'Bring your bookmarks', description: 'Import bookmarks and history from the browser you use now', glyph: 'import', hue: 'sky', action: { kind: 'page', url: 'apex://settings/import' } },
  'default-browser': { id: 'default-browser', title: `Make ${BRAND_NAME} your browser`, description: 'Open links from other apps here, with your companion close by', glyph: 'browser', hue: 'indigo', action: { kind: 'default-browser' } },
  'connect-app': { id: 'connect-app', title: 'Connect an app', description: 'Let your companion use your calendar, notes or files when you ask', glyph: 'plug', hue: 'green', action: { kind: 'page', url: 'apex://connectors' } },
  'customise-companion': { id: 'customise-companion', title: 'Make your companion yours', description: 'Change its look, name or the way it works for you', glyph: 'palette', hue: 'rose', action: { kind: 'companion' } },
  'set-up-routine': { id: 'set-up-routine', title: 'Set up a routine', description: 'Have a chat run on a schedule, like a morning briefing', glyph: 'clock', hue: 'amber', action: { kind: 'page', url: 'apex://routines' } },
  'try-dictation': { id: 'try-dictation', title: 'Talk instead of typing', description: 'Dictate a message to your companion', glyph: 'mic', hue: 'violet', action: { kind: 'page', url: 'apex://settings/general' } },
  // ON-13: the items that arrived with their features (meeting transcription, artifacts).
  'record-meeting': { id: 'record-meeting', title: 'Keep notes of a meeting', description: 'Record a call and get a transcript with a short summary', glyph: 'wave', hue: 'teal', action: { kind: 'page', url: 'apex://meetings' } },
  'build-artifact': { id: 'build-artifact', title: 'Make something together', description: 'Ask your companion for a small app, chart or page you can keep', glyph: 'shapes', hue: 'coral', action: { kind: 'page', url: 'apex://library/files' } },
  // NT-01: ticks the first time a new tab searches the web or goes to a typed site.
  'search-web': { id: 'search-web', title: 'Search the web from a new tab', description: 'Switch the new tab to your search engine, or type a site to go there', glyph: 'search', hue: 'blue', action: { kind: 'web-search' } },
}

/** Starters and automatic items interleaved, so the first six mix both kinds. */
const AUTO_ORDER: readonly AutoItemId[] = ['import-data', 'search-web', 'connect-app', 'customise-companion', 'default-browser', 'set-up-routine', 'try-dictation', 'build-artifact', 'record-meeting']

export interface PlanInput {
  starters: readonly StarterChat[]
  /** Item id to when it was done (sticky signals and hand-marked items). */
  completed: Readonly<Record<string, number>>
  dismissed: Readonly<Record<string, number>>
  signals: FirstWeekSignals
  dictationAvailable?: boolean
}

/** The automatic items' words in the catalogue: the cards read them in the app language. */
const AUTO_KEYS: Record<AutoItemId, { title: MessageKey; description: MessageKey }> = {
  'import-data': { title: 'firstRun.weekAuto.importData.title', description: 'firstRun.weekAuto.importData.description' },
  'default-browser': { title: 'firstRun.weekAuto.defaultBrowser.title', description: 'firstRun.weekAuto.defaultBrowser.description' },
  'connect-app': { title: 'firstRun.weekAuto.connectApp.title', description: 'firstRun.weekAuto.connectApp.description' },
  'customise-companion': { title: 'firstRun.weekAuto.customiseCompanion.title', description: 'firstRun.weekAuto.customiseCompanion.description' },
  'set-up-routine': { title: 'firstRun.weekAuto.setUpRoutine.title', description: 'firstRun.weekAuto.setUpRoutine.description' },
  'try-dictation': { title: 'firstRun.weekAuto.tryDictation.title', description: 'firstRun.weekAuto.tryDictation.description' },
  'record-meeting': { title: 'firstRun.weekAuto.recordMeeting.title', description: 'firstRun.weekAuto.recordMeeting.description' },
  'build-artifact': { title: 'firstRun.weekAuto.buildArtifact.title', description: 'firstRun.weekAuto.buildArtifact.description' },
  'search-web': { title: 'firstRun.weekAuto.searchWeb.title', description: 'firstRun.weekAuto.searchWeb.description' },
}

/** Every item the page can show, in base order, with its done state. Dismissed and unavailable items are left out. */
export function planItems(input: PlanInput): FirstWeekItem[] {
  const autos = AUTO_ORDER.filter((id) => id !== 'try-dictation' || (input.dictationAvailable ?? DICTATION_AVAILABLE))
  const items: FirstWeekItem[] = []
  const total = Math.max(input.starters.length, autos.length)
  for (let i = 0; i < total; i++) {
    const starter = input.starters[i]
    if (starter) {
      items.push({ ...starter, kind: 'starter', done: Object.hasOwn(input.completed, starter.id), action: { kind: 'chat', prompt: starter.prompt } })
    }
    const auto = autos[i]
    if (auto) {
      const def = AUTO_DEFINITIONS[auto]
      const live = input.signals[auto]
      const done = live || (STICKY_SIGNALS.includes(auto) && Object.hasOwn(input.completed, auto))
      const keys = AUTO_KEYS[auto]
      items.push({ id: def.id, kind: 'auto', title: t(keys.title), description: t(keys.description), glyph: def.glyph, hue: def.hue, done, action: def.action })
    }
  }
  return items.filter((item) => !Object.hasOwn(input.dismissed, item.id))
}

/** Unfinished items first, each group keeping its base order, so the first six are the ones still to try. */
export function orderPlan(items: readonly FirstWeekItem[]): FirstWeekItem[] {
  return [...items.filter((i) => !i.done), ...items.filter((i) => i.done)]
}

/** The cards on screen: the first six, or all of them when expanded. */
export function visiblePlan(items: readonly FirstWeekItem[], expanded: boolean): { shown: FirstWeekItem[]; more: number } {
  if (expanded || items.length <= PLAN_COLLAPSED) return { shown: [...items], more: 0 }
  return { shown: items.slice(0, PLAN_COLLAPSED), more: items.length - PLAN_COLLAPSED }
}

/**
 * Where an arrow key moves focus in the two-column card grid. Left and right
 * step through the reading order; up and down move a row, staying put at the
 * edges. Returns null for keys the grid doesn't handle.
 */
export function gridStep(index: number, key: string, count: number, columns = 2): number | null {
  if (count <= 0) return null
  let next: number
  switch (key) {
    case 'ArrowRight':
      next = index + 1
      break
    case 'ArrowLeft':
      next = index - 1
      break
    case 'ArrowDown':
      next = index + columns
      break
    case 'ArrowUp':
      next = index - columns
      break
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
  return next < 0 || next >= count ? index : next
}

/** The pill under the grid. */
export function showMoreLabel(more: number, expanded: boolean): string {
  return expanded ? 'Show less' : `Show ${more} more`
}

/** Hues for generated starters, assigned in turn so neighbouring cards differ. */
export function starterHue(index: number): FirstWeekHue {
  const cycle: readonly FirstWeekHue[] = ['teal', 'coral', 'blue', 'lime', 'violet', 'amber', 'rose', 'sky']
  return cycle[index % cycle.length] ?? 'teal'
}
