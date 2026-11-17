/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Site suggestions (OV-23). On a site
// with a matching connector or app link, Apex offers to connect or one to
// three ready-made tasks from its own templates. Off by default.
import type { AppSummary, AppsService } from './apps'
import type { CalendarService, CalendarStatus } from './calendar'
import type { FlagsService } from './flags'
import type { TableSummary, TablesService } from './tables'

export interface SiteSuggestion {
  tabId: string
  origin: string
  kind: 'connector' | 'app-link'
  connectorId?: string
  /** A directory connector you haven't connected yet; the card offers to connect it. */
  directoryId?: string
  /** The service's name, for the card's title. */
  name?: string
  app?: string
  tasks: Array<{ id: string; title: string; prompt: string }>
}

export interface SiteSuggestionSettings {
  enabled: boolean
  offSites: string[]
  snoozedUntil: number | null
}

export type SuggestionDismissScope = 'once' | 'site' | 'everywhere' | { snoozeUntil: number }

export interface SiteSuggestionsService {
  current(tabId: string): SiteSuggestion | null
  settings(): SiteSuggestionSettings
  update(patch: Partial<SiteSuggestionSettings>): SiteSuggestionSettings
  dismiss(tabId: string, scope: SuggestionDismissScope): void
  /** Drafts a task into a chat (the attached one, or a new one); returns the chat id. */
  draft(tabId: string, taskId: string, target: { chatId: string } | 'new'): string
  openInApp(tabId: string): boolean
  /** The installed desktop app for this tab's page, for the toolbar's open-in-app chip; no opt-in needed. */
  appLink(tabId: string): { app: string } | null
}

/** Every new namespace of the platform features. */
export interface PlatformServices {
  apps: AppsService
  tables: TablesService
  flags: FlagsService
  calendar: CalendarService
  siteSuggestions: SiteSuggestionsService
}

/** AppEvent additions of the platform features. */
export type PlatformEvent =
  | { type: 'apps'; items: AppSummary[] }
  | { type: 'tables'; items: TableSummary[] }
  | { type: 'flags'; values: Record<string, string> }
  | { type: 'calendar'; status: CalendarStatus }
  | { type: 'site-suggestion'; tabId: string; suggestion: SiteSuggestion | null }


export const DEFAULT_SITE_SUGGESTION_SETTINGS: Readonly<SiteSuggestionSettings> = { enabled: false, offSites: [], snoozedUntil: null }

/** At most this many ready-made tasks per suggestion. */
export const SUGGESTION_TASKS_MAX = 3

/** The host a suggestion is keyed by: lower-case, without "www.". Null for anything that isn't an http(s) page. */
export function suggestionHost(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.toLowerCase().replace(/^www\./, '') || null
  } catch {
    return null
  }
}

function coveredBy(host: string, site: string): boolean {
  const s = site.toLowerCase().replace(/^www\./, '')
  return host === s || host.endsWith(`.${s}`)
}

/** Whether suggestions may show for this page now: opted in, not snoozed, not turned off for the site, not excluded. */
export function suggestionsAllowed(url: string, settings: SiteSuggestionSettings, now: number, excluded: (url: string) => boolean): boolean {
  if (!settings.enabled) return false
  if (settings.snoozedUntil !== null && settings.snoozedUntil > now) return false
  const host = suggestionHost(url)
  if (!host) return false
  if (settings.offSites.some((site) => coveredBy(host, site))) return false
  return !excluded(url)
}

export interface SuggestionConnector {
  id: string
  name: string
  enabled: boolean
  directoryId: string | null
  url: string
}

export interface SuggestionDirectoryEntry {
  id: string
  name: string
  site: string
}

/** What a page matches, best first: a connector you have, then one from the directory, then a desktop app. */
export type SiteMatch =
  | { kind: 'connector'; connectorId: string; name: string }
  | { kind: 'directory'; directoryId: string; name: string }
  | { kind: 'app-link'; key: string; app: string }

function baseDomain(host: string): string {
  return host.split('.').slice(-2).join('.')
}

export function matchSite(
  url: string,
  sources: { connectors: readonly SuggestionConnector[]; directory: readonly SuggestionDirectoryEntry[]; appLink: { key: string; app: string } | null },
): SiteMatch | null {
  const host = suggestionHost(url)
  if (!host) return null
  const entryFor = new Map(sources.directory.map((e) => [e.id, e]))
  for (const c of sources.connectors) {
    if (!c.enabled) continue
    const entry = c.directoryId ? entryFor.get(c.directoryId) : undefined
    const site = entry?.site ?? suggestionHost(c.url)
    if (site && (entry ? coveredBy(host, site) : baseDomain(host) === baseDomain(site))) return { kind: 'connector', connectorId: c.id, name: entry?.name ?? c.name }
  }
  const connected = new Set(sources.connectors.map((c) => c.directoryId).filter((id): id is string => id !== null))
  const entry = sources.directory.find((e) => !connected.has(e.id) && coveredBy(host, e.site))
  if (entry) return { kind: 'directory', directoryId: entry.id, name: entry.name }
  if (sources.appLink) return { kind: 'app-link', key: sources.appLink.key, app: sources.appLink.app }
  return null
}
