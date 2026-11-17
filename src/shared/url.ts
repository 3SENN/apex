/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from './branding'
import { firstWeekGuideTitle, guideById } from './firstWeek'
import { t, type MessageKey } from './i18n/core'
import { resolveEngine, engineSearchUrl } from './searchEngines'
import { LIBRARY_FILES_URL, parseFileViewerUrl, type ViewerTarget } from './files'
import { APEX_APP_SCHEME } from './apps'
import { WORKSPACE_SECTIONS, type WorkspaceSection } from './workspace'

const USER_SCHEMES = new Set(['http:', 'https:', 'file:'])
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?([/?#].*)?$/i
const IPV4_HOST = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}(:\d+)?([/?#].*)?$/
// mDNS names on the local network (printer.local, nas.local:5000).
const DOT_LOCAL = /^[^\s/?#:]+\.local\.?(:\d+)?([/?#].*)?$/i
const DOMAIN_LIKE = /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i

/** A search engine id (built in or custom), or a resolved engine's template. */
export type EngineRef = string | { template: string }

/** The engine's results page for a query; an unknown id falls back to the first built-in engine. */
export function searchUrl(query: string, engine: EngineRef): string {
  return engineSearchUrl(typeof engine === 'string' ? resolveEngine(engine) : engine, query)
}

/** A private or link-local IPv4 address: typed ones get http, like localhost. */
function isLanIpv4(text: string): boolean {
  const m = IPV4_HOST.exec(text)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/** Whether typed text names a page rather than a search (the command bar's "what you typed" row). */
export function looksLikeAddress(input: string): boolean {
  const text = input.trim()
  if (!text || /\s/.test(text)) return false
  if (text === 'about:blank' || parseInternalUrl(text)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^\s:]+:\d+/.test(text)) return USER_SCHEMES.has(tryParse(text)?.protocol ?? '')
  return LOCAL_HOST.test(text) || IPV4_HOST.test(text) || DOT_LOCAL.test(text) || DOMAIN_LIKE.test(text)
}

/**
 * Turns what the user typed in the omnibox into a URL to load. Typed hosts
 * get https; localhost, LAN addresses and .local names get http.
 */
export function omniboxToUrl(input: string, engine: EngineRef): string {
  const text = input.trim()
  if (text === '') return 'about:blank'
  if (text === 'about:blank') return text
  if (parseInternalUrl(text)) return text

  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^\s:]+:\d+/.test(text)) {
    const parsed = tryParse(text)
    if (parsed && USER_SCHEMES.has(parsed.protocol)) return parsed.href
    return searchUrl(text, engine)
  }
  if (/\s/.test(text)) return searchUrl(text, engine)
  if (LOCAL_HOST.test(text) || isLanIpv4(text) || DOT_LOCAL.test(text)) return tryParse(`http://${text}`)?.href ?? searchUrl(text, engine)
  if (IPV4_HOST.test(text) || DOMAIN_LIKE.test(text)) return tryParse(`https://${text}`)?.href ?? searchUrl(text, engine)
  return searchUrl(text, engine)
}

export type AgentNavigation =
  | { kind: 'history'; action: 'back' | 'forward' | 'reload' }
  | { kind: 'url'; url: string }

/**
 * Validates a browser-tool `navigate` target. Per the toolset spec, a URL
 * without a scheme is https, and anything other than http(s) is refused.
 */
export function parseAgentNavigation(raw: string): AgentNavigation {
  const text = raw.trim()
  if (text === 'back' || text === 'forward' || text === 'reload') return { kind: 'history', action: text }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^\s:]+:\d+/.test(text) ? text : `https://${text}`
  const parsed = tryParse(withScheme)
  if (!parsed) throw new Error(`"${raw}" is not a valid URL.`)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Navigation to ${parsed.protocol} URLs is not allowed; only http and https are.`)
  }
  return { kind: 'url', url: parsed.href }
}

export function isBlankUrl(url: string): boolean {
  return url === '' || url === 'about:blank'
}

/**
 * scheme://host[:port] of any URL with a host, or null. Unlike URL.origin it
 * works for Apex's own schemes (app://apex), whose WHATWG origin is "null"
 * (as are data: and blob: ones), so the chrome's navigation guards compare
 * real values instead of letting every "null" match.
 */
export function uiOriginOf(url: string): string | null {
  const parsed = tryParse(url)
  if (!parsed || parsed.host === '') return null
  return `${parsed.protocol}//${parsed.host}`.toLowerCase()
}

/**
 * Whether two addresses show the same page, for a chat link that goes to the
 * tab already showing it: the same scheme, host and path (a trailing slash
 * aside) and query; the #fragment doesn't count. Only http and https.
 */
export function samePage(a: string, b: string): boolean {
  const key = (u: string): string | null => {
    const parsed = tryParse(u)
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null
    const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`
  }
  const ka = key(a)
  return ka !== null && ka === key(b)
}

export function originOf(url: string): string {
  const parsed = tryParse(url)
  if (!parsed || parsed.origin === 'null') return url
  return parsed.origin
}

function tryParse(text: string): URL | null {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

/** Pages the chrome renders itself, addressed as apex://<page>[/...]. The titles are stable: tabs and breadcrumbs use them. */
export const INTERNAL_PAGES: Record<string, string> = {
  chats: 'All chats',
  chat: 'Chat',
  routines: 'Routines',
  skills: 'Skills',
  connectors: 'Connectors',
  companion: 'Companion',
  library: 'Library',
  history: 'History',
  bookmarks: 'Bookmarks',
  downloads: 'Downloads',
  settings: 'Settings',
  welcome: `Welcome to ${BRAND_NAME}`,
  /** The getting-started plan; apex://first-week/<guide> shows one of its guides. */
  'first-week': 'Getting started',
  /** apex://view-source?url=<encoded>. */
  'view-source': 'Page source',
  /** apex://file?src=<base64url ViewerTarget>[&edit=1]: the file viewer (OV-32; see shared/files.ts). */
  file: 'File',
  /** apex://files: the Files destination's short address; it resolves to apex://library/files. */
  files: 'Files',
  /** apex://workspace[/<section>[/<id>]]. */
  workspace: 'Workspace',
  /** apex://guides[/<id>] (SH-07). */
  guides: 'Guides',
  /** apex://presets[/<id>]: the preset companion gallery and a preset's profile. */
  presets: 'Companion presets',
  /** apex://flags: in no nav. */
  flags: 'Experiments',
  /** The log viewer, from Help › Show Logs and About. */
  logs: 'Logs',
  // Queries are read by the pages: passwords?site=<host>, meetings?filter=recordings&q=<text>
  passwords: 'Passwords',
  /** apex://meetings/<uuid> shows one meeting. */
  meetings: 'Meetings',
  // ── tweaks page ── (TWK-05: apex://tweaks[?site=<host>])
  tweaks: 'Tweaks',
  // ── packs page ── (docs/packs.md: apex://packs[?pack=<id>|?draft=<id>[&review=1]|?tab=browse|?install=<url>])
  packs: 'Packs',
}

/** Each internal page's title in the catalogue: tabs, breadcrumbs and the omnibox show these in the app language. */
const INTERNAL_PAGE_KEYS: Record<string, MessageKey> = {
  chats: 'tabs.page.chats',
  chat: 'tabs.page.chat',
  routines: 'tabs.page.routines',
  skills: 'tabs.page.skills',
  connectors: 'tabs.page.connectors',
  companion: 'tabs.page.companion',
  library: 'tabs.page.library',
  history: 'tabs.page.history',
  bookmarks: 'tabs.page.bookmarks',
  downloads: 'tabs.page.downloads',
  settings: 'tabs.page.settings',
  welcome: 'tabs.page.welcome',
  'first-week': 'tabs.page.firstWeek',
  'view-source': 'tabs.page.viewSource',
  file: 'tabs.page.file',
  files: 'tabs.page.files',
  workspace: 'tabs.page.workspace',
  guides: 'tabs.page.guides',
  presets: 'tabs.page.presets',
  flags: 'tabs.page.flags',
  logs: 'tabs.page.logs',
  passwords: 'tabs.page.passwords',
  meetings: 'tabs.page.meetings',
  tweaks: 'tweaks.page.title', // TWK-05
  packs: 'packs.page.title', // docs/packs.md
}

/** An internal page's title in the app language; Apex for a page it doesn't know. */
export function internalPageTitle(page: string): string {
  return Object.hasOwn(INTERNAL_PAGE_KEYS, page) ? t(INTERNAL_PAGE_KEYS[page] as MessageKey) : BRAND_NAME
}

/**
 * Sidebar destination rows, top to bottom (DS-06). Each opens apex://<id> on
 * the window-level destination surface (DS-99), never as a tab.
 */
export const DESTINATIONS = ['chats', 'routines', 'connectors', 'skills', 'meetings', 'workspace', 'guides', /* In the overflow by default */ 'files', /* AP-02: the packs you added, in the overflow by default */ 'packs'] as const
export type Destination = (typeof DESTINATIONS)[number]

/** Whether an apex:// address belongs on the destination surface rather than in a tab. */
export function isDestinationUrl(url: string): boolean {
  return destinationOf(url) !== null
}

/** The destination an address shows, if any. Library › Files (apex://library/files) is the `files` destination. */
export function destinationOf(url: string): Destination | null {
  const route = parseInternalUrl(url)
  if (!route) return null
  if (route.page === 'library' && route.section === 'files') return 'files'
  if (route.page === 'files') return null
  return (DESTINATIONS as readonly string[]).includes(route.page) ? (route.page as Destination) : null
}

/** Settings pages in nav order. apex://settings lands on the first one. */
export const SETTINGS_PAGES = [
  { id: 'you', title: 'You' },
  // ST-37 to ST-39
  { id: 'profiles', title: 'Profiles' },
  { id: 'companions', title: 'Companions' },
  // ST-09
  { id: 'dock-icon', title: 'Dock icon' },
  { id: 'model', title: 'Model and key' },
  // docs/decisions.md
  { id: 'decisions', title: 'Quick decisions' },
  { id: 'permissions', title: 'Agent permissions' },
  { id: 'voice', title: 'Voice' },
  { id: 'transcription', title: 'Transcription' },
  { id: 'general', title: 'General' },
  { id: 'appearance', title: 'Appearance' },
  { id: 'search', title: 'Search' },
  // ST-32 to ST-34
  { id: 'languages', title: 'Languages' },
  { id: 'default-browser', title: 'Default browser' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'privacy', title: 'Privacy' },
  // ST-40
  { id: 'extensions', title: 'Extensions and packs' },
  { id: 'passwords', title: 'Passwords and autofill' },
  { id: 'downloads', title: 'Downloads' },
  { id: 'import', title: 'Import' },
  { id: 'memory', title: 'Memory' },
  { id: 'activity', title: 'Activity memory' },
  // ST-53 to ST-55
  { id: 'storage', title: 'Storage' },
  { id: 'about', title: `About ${BRAND_NAME}` },
] as const

/** Each settings page's title in the catalogue; `title` above is the English the rest of the address code reads. */
const SETTINGS_PAGE_KEYS: Record<(typeof SETTINGS_PAGES)[number]['id'], MessageKey> = {
  you: 'settings.nav.page.you',
  profiles: 'settings.nav.page.profiles',
  companions: 'settings.nav.page.companions',
  'dock-icon': 'settings.nav.page.dockIcon',
  model: 'settings.nav.page.model',
  decisions: 'settings.nav.page.decisions',
  permissions: 'settings.nav.page.permissions',
  voice: 'settings.nav.page.voice',
  transcription: 'settings.nav.page.transcription',
  general: 'settings.nav.page.general',
  appearance: 'settings.nav.page.appearance',
  search: 'settings.nav.page.search',
  languages: 'settings.nav.page.languages',
  'default-browser': 'settings.nav.page.defaultBrowser',
  notifications: 'settings.nav.page.notifications',
  privacy: 'settings.nav.page.privacy',
  extensions: 'settings.nav.page.extensions',
  passwords: 'settings.nav.page.passwords',
  downloads: 'settings.nav.page.downloads',
  import: 'settings.nav.page.import',
  memory: 'settings.nav.page.memory',
  activity: 'settings.nav.page.activity',
  storage: 'settings.nav.page.storage',
  about: 'settings.nav.page.about',
}

/** A settings page's title in the app language (the nav, the omnibox); Settings for an unknown page. */
export function settingsPageTitle(id: string): string {
  return Object.hasOwn(SETTINGS_PAGE_KEYS, id) ? t(SETTINGS_PAGE_KEYS[id as keyof typeof SETTINGS_PAGE_KEYS]) : t('settings.nav.title')
}

/** Companion card sections, in tab order (apex://companion/<id>/<section>). */
export const COMPANION_SECTIONS = ['general', 'skills', 'routines', 'files', 'memory', 'models'] as const

// Old addresses and the page that now holds them. Library sections moved to
// their own destinations, and shared memory moved to Settings.
const LIBRARY_REDIRECTS: Record<string, string> = {
  chats: 'apex://chats',
  skills: 'apex://skills',
  routines: 'apex://routines',
  connectors: 'apex://connectors',
  memory: 'apex://settings/memory',
  // Library › Files stays in the library.
  files: 'apex://library/files',
}
/** Settings sections that are not nav pages, and the nav page they sit under: apex://settings/sites is the site settings page. */
export const SETTINGS_ALIAS_PARENTS: Record<string, string> = {
  sites: 'privacy',
  // Every permission in one place: this Mac's and the websites' (settings/permissions/PermissionsHubPage).
  access: 'privacy',
}
/** Old or alternative names for a settings page (ST-03); the address is rewritten to the page. */
export const SETTINGS_PAGE_ALIASES: Record<string, string> = {
  account: 'you',
  dock: 'dock-icon',
  key: 'model',
  'api-key': 'model',
  engine: 'model',
  'agent-permissions': 'permissions',
  layout: 'appearance',
  display: 'appearance',
  zoom: 'appearance',
  'search-engine': 'search',
  language: 'languages',
  spellcheck: 'languages',
  'default': 'default-browser',
  'default-apps': 'default-browser',
  notification: 'notifications',
  security: 'privacy',
  'privacy-and-security': 'privacy',
  'clear-data': 'privacy',
  cookies: 'privacy',
  data: 'storage',
  space: 'storage',
  reset: 'storage',
  'import-data': 'import',
  version: 'about',
  licenses: 'about',
}

const SETTINGS_REDIRECTS: Record<string, string> = {
  agent: 'apex://settings/model',
  theme: 'apex://settings/appearance',
  connectors: 'apex://connectors',
}

export interface InternalRoute {
  page: string
  /** A sub-page: a settings page, a library section or a companion card section. */
  section: string | null
  /** The record the page is about: chat/<id>, companion/<id>, routines/<id>, skills/<id>, connectors/<id>. */
  id: string | null
  /** One item inside a companion card section: companion/<id>/<section>/<item>. */
  item: string | null
}

// Pages whose first path part is a record id rather than a section.
const ID_PAGES = new Set(['chat', 'companion', 'routines', 'skills', 'connectors', 'meetings', 'guides', 'presets'])
const REQUIRES_ID = new Set(['chat', 'companion'])
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const SAFE_SECTION = /^[a-z0-9-]{1,64}$/

export function isInternalUrl(url: string): boolean {
  return url.startsWith('apex://')
}

/**
 * Compatibility: pages that were renamed, by their old name, so saved tabs,
 * history and bookmarks still open them; resolveInternalUrl gives the new address.
 */
const RENAMED_PAGES: Record<string, string> = {
  boosts: 'tweaks', // compatibility: apex://boosts before the rename
}

/** An apex:// address with a renamed page's old name swapped for its new one; any other as it is. */
function renamedPage(url: string): string {
  const name = /^apex:\/\/([a-z-]+)(?=[/?#]|$)/.exec(url)?.[1]
  return name && Object.hasOwn(RENAMED_PAGES, name) ? `apex://${RENAMED_PAGES[name]}${url.slice('apex://'.length + name.length)}` : url
}

/**
 * Parses apex://page[/id][/section][/item]. Returns null for unknown pages and
 * for ids or sections outside a safe character set, so a crafted address can
 * never reach a store lookup or a file path. Query and fragment are ignored.
 */
export function parseInternalUrl(url: string): InternalRoute | null {
  if (!isInternalUrl(url)) return null
  const path = renamedPage(url).slice('apex://'.length).split(/[?#]/)[0] ?? ''
  const parts = path.split('/')
  // Tolerate one trailing slash, nothing else empty.
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  const [page = '', ...rest] = parts
  if (!Object.hasOwn(INTERNAL_PAGES, page) || rest.some((p) => p === '')) return null
  if (ID_PAGES.has(page)) {
    const [id = null, section = null, item = null] = rest
    if (rest.length > (page === 'companion' ? 3 : /* routines/<id>/edit */ page === 'routines' ? 2 : 1)) return null
    if (page === 'routines' && section !== null && section !== 'edit') return null
    if (REQUIRES_ID.has(page) && !id) return null
    if (id !== null && !SAFE_ID.test(id)) return null
    if (section !== null && !SAFE_SECTION.test(section)) return null
    if (item !== null && !SAFE_ID.test(item)) return null
    return { page, section, id, item }
  }
  // Apex://workspace/<section>/<id>
  if (page === 'workspace') {
    const [section = null, id = null] = rest
    if (rest.length > 2 || (section !== null && !(WORKSPACE_SECTIONS as readonly string[]).includes(section))) return null
    if (id !== null && !SAFE_ID.test(id)) return null
    return { page, section, id, item: null }
  }
  if (rest.length > 1) return null
  const section = rest[0] ?? null
  if (section !== null && !SAFE_SECTION.test(section)) return null
  return { page, section, id: null, item: null }
}

/**
 * The canonical address for an apex:// URL: library sections redirect to
 * their destination, apex://settings to its first page, and old settings
 * names to the page that now holds them, and a renamed page's old name to its
 * new one. Returns null for unknown pages.
 */
export function resolveInternalUrl(url: string): string | null {
  const renamed = renamedPage(url)
  if (renamed !== url) return resolveInternalUrl(renamed)
  const route = parseInternalUrl(url)
  if (!route) return null
  if (route.page === 'library') {
    const target = LIBRARY_REDIRECTS[route.section ?? 'chats'] ?? 'apex://chats'
    // DS-115: Library › Files keeps its filter (?companion=<id>).
    const companion = route.section === 'files' ? internalQuery(url, 'companion') : null
    return companion && SAFE_ID.test(companion) ? libraryFilesUrl(companion) : target
  }
  if (route.page === 'files') return LIBRARY_FILES_URL
  if (route.page === 'settings') {
    if (!route.section) return `apex://settings/${SETTINGS_PAGES[0].id}`
    return SETTINGS_REDIRECTS[route.section] ?? url
  }
  return url
}

/** Builds apex://chat/<id>. */
export function chatUrl(chatId: string): string {
  return `apex://chat/${chatId}`
}

/** Builds apex://library/files, narrowed to one companion's files when given (DS-115). */
export function libraryFilesUrl(companionId?: string | null): string {
  return companionId ? `apex://library/files?companion=${encodeURIComponent(companionId)}` : 'apex://library/files'
}

/** apex://companion/<id>/general/look: the card with its look editor open (the ring of bubbles around the figure). */
export const COMPANION_LOOK_ITEM = 'look'

export function companionLookUrl(companionId: string): string {
  return companionUrl(companionId, 'general', COMPANION_LOOK_ITEM)
}

/** Builds apex://companion/<id>[/<section>[/<item>]]. */
/** apex://presets, or one preset's profile at apex://presets/<id>. */
export function presetUrl(presetId?: string | null): string {
  return presetId ? `apex://presets/${encodeURIComponent(presetId)}` : 'apex://presets'
}

export function companionUrl(companionId: string, section?: string | null, item?: string | null): string {
  return `apex://companion/${companionId}${section ? `/${section}${item ? `/${item}` : ''}` : ''}`
}

/** Names main looks up for titles: a chat's title, a companion's name. */
export interface InternalNames {
  chat?: (id: string) => string | null
  companion?: (id: string) => string | null
}

/**
 * The tab title and breadcrumb for an Apex page ("Chat / <title>",
 * "Settings / <page>"). Titles never depend on load state, so the pill and
 * the window title stay put while a page renders.
 */
export function internalTitle(url: string, names: InternalNames = {}): { title: string; crumbs: string[] } {
  const route = parseInternalUrl(url)
  if (!route) return { title: BRAND_NAME, crumbs: [BRAND_NAME] }
  const pageTitle = internalPageTitle(route.page)
  switch (route.page) {
    case 'chat': {
      const title = (route.id && names.chat?.(route.id)) || t('tabs.page.newChat')
      return { title, crumbs: [pageTitle, title] }
    }
    case 'companion': {
      const name = (route.id && names.companion?.(route.id)) || pageTitle
      const section = route.section ? sectionTitle(route.section) : null
      return { title: name, crumbs: section ? [name, section] : [name] }
    }
    case 'settings': {
      // settings/companion is the look editor, which lives under Companions.
      const id = route.section === 'companion' ? 'companions' : route.section
      const page = SETTINGS_PAGES.find((p) => p.id === id)
      return { title: pageTitle, crumbs: page ? [pageTitle, settingsPageTitle(page.id)] : [pageTitle] }
    }
    case 'first-week': {
      const guide = guideById(route.section)
      const title = guide ? firstWeekGuideTitle(guide.id) : null
      return title ? { title, crumbs: [pageTitle, title] } : { title: pageTitle, crumbs: [pageTitle] }
    }
    // Library › Files; the viewer is titled by its file's name
    case 'library':
      return route.section === 'files' ? { title: internalPageTitle('files'), crumbs: [pageTitle, internalPageTitle('files')] } : { title: pageTitle, crumbs: [pageTitle] }
    case 'file': {
      const name = fileViewerName(url)
      return name ? { title: name, crumbs: [pageTitle, name] } : { title: pageTitle, crumbs: [pageTitle] }
    }
    default:
      return { title: pageTitle, crumbs: [pageTitle] }
  }
}

const COMPANION_SECTION_KEYS: Record<string, MessageKey> = {
  general: 'coCard.sections.general',
  skills: 'coCard.sections.skills',
  routines: 'coCard.sections.routines',
  files: 'coCard.sections.files',
  memory: 'coCard.sections.memory',
  models: 'coCard.sections.models',
}

function sectionTitle(section: string): string {
  if (Object.hasOwn(COMPANION_SECTION_KEYS, section)) return t(COMPANION_SECTION_KEYS[section] as MessageKey)
  return section.charAt(0).toUpperCase() + section.slice(1).replace(/-/g, ' ')
}

/** Plain http is not secure, except on this machine. */
export function isInsecureUrl(url: string): boolean {
  const parsed = tryParse(url)
  if (!parsed || parsed.protocol !== 'http:') return false
  return !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(parsed.hostname)
}

/** apex://routines/<id>, or its editor (apex://routines/<id>/edit). */
export function routineUrl(id: string, edit?: boolean): string {
  return `apex://routines/${id}${edit ? '/edit' : ''}`
}

/** apex://skills/<id>, optionally opened on one of its files (?file=<path>). */
export function skillUrl(id: string, file?: string): string {
  return `apex://skills/${id}${file ? `?file=${encodeURIComponent(file)}` : ''}`
}

/** apex://workspace/<section>[/<id>]. */
export function workspaceUrl(section: WorkspaceSection, id?: string): string {
  return `apex://workspace/${section}${id ? `/${id}` : ''}`
}

/** Where an agent-built app runs. Never an apex:// page: the agent treats it like one and refuses to act there. */
export function appRunUrl(appId: string): string {
  return `${APEX_APP_SCHEME}://${appId}/`
}

/** Whether a URL is an agent-built app (apex-app://). */
export function isAppRunUrl(url: string): boolean {
  return url.startsWith(`${APEX_APP_SCHEME}://`)
}

/** One query value of an apex:// address (skills?tab=, workspace?q=, routines?view=, connectors?connect= (read by connectRequestOf)), or null. */
export function internalQuery(url: string, key: string): string | null {
  if (!isInternalUrl(url)) return null
  const query = url.split('#')[0]?.split('?')[1]
  return query === undefined ? null : new URLSearchParams(query).get(key)
}

/** The name an apex://file tab shows: the `name` hint the opener added, else the target path's last part. */
export function fileViewerName(url: string): string | null {
  const parsed = parseFileViewerUrl(url)
  if (!parsed) return null
  const hint = (() => {
    try {
      return new URLSearchParams(url.slice(url.indexOf('?') + 1).split('#')[0]).get('name')
    } catch {
      return null
    }
  })()
  const clean = (s: string | null | undefined): string | null => {
    // eslint-disable-next-line no-control-regex
    const text = (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120)
    return text || null
  }
  return clean(hint) ?? clean(targetPathName(parsed.target))
}

function targetPathName(target: ViewerTarget): string | null {
  if (target.kind === 'companion-file' || target.kind === 'memory' || target.kind === 'chat-file' || target.kind === 'local') return target.path.split(/[\\/]/).filter(Boolean).pop() ?? null
  return null
}
