/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Site suggestions and open-in-app (OV-23, SH-32/DS-24).
// Opt-in and off by default: on a site that matches a connector you have,
// one from the directory, or a desktop app, Atelier offers to connect it or one
// to three ready-made tasks from its own templates. Snooze, off for this
// site and off everywhere live in userData/site-suggestions.json; your
// activity-memory exclusions are respected. The open-in-app chip needs no
// opt-in: it only shows when the app is installed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appLinkFor, appLinkRuleFor, APP_LINK_RULES, type AppLinkRule } from '@shared/appLinks'
import type { MessageKey } from '@shared/i18n/core'
import {
  DEFAULT_SITE_SUGGESTION_SETTINGS,
  SUGGESTION_TASKS_MAX,
  matchSite,
  suggestionHost,
  suggestionsAllowed,
  type SiteMatch,
  type SiteSuggestion,
  type SiteSuggestionSettings,
  type SiteSuggestionsService,
  type SuggestionConnector,
  type SuggestionDirectoryEntry,
} from '@shared/siteSuggestions'
import { mainT } from './i18n/mainT'
import { writeAtomic } from './settings'

/** Task templates by app-link key; connectors get the generic connector pair. Strings live in platform.task.*. */
const TASKS_BY_KEY: Record<string, string[]> = {
  zoom: ['meetingPrep', 'summarize'],
  teams: ['meetingPrep', 'summarize'],
  slack: ['catchUp', 'replies'],
  discord: ['catchUp'],
  spotify: ['aboutMusic', 'similar'],
  'apple-music': ['aboutMusic', 'similar'],
  figma: ['describeDesign', 'designReview'],
  notion: ['summarize', 'todo'],
  linear: ['issueSummary', 'nextStep'],
  github: ['explainRepo', 'gettingStarted'],
}
const CONNECTOR_TASKS = ['connectorFind', 'summarize']

export function tasksFor(match: SiteMatch, t: (key: MessageKey, vars?: Record<string, string>) => string = mainT): SiteSuggestion['tasks'] {
  if (match.kind === 'directory') return []
  const ids = match.kind === 'connector' ? CONNECTOR_TASKS : (TASKS_BY_KEY[match.key] ?? ['summarize'])
  const name = match.kind === 'connector' ? match.name : match.app
  return ids.slice(0, SUGGESTION_TASKS_MAX).map((id) => ({
    id,
    title: t(`platform.task.${id}.title` as MessageKey, { name }),
    prompt: t(`platform.task.${id}.prompt` as MessageKey, { name }),
  }))
}

export interface SiteSuggestionDeps {
  dataDir: string
  /** The page a tab shows now, or null for unknown, Atelier and blank tabs. */
  tabUrl(tabId: string): string | null
  connectors(): SuggestionConnector[]
  directory(): SuggestionDirectoryEntry[]
  excluded(url: string): boolean
  /** Whether an app handles this scheme (app.getApplicationNameForProtocol). */
  installed(scheme: string): boolean
  openExternal(url: string): void
  /** A new draft chat for 'new'; returns its id. */
  newChat(): string
  chatExists(chatId: string): boolean
  broadcast(event: { type: 'site-suggestion'; tabId: string; suggestion: SiteSuggestion | null }): void
  rules?: readonly AppLinkRule[]
  now?: () => number
}

export class SiteSuggestions implements SiteSuggestionsService {
  readonly #deps: SiteSuggestionDeps
  readonly #path: string
  #settings: SiteSuggestionSettings
  /** "Not now" for one tab: hidden until the tab shows another site. */
  readonly #dismissed = new Map<string, string>()
  /** The last suggestion sent per tab, so a broadcast only goes out on a change. */
  readonly #last = new Map<string, string>()

  constructor(deps: SiteSuggestionDeps) {
    this.#deps = deps
    this.#path = join(deps.dataDir, 'site-suggestions.json')
    this.#settings = this.#load()
  }

  #load(): SiteSuggestionSettings {
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<SiteSuggestionSettings>
      return {
        enabled: raw.enabled === true,
        offSites: Array.isArray(raw.offSites) ? raw.offSites.filter((s): s is string => typeof s === 'string').slice(0, 1000) : [],
        snoozedUntil: typeof raw.snoozedUntil === 'number' ? raw.snoozedUntil : null,
      }
    } catch {
      return { ...DEFAULT_SITE_SUGGESTION_SETTINGS, offSites: [] }
    }
  }

  #save(): void {
    writeAtomic(this.#path, JSON.stringify(this.#settings, null, 2))
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  #rules(): readonly AppLinkRule[] {
    return this.#deps.rules ?? APP_LINK_RULES
  }

  /** The installed app for a page, or null. */
  appLink(url: string): { key: string; app: string; openUrl: string } | null {
    const hit = appLinkRuleFor(url, this.#rules())
    const link = appLinkFor(url, this.#rules())
    if (!hit || !link || !this.#deps.installed(link.scheme)) return null
    return { key: hit.rule.key, app: link.app, openUrl: link.openUrl }
  }

  current(tabId: string): SiteSuggestion | null {
    const url = this.#deps.tabUrl(tabId)
    if (!url) return null
    const host = suggestionHost(url)
    if (!host || this.#dismissed.get(tabId) === host) return null
    if (!suggestionsAllowed(url, this.#settings, this.#now(), this.#deps.excluded)) return null
    const link = this.appLink(url)
    let match: SiteMatch | null
    try {
      match = matchSite(url, { connectors: this.#deps.connectors(), directory: this.#deps.directory(), appLink: link ? { key: link.key, app: link.app } : null })
    } catch {
      // The connector list can be unavailable for a moment (still loading); the app link still counts.
      match = link ? { kind: 'app-link', key: link.key, app: link.app } : null
    }
    if (!match) return null
    const base = { tabId, origin: new URL(url).origin, tasks: tasksFor(match) }
    if (match.kind === 'connector') return { ...base, kind: 'connector', connectorId: match.connectorId, name: match.name }
    if (match.kind === 'directory') return { ...base, kind: 'connector', directoryId: match.directoryId, name: match.name }
    return { ...base, kind: 'app-link', app: match.app, name: match.app }
  }

  /** Re-checks a tab after it navigated or the settings changed; tells the chrome only when the answer differs. */
  refresh(tabId: string): void {
    const url = this.#deps.tabUrl(tabId)
    const host = url ? suggestionHost(url) : null
    // "Not now" lasts until the tab leaves that site.
    if (this.#dismissed.has(tabId) && this.#dismissed.get(tabId) !== host) this.#dismissed.delete(tabId)
    const suggestion = this.current(tabId)
    const key = JSON.stringify(suggestion)
    if (this.#last.get(tabId) === key) return
    this.#last.set(tabId, key)
    this.#deps.broadcast({ type: 'site-suggestion', tabId, suggestion })
  }

  forget(tabId: string): void {
    this.#dismissed.delete(tabId)
    this.#last.delete(tabId)
  }

  #refreshAll(): void {
    for (const tabId of [...this.#last.keys()]) this.refresh(tabId)
  }

  settings(): SiteSuggestionSettings {
    return { ...this.#settings, offSites: [...this.#settings.offSites] }
  }

  update(patch: Partial<SiteSuggestionSettings>): SiteSuggestionSettings {
    const offSites = patch.offSites ? [...new Set(patch.offSites.map((s) => s.trim().toLowerCase().replace(/^www\./, '')).filter(Boolean))] : this.#settings.offSites
    this.#settings = {
      enabled: patch.enabled ?? this.#settings.enabled,
      offSites,
      snoozedUntil: patch.snoozedUntil === undefined ? this.#settings.snoozedUntil : patch.snoozedUntil,
    }
    this.#save()
    this.#refreshAll()
    return this.settings()
  }

  dismiss(tabId: string, scope: 'once' | 'site' | 'everywhere' | { snoozeUntil: number }): void {
    const url = this.#deps.tabUrl(tabId)
    const host = url ? suggestionHost(url) : null
    if (scope === 'once') {
      if (host) this.#dismissed.set(tabId, host)
      this.refresh(tabId)
      return
    }
    if (scope === 'site') {
      if (host) this.update({ offSites: [...this.#settings.offSites, host] })
    } else if (scope === 'everywhere') this.update({ enabled: false })
    else this.update({ snoozedUntil: scope.snoozeUntil })
    this.refresh(tabId)
  }

  draft(tabId: string, taskId: string, target: { chatId: string } | 'new'): string {
    const suggestion = this.current(tabId)
    if (!suggestion) throw new Error(mainT('platform.suggestion.gone'))
    if (!suggestion.tasks.some((t) => t.id === taskId)) throw new Error(mainT('platform.suggestion.taskGone'))
    if (target === 'new') return this.#deps.newChat()
    if (!this.#deps.chatExists(target.chatId)) throw new Error(mainT('platform.suggestion.chatGone'))
    return target.chatId
  }

  openInApp(tabId: string): boolean {
    const url = this.#deps.tabUrl(tabId)
    const link = url ? this.appLink(url) : null
    if (!link) return false
    this.#deps.openExternal(link.openUrl)
    return true
  }
}
