/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { emptyTree, flattenLinks } from '@shared/bookmarks'
import { t, type MessageKey } from '@shared/i18n/core'
import { OMNIBOX_GROUPS, frecency, matchRanges, textScore, typedForm, type OmniboxProvider, type OmniboxRow, type UniversalFilter } from '@shared/omnibox'
import { resolveEngine, engineSearchUrl, type SearchEngineDef } from '@shared/searchEngines'
import { SETTINGS_INDEX, settingsRowUrl } from '@shared/settingsIndex'
import { HOLD_PREFIX, SHORTCUTS, formatKeys } from '@shared/shortcuts'
import { INTERNAL_PAGES, SETTINGS_PAGES, chatUrl, internalPageTitle, isInternalUrl, looksLikeAddress, omniboxToUrl, parseInternalUrl, settingsPageTitle } from '@shared/url'
import type { BookmarkStore } from './bookmarks'
import type { ChatStore } from './chats'
import type { CommandRegistry } from './commands'
import type { WindowContext } from './features/types'
import type { HistoryStore } from './history'
import type { SettingsStore } from './settings'

// The built-in command-bar groups (SH-35): what you typed, top hits, the
// ask row, engine suggestions, open tabs, bookmarks, history, commands and
// settings. Each is a provider like any other; omnibox.query merges
// and dedupes them. Universal search reuses the tab, chat, page and
// command rows over every window.

export interface AddressSources {
  settings: SettingsStore
  history(): HistoryStore | null
  bookmarks(): BookmarkStore | null
  windows(): readonly WindowContext[]
  chats(): ChatStore | null
  commands: CommandRegistry
  suggest(text: string, signal: AbortSignal): Promise<string[]>
  platform: string
  now?(): number
}

/** Atelier pages a person might type the name of. */
const PAGE_IDS = ['chats', 'routines', 'skills', 'connectors', 'history', 'bookmarks', 'downloads', 'settings', 'first-week', 'meetings', 'passwords', /* docs/packs.md */ 'packs'] as const

const ICON = { search: 'search', globe: 'globe', history: 'history', bookmark: 'bookmark', tab: 'tab', command: 'command', settings: 'settings', ask: 'ask', chat: 'chat', page: 'page' } as const

function engineOf(settings: SettingsStore): SearchEngineDef {
  const s = settings.get()
  return resolveEngine(s.searchEngine, s.customSearchEngines)
}

/** A favicon address the chrome may show (the page's own, http(s) only). */
function favicon(url: string | null | undefined, fallback: string): string {
  return url && /^https?:\/\//i.test(url) && url.length <= 2048 ? url : fallback
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return typedForm(url)
  }
}

interface OpenTab {
  tabId: string
  windowId: number
  title: string
  url: string
  pinned: boolean
  favicon: string | null
  lastActiveAt: number
}

function openTabs(sources: AddressSources): OpenTab[] {
  const out: OpenTab[] = []
  for (const win of sources.windows()) {
    for (const tab of win.tabs.all()) {
      const info = win.tabs.info(tab)
      out.push({ tabId: tab.id, windowId: win.id, title: info.title, url: info.url, pinned: info.pinned, favicon: info.favicon, lastActiveAt: info.lastActiveAt })
    }
  }
  return out
}

function tabRow(tab: OpenTab, query: string, group: string, currentWindow: number): OmniboxRow {
  const other = tab.windowId !== currentWindow
  return {
    id: `${group}:tab:${tab.tabId}`,
    group,
    title: tab.title || tab.url,
    subtitle: other ? t('address.row.tabOtherWindow', { host: hostOf(tab.url) }) : t('address.row.switchToTab', { host: isInternalUrl(tab.url) ? BRAND_NAME : hostOf(tab.url) }),
    icon: favicon(tab.favicon, ICON.tab),
    match: query ? matchRanges(tab.title || tab.url, query) : [],
    action: { kind: 'switch-tab', tabId: tab.tabId },
    url: tab.url,
    pinned: tab.pinned,
  }
}

/** Other words people use for a page: the Packs page is where apps, games and worlds come from. */
const PAGE_WORDS: Partial<Record<string, readonly string[]>> = { packs: ['apps', 'games', 'worlds', 'extensions', 'add-ons'] }

function pageRows(query: string, group: string): OmniboxRow[] {
  const q = query.trim().toLowerCase()
  const alias = (id: string): number => (q.length >= 3 && (PAGE_WORDS[id] ?? []).some((w) => w.startsWith(q)) ? 50 : 0)
  return PAGE_IDS.filter((id) => Object.hasOwn(INTERNAL_PAGES, id))
    .map((id) => ({ id, title: internalPageTitle(id) }))
    .map((p) => ({ p, score: q ? Math.max(textScore(p.title, `atelier://${p.id}`, q), alias(p.id)) : 1 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ p }) => ({ id: `${group}:page:${p.id}`, group, title: p.title, subtitle: `atelier://${p.id}`, icon: ICON.page, match: q ? matchRanges(p.title, q) : [], action: { kind: 'open-internal', url: `atelier://${p.id}` }, url: `atelier://${p.id}` }))
}

function commandRows(sources: AddressSources, query: string, group: string): OmniboxRow[] {
  const q = query.trim()
  if (!q) return []
  return SHORTCUTS.filter((def) => !def.accelerator.startsWith(HOLD_PREFIX) && sources.commands.has(def.id))
    .map((def) => ({ def, title: t(def.label) }))
    .map((x) => ({ ...x, score: textScore(x.title, '', q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ def, title }) => ({ id: `${group}:command:${def.id}`, group, title, subtitle: formatKeys(def, sources.platform).join(sources.platform === 'darwin' ? '' : '+'), icon: ICON.command, match: matchRanges(title, q), action: { kind: 'command', id: def.id } }))
}

export function createAddressProviders(sources: AddressSources): OmniboxProvider[] {
  const now = (): number => sources.now?.() ?? Date.now()

  const typed: OmniboxProvider = {
    id: 'address.typed',
    group: OMNIBOX_GROUPS.typed,
    order: 10,
    maxRows: 2,
    async query(text) {
      const input = text.trim()
      if (!input) return []
      const engine = engineOf(sources.settings)
      const search: OmniboxRow = {
        id: 'typed:search',
        group: OMNIBOX_GROUPS.typed,
        title: input,
        subtitle: t('address.row.searchWith', { engine: engine.name }),
        icon: ICON.search,
        action: { kind: 'navigate', url: engineSearchUrl(engine, input) },
      }
      if (!looksLikeAddress(input)) return [search]
      const url = omniboxToUrl(input, engine)
      const internal = parseInternalUrl(url) !== null
      const open: OmniboxRow = {
        id: 'typed:open',
        group: OMNIBOX_GROUPS.typed,
        title: internal ? url : typedForm(url),
        subtitle: t('address.row.open'),
        icon: internal ? ICON.page : ICON.globe,
        action: internal ? { kind: 'open-internal', url } : { kind: 'navigate', url },
        url,
      }
      return [open, search]
    },
  }

  const top: OmniboxProvider = {
    id: 'address.top',
    group: OMNIBOX_GROUPS.top,
    order: 20,
    maxRows: 3,
    async query(text, ctx) {
      const q = text.trim()
      if (!q) return []
      const tabsByUrl = new Map(openTabs(sources).map((tab) => [tab.url, tab]))
      const scored: Array<{ row: OmniboxRow; score: number }> = []
      for (const entry of sources.history()?.entries() ?? []) {
        const match = textScore(entry.title, entry.url, q)
        // Only prefixes and word starts are strong enough to be a top hit.
        if (match < 45) continue
        const tab = tabsByUrl.get(entry.url)
        const title = entry.title || typedForm(entry.url)
        scored.push({
          score: frecency(entry, match, now()),
          row: tab ? { ...tabRow(tab, q, OMNIBOX_GROUPS.top, ctx.windowId), id: `top:${entry.url}` } : { id: `top:${entry.url}`, group: OMNIBOX_GROUPS.top, title, subtitle: typedForm(entry.url), icon: ICON.history, match: matchRanges(title, q), action: { kind: 'navigate', url: entry.url }, url: entry.url },
        })
      }
      for (const b of flattenLinks(sources.bookmarks()?.tree() ?? emptyTree())) {
        const match = textScore(b.title, b.url, q)
        if (match < 45) continue
        scored.push({ score: match + 20, row: { id: `top:${b.url}`, group: OMNIBOX_GROUPS.top, title: b.title, subtitle: typedForm(b.url), icon: favicon(b.favicon, ICON.bookmark), match: matchRanges(b.title, q), action: { kind: 'navigate', url: b.url }, url: b.url } })
      }
      const best = new Map<string, { row: OmniboxRow; score: number }>()
      for (const s of scored) {
        const key = typedForm(s.row.url ?? '').toLowerCase()
        const prev = best.get(key)
        if (!prev || prev.score < s.score) best.set(key, s)
      }
      return [...best.values()].sort((a, b) => b.score - a.score).map((s) => s.row)
    },
  }

  const ask: OmniboxProvider = {
    id: 'address.ask',
    group: OMNIBOX_GROUPS.ask,
    order: 30,
    maxRows: 1,
    async query(text) {
      const input = text.trim()
      // The chrome names the companion; main only knows the question.
      return input ? [{ id: 'ask', group: OMNIBOX_GROUPS.ask, title: input, icon: ICON.ask, action: { kind: 'ask', text: input } }] : []
    },
  }

  const suggest: OmniboxProvider = {
    id: 'address.suggest',
    group: OMNIBOX_GROUPS.suggest,
    order: 40,
    maxRows: 4,
    async query(text, ctx) {
      const list = await sources.suggest(text, ctx.signal)
      const engine = engineOf(sources.settings)
      return list.map((s) => ({ id: `suggest:${s}`, group: OMNIBOX_GROUPS.suggest, title: s, icon: ICON.search, match: matchRanges(s, text), action: { kind: 'navigate', url: engineSearchUrl(engine, s) } }))
    },
  }

  const tabs: OmniboxProvider = {
    id: 'address.tabs',
    group: OMNIBOX_GROUPS.tabs,
    order: 50,
    maxRows: 4,
    async query(text, ctx) {
      const q = text.trim()
      if (!q) return []
      return openTabs(sources)
        .map((tab) => ({ tab, score: textScore(tab.title, tab.url, q) }))
        .filter((x) => x.score > 0)
        // Pinned tabs rank higher, then the better match, then the more recent.
        .sort((a, b) => Number(b.tab.pinned) - Number(a.tab.pinned) || b.score - a.score || b.tab.lastActiveAt - a.tab.lastActiveAt)
        .map(({ tab }) => tabRow(tab, q, OMNIBOX_GROUPS.tabs, ctx.windowId))
    },
  }

  const bookmarks: OmniboxProvider = {
    id: 'address.bookmarks',
    group: OMNIBOX_GROUPS.bookmarks,
    order: 60,
    maxRows: 4,
    async query(text) {
      const q = text.trim()
      const store = sources.bookmarks()
      if (!q || !store) return []
      return flattenLinks(store.tree())
        .map((b) => ({ b, score: textScore(b.title, b.url, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ b }) => ({ id: `bookmarks:${b.id}`, group: OMNIBOX_GROUPS.bookmarks, title: b.title, subtitle: typedForm(b.url), icon: favicon(b.favicon, ICON.bookmark), match: matchRanges(b.title, q), action: { kind: 'navigate', url: b.url }, url: b.url }))
    },
  }

  const history: OmniboxProvider = {
    id: 'address.history',
    group: OMNIBOX_GROUPS.history,
    order: 70,
    maxRows: 5,
    async query(text) {
      const q = text.trim()
      const store = sources.history()
      if (!q || !store) return []
      const at = now()
      const rows: Array<{ row: OmniboxRow; score: number }> = []
      for (const entry of store.entries()) {
        const match = textScore(entry.title, entry.url, q)
        if (match === 0) continue
        const title = entry.title || typedForm(entry.url)
        rows.push({ score: frecency(entry, match, at), row: { id: `history:${entry.url}`, group: OMNIBOX_GROUPS.history, title, subtitle: typedForm(entry.url), icon: ICON.history, match: matchRanges(title, q), action: { kind: 'navigate', url: entry.url }, url: entry.url, removable: true } })
      }
      return rows.sort((a, b) => b.score - a.score).map((r) => r.row)
    },
  }

  const commands: OmniboxProvider = {
    id: 'address.commands',
    group: OMNIBOX_GROUPS.commands,
    order: 80,
    maxRows: 4,
    async query(text) {
      const q = text.trim()
      if (!q) return []
      return [...pageRows(q, OMNIBOX_GROUPS.commands), ...commandRows(sources, q, OMNIBOX_GROUPS.commands)]
    },
  }

  const settings: OmniboxProvider = {
    id: 'address.settings',
    group: OMNIBOX_GROUPS.settings,
    order: 90,
    maxRows: 3,
    async query(text) {
      const q = text.trim()
      if (q.length < 2) return []
      const rows: Array<{ row: OmniboxRow; score: number }> = []
      for (const entry of SETTINGS_INDEX) {
        const title = t(entry.title as MessageKey)
        const score = Math.max(textScore(title, '', q), ...entry.keywords.map((k) => (textScore(k, '', q) > 0 ? 30 : 0)))
        if (score === 0) continue
        const page = settingsPageTitle(entry.page)
        rows.push({ score, row: { id: `settings:${entry.id}`, group: OMNIBOX_GROUPS.settings, title, subtitle: t('address.row.inSettings', { page }), icon: ICON.settings, match: matchRanges(title, q), action: { kind: 'open-internal', url: settingsRowUrl(entry) }, url: settingsRowUrl(entry) } })
      }
      for (const page of SETTINGS_PAGES) {
        const title = settingsPageTitle(page.id)
        const score = textScore(title, '', q)
        if (score === 0) continue
        const url = `atelier://settings/${page.id}`
        rows.push({ score: score - 5, row: { id: `settings:page:${page.id}`, group: OMNIBOX_GROUPS.settings, title, subtitle: t('address.row.settingsPage'), icon: ICON.settings, match: matchRanges(title, q), action: { kind: 'open-internal', url }, url } })
      }
      return rows.sort((a, b) => b.score - a.score).map((r) => r.row)
    },
  }

  return [typed, top, ask, suggest, tabs, bookmarks, history, commands, settings]
}

/**
 * Universal search: tabs from every window (most recent first), chats,
 * Atelier pages and commands. With no text it lists recent tabs and chats.
 */
export function universalSearch(sources: AddressSources, text: string, filter: UniversalFilter, windowId: number): Array<{ group: string; rows: OmniboxRow[] }> {
  const q = text.trim()
  const groups: Array<{ group: string; rows: OmniboxRow[] }> = []
  if (filter === 'all' || filter === 'tabs') {
    const tabs = openTabs(sources)
      .filter((tab) => !q || textScore(tab.title, tab.url, q) > 0)
      .sort((a, b) => (q ? textScore(b.title, b.url, q) - textScore(a.title, a.url, q) : 0) || b.lastActiveAt - a.lastActiveAt)
      .slice(0, 30)
      .map((tab) => tabRow(tab, q, OMNIBOX_GROUPS.tabs, windowId))
    if (tabs.length) groups.push({ group: OMNIBOX_GROUPS.tabs, rows: tabs })
  }
  if (filter === 'all' || filter === 'chats') {
    const store = sources.chats()
    const list = store ? store.query({ ...(q ? { query: q, sort: 'best-match' as const } : {}), limit: 20 }) : []
    const open = new Map(openTabs(sources).filter((tab) => parseInternalUrl(tab.url)?.page === 'chat').map((tab) => [parseInternalUrl(tab.url)?.id ?? '', tab]))
    const rows = list.map((chat): OmniboxRow => {
      const tab = open.get(chat.id)
      const title = chat.title || t('address.row.untitledChat')
      return {
        id: `chats:${chat.id}`,
        group: OMNIBOX_GROUPS.chats,
        title,
        subtitle: tab ? t('address.row.openChat') : undefined,
        icon: ICON.chat,
        match: q ? matchRanges(title, q) : [],
        action: tab ? { kind: 'switch-tab', tabId: tab.tabId } : { kind: 'open-internal', url: chatUrl(chat.id) },
        url: chatUrl(chat.id),
      }
    })
    if (rows.length) groups.push({ group: OMNIBOX_GROUPS.chats, rows })
  }
  if (filter === 'all' || filter === 'pages') {
    const rows = [...pageRows(q, OMNIBOX_GROUPS.pages), ...commandRows(sources, q, OMNIBOX_GROUPS.pages)].slice(0, 12)
    if (rows.length) groups.push({ group: OMNIBOX_GROUPS.pages, rows })
  }
  return groups
}
