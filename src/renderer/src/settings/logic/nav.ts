/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings nav: which pages exist, how they group, and how an address
// maps to a page. Pure, so the routing rules are unit-tested.
import { t, type MessageKey } from '@shared/i18n/core'
import { SETTINGS_ALIAS_PARENTS, SETTINGS_PAGE_ALIASES, SETTINGS_PAGES, settingsPageTitle } from '@shared/url'

export type SettingsPageId = (typeof SETTINGS_PAGES)[number]['id']

export interface NavPage {
  kind: 'page'
  id: SettingsPageId
  title: string
}

/** A nav row that opens another Atelier page (Connectors is a destination of its own). */
export interface NavLink {
  kind: 'link'
  id: string
  title: string
  url: string
}

export type NavEntry = NavPage | NavLink

export interface NavGroup {
  id: string
  /** null for the ungrouped rows at the top and bottom. */
  label: string | null
  entries: NavEntry[]
}

/**
 * Pages that have content in this build. A page in SETTINGS_PAGES stays out
 * of the nav (and its address falls back) until it has something to show.
 */
export const BUILT_PAGES: ReadonlySet<SettingsPageId> = new Set<SettingsPageId>([
  'you',
  'companions',
  'model',
  'permissions',
  'appearance',
  'search',
  'privacy',
  'import',
  'memory',
  // ST-01: the Companion, Browsing and Your data pages
  'dock-icon',
  'general',
  'languages',
  'default-browser',
  'notifications',
  'storage',
  'about',
  // ST-45
  'downloads',
  'transcription',
  'passwords',
  'voice',
  'decisions', // docs/decisions.md
  'activity',
  // ST-40
  'extensions',
  // ST-37 to ST-39: Settings › Profiles
  'profiles',
])

/** Pages shown on some platforms only; the rest of the time their rows are hidden, not greyed out (ST-01). */
export const PLATFORM_PAGES: Partial<Record<SettingsPageId, readonly string[]>> = {
  'dock-icon': ['darwin'],
}

/** Connectors is a destination of its own; its row's title is read when the nav is built, so it follows the app language. */
const CONNECTORS_LINK = { kind: 'link', id: 'connectors', url: 'atelier://connectors' } as const

// Top to bottom, as the settings spec groups them (feature-spec, Settings).
const GROUPS: ReadonlyArray<{ id: string; label: MessageKey | null; entries: ReadonlyArray<SettingsPageId | typeof CONNECTORS_LINK> }> = [
  { id: 'top', label: null, entries: ['you'] },
  { id: 'companion', label: 'settings.nav.group.companion', entries: ['companions', 'dock-icon'] },
  { id: 'agent', label: 'settings.nav.group.agent', entries: ['model', /* docs/decisions.md */ 'decisions', 'permissions', CONNECTORS_LINK, 'voice', 'transcription'] },
  { id: 'browsing', label: 'settings.nav.group.browsing', entries: ['general', 'appearance', 'search', 'languages', 'default-browser', 'notifications', 'privacy', /* C */ 'profiles', 'extensions'] },
  { id: 'data', label: 'settings.nav.group.data', entries: [ 'passwords', 'downloads', 'import', 'memory', 'activity', 'storage'] },
  { id: 'bottom', label: null, entries: ['about'] },
]

/** A page's nav title in the app language. */
export function pageTitle(id: SettingsPageId): string {
  return settingsPageTitle(id)
}

/** Whether a page is available here: built, and meant for this platform. */
export function pageAvailable(id: SettingsPageId, built: ReadonlySet<SettingsPageId>, platform: string | null): boolean {
  if (!built.has(id)) return false
  const only = PLATFORM_PAGES[id]
  return !only || platform === null || only.includes(platform)
}

/** The nav groups with only available pages; groups left empty are dropped. `platform` null shows every platform's rows. */
export function settingsNav(built: ReadonlySet<SettingsPageId> = BUILT_PAGES, platform: string | null = null): NavGroup[] {
  const groups: NavGroup[] = []
  for (const group of GROUPS) {
    const entries: NavEntry[] = []
    for (const entry of group.entries) {
      if (typeof entry !== 'string') entries.push({ ...entry, title: t('settings.nav.connectors') })
      else if (pageAvailable(entry, built, platform)) entries.push({ kind: 'page', id: entry, title: pageTitle(entry) })
    }
    if (entries.length) groups.push({ id: group.id, label: group.label ? t(group.label) : null, entries })
  }
  return groups
}

export const DEFAULT_PAGE: SettingsPageId = 'you'

// Sub-views a page can show from its own address. 'companion' is the old
// single-companion editor address: it now opens the active companion's look
// editor under Companions. Alias parents show another page
// inside a nav page: atelier://settings/sites is the site settings, under Privacy.
const SUB_VIEWS: Record<string, { page: SettingsPageId; view: string }> = {
  companion: { page: 'companions', view: 'look' },
  ...Object.fromEntries(Object.entries(SETTINGS_ALIAS_PARENTS).map(([view, page]) => [view, { page: page as SettingsPageId, view }])),
}

export interface ResolvedSection {
  page: SettingsPageId
  /** A sub-view of the page, or null for its main view. */
  view: string | null
  /** When set, the address should be rewritten to atelier://settings/<redirect>. */
  redirect: string | null
}

/**
 * Maps atelier://settings/<section> to the page that shows it. Aliases and old
 * names rewrite to the page that now holds the setting; unknown and
 * not-yet-built pages fall back to the default page with no error. Either way
 * the address is rewritten so the nav, breadcrumb and back button agree.
 */
export function resolveSettingsSection(section: string | null, built: ReadonlySet<SettingsPageId> = BUILT_PAGES, platform: string | null = null): ResolvedSection {
  if (section && Object.hasOwn(SUB_VIEWS, section)) {
    const sub = SUB_VIEWS[section]
    if (sub && pageAvailable(sub.page, built, platform)) return { page: sub.page, view: sub.view, redirect: null }
  }
  const known = SETTINGS_PAGES.find((p) => p.id === section)
  if (known && pageAvailable(known.id, built, platform)) return { page: known.id, view: null, redirect: null }
  if (section && Object.hasOwn(SETTINGS_PAGE_ALIASES, section)) {
    const target = SETTINGS_PAGES.find((p) => p.id === SETTINGS_PAGE_ALIASES[section])
    if (target && pageAvailable(target.id, built, platform)) return { page: target.id, view: null, redirect: target.id }
  }
  return { page: DEFAULT_PAGE, view: null, redirect: DEFAULT_PAGE }
}

/** What a settings address carries after `?` (ST-03, ST-05). */
export interface SettingsQuery {
  /** A row anchor to scroll to and highlight (?highlight=<anchor>). */
  highlight: string | null
  /** Import: the browser to preselect (?browser=<id>). */
  browser: string | null
  /** Privacy: open the clear-browsing-data dialog (?clear=1). */
  clear: boolean
  /** Profiles: open the new-profile dialog (?new=1, from the profile menus' Add…). */
  create?: boolean
  /** The rest, kept when an alias rewrites the address. */
  raw: string
}

const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/

/** Reads the query of an atelier://settings address; unsafe values are dropped. */
export function settingsQuery(url: string | null | undefined): SettingsQuery {
  const at = url ? url.indexOf('?') : -1
  const raw = url && at >= 0 ? url.slice(at + 1).split('#')[0] ?? '' : ''
  let params: URLSearchParams
  try {
    params = new URLSearchParams(raw)
  } catch {
    params = new URLSearchParams()
  }
  const value = (name: string): string | null => {
    const v = params.get(name)
    return v && SAFE_VALUE.test(v) ? v : null
  }
  return { highlight: value('highlight'), browser: value('browser'), clear: params.get('clear') === '1', create: params.get('new') === '1', raw }
}

/** Below this content width the nav collapses to an icon rail. */
export const NAV_RAIL_BELOW = 960

/** The expanded nav's width limits and the keyboard step on its splitter (ST-02, DS-128). */
export const NAV_WIDTH = { min: 220, max: 400, default: 288, step: 16 } as const

/** Clamps a remembered or dragged width; anything unreadable is the default. */
export function clampNavWidth(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  if (!Number.isFinite(n)) return NAV_WIDTH.default
  return Math.round(Math.min(NAV_WIDTH.max, Math.max(NAV_WIDTH.min, n)))
}

/** The splitter's keys: ←/→ step, Home/End jump to the limits; null for any other key. */
export function navWidthForKey(key: string, width: number): number | null {
  switch (key) {
    case 'ArrowLeft':
      return clampNavWidth(width - NAV_WIDTH.step)
    case 'ArrowRight':
      return clampNavWidth(width + NAV_WIDTH.step)
    case 'Home':
      return NAV_WIDTH.min
    case 'End':
      return NAV_WIDTH.max
    default:
      return null
  }
}

export type NavMode = 'expanded' | 'rail' | 'overlay'

/**
 * How the nav draws. Wide: expanded unless you collapsed it. Narrow: an icon
 * rail, which opens as a floating panel over the page while you browse it.
 */
export function navMode(width: number, collapsed: boolean, peeking: boolean): NavMode {
  if (width >= NAV_RAIL_BELOW) return collapsed ? 'rail' : 'expanded'
  return peeking ? 'overlay' : 'rail'
}
