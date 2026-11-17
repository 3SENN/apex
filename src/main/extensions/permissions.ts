/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ExtensionInfo, ExtensionPermission } from '@shared/extensions'
import type { MessageKey } from '@shared/i18n/core'
import { mainT } from '../i18n/mainT'
import { permissionLists, type Manifest } from './manifest'

// What an extension can do, in plain words (OV-16, ST-40). Each permission
// that matters to a person maps to Apex's own phrase; quiet ones (storage,
// alarms, menus…) map to null and show nothing. Host patterns collapse into
// one site-access line, so the prompt can say "needs nothing extra" when
// nothing is left.

const PHRASES: Record<string, MessageKey | null> = {
  // Quiet: nothing a person needs to weigh.
  activeTab: null,
  alarms: null,
  background: null,
  contextMenus: null,
  declarativeNetRequestWithHostAccess: null,
  i18n: null,
  idle: null,
  offscreen: null,
  power: null,
  scripting: null,
  search: null,
  sidePanel: null,
  storage: null,
  unlimitedStorage: null,
  webRequest: null,
  webRequestBlocking: null,
  cookies: null,
  gcm: null,
  identity: null,
  // Worth saying.
  bookmarks: 'extensions.perm.bookmarks',
  browsingData: 'extensions.perm.browsingData',
  clipboardRead: 'extensions.perm.clipboardRead',
  clipboardWrite: 'extensions.perm.clipboardWrite',
  contentSettings: 'extensions.perm.contentSettings',
  debugger: 'extensions.perm.debugger',
  declarativeNetRequest: 'extensions.perm.declarativeNetRequest',
  declarativeNetRequestFeedback: 'extensions.perm.history',
  desktopCapture: 'extensions.perm.desktopCapture',
  downloads: 'extensions.perm.downloads',
  favicon: 'extensions.perm.favicon',
  fontSettings: 'extensions.perm.fontSettings',
  geolocation: 'extensions.perm.geolocation',
  history: 'extensions.perm.history',
  'identity.email': 'extensions.perm.identityEmail',
  management: 'extensions.perm.management',
  nativeMessaging: 'extensions.perm.nativeMessaging',
  notifications: 'extensions.perm.notifications',
  pageCapture: 'extensions.perm.pageCapture',
  privacy: 'extensions.perm.privacy',
  proxy: 'extensions.perm.proxy',
  readingList: 'extensions.perm.readingList',
  sessions: 'extensions.perm.sessions',
  'system.cpu': 'extensions.perm.system',
  'system.display': 'extensions.perm.system',
  'system.memory': 'extensions.perm.system',
  'system.storage': 'extensions.perm.system',
  tabCapture: 'extensions.perm.tabCapture',
  tabGroups: 'extensions.perm.tabGroups',
  tabs: 'extensions.perm.tabs',
  topSites: 'extensions.perm.topSites',
  tts: 'extensions.perm.tts',
  ttsEngine: 'extensions.perm.tts',
  userScripts: 'extensions.perm.userScripts',
  webAuthenticationProxy: 'extensions.perm.webAuthenticationProxy',
  webNavigation: 'extensions.perm.history',
}

const ALL_HOSTS = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*', '*://*/', 'http://*/', 'https://*/'])

/** True for patterns that cover every website. */
export function isAllHosts(pattern: string): boolean {
  return ALL_HOSTS.has(pattern) || /^(\*|https?):\/\/\*\//.test(pattern)
}

/** "https://*.example.com/*" → "example.com"; file:// patterns read as "files on this Mac". */
export function hostLabel(pattern: string): string {
  if (pattern.startsWith('file://')) return mainT('extensions.perm.files')
  const m = /^[^:]+:\/\/([^/]*)/.exec(pattern)
  const host = (m?.[1] ?? pattern).replace(/^\*\./, '').replace(/:\d+$/, '')
  return host || pattern
}

/** The phrase for one API permission: its own, null for a quiet one, or a generic line for one Apex doesn't know. */
export function phraseFor(permission: string): string | null {
  if (Object.hasOwn(PHRASES, permission)) {
    const key = PHRASES[permission]
    return key ? mainT(key) : null
  }
  return mainT('extensions.perm.generic', { name: permission })
}

/** One line for a set of host patterns, or null when there are none. */
export function hostsPhrase(patterns: readonly string[]): string | null {
  if (patterns.length === 0) return null
  if (patterns.some(isAllHosts)) return mainT('extensions.perm.allSites')
  const hosts = [...new Set(patterns.map(hostLabel))]
  if (hosts.length === 1) return mainT('extensions.perm.oneSite', { site: hosts[0] ?? '' })
  if (hosts.length <= 3) return mainT('extensions.perm.someSites', { sites: hosts.join(', ') })
  return mainT('extensions.perm.manySites', { count: hosts.length })
}

export function siteAccessOf(m: Manifest): ExtensionInfo['siteAccess'] {
  const { apis, hosts } = permissionLists(m)
  if (hosts.some(isAllHosts)) return 'all'
  if (hosts.length > 0) return 'some'
  return apis.includes('activeTab') ? 'on-click' : 'none'
}

export interface DescribedPermissions {
  /** Required: what the install prompt lists; empty means "needs nothing extra". */
  permissions: ExtensionPermission[]
  /** Optional ones it may ask for later, one entry each so they can be revoked one by one. */
  optional: ExtensionPermission[]
  hosts: string[]
  siteAccess: ExtensionInfo['siteAccess']
}

/** The plain-words description of a manifest's permissions; repeated phrases collapse into one line. */
export function describePermissions(m: Manifest): DescribedPermissions {
  const lists = permissionLists(m)
  const permissions: ExtensionPermission[] = []
  const seen = new Set<string>()
  const add = (into: ExtensionPermission[], id: string, label: string | null): void => {
    if (!label || seen.has(label)) return
    seen.add(label)
    into.push({ id, label })
  }
  // Site access first: it is what matters most.
  add(permissions, 'hosts', hostsPhrase(lists.hosts))
  for (const api of lists.apis) add(permissions, api, phraseFor(api))
  // Optional ones stay one entry per id, even when two read alike, so each can be revoked.
  const optional: ExtensionPermission[] = []
  for (const api of lists.optionalApis) optional.push({ id: api, label: phraseFor(api) ?? mainT('extensions.perm.generic', { name: api }) })
  for (const host of lists.optionalHosts) optional.push({ id: host, label: hostsPhrase([host]) ?? host })
  return { permissions, optional, hosts: lists.hosts, siteAccess: siteAccessOf(m) }
}

/** The ids an optional-permission request covers, split the way chrome.permissions passes them. */
export function requestedIds(request: { permissions?: string[]; origins?: string[] }): string[] {
  return [...(request.permissions ?? []), ...(request.origins ?? [])]
}
