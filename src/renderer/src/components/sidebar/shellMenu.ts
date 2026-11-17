/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Bookmark } from '@shared/services'
import type { SettingsView, TabsSnapshot } from '@shared/ipc'
import { engineHasOwnAccount } from '@shared/engine'
import { atelier, call, errorText } from '../../api'
import { toast } from '../../ui'
import type { ShellActions } from '../shellContext'
import { canAutoGroup, isWebUrl, type MainMenuContext, type ShellMenuContext } from './logic/menus'
import { clearTabs } from './tabActions'
import { t } from '@shared/i18n/core'

// Acts on the ids of the background and main menus (logic/menus.ts). Both
// menus share most items, so one handler serves them.

export interface ShellMenuDeps {
  snapshot: TabsSnapshot
  settings: SettingsView
  bookmarks: readonly Bookmark[]
  sidebarOpen: boolean
  shell: ShellActions
}

/** Web tabs that are not bookmarked yet (one per address). */
export function bookmarkableTabs(snapshot: TabsSnapshot, bookmarks: readonly Bookmark[]): Array<{ url: string; title: string }> {
  const saved = new Set(bookmarks.map((b) => b.url))
  const seen = new Set<string>()
  const result: Array<{ url: string; title: string }> = []
  for (const tab of snapshot.tabs) {
    if (!isWebUrl(tab.url) || saved.has(tab.url) || seen.has(tab.url)) continue
    seen.add(tab.url)
    result.push({ url: tab.url, title: tab.title })
  }
  return result
}

export function shellMenuContext({ snapshot, settings, bookmarks, sidebarOpen }: ShellMenuDeps): MainMenuContext {
  const active = snapshot.tabs.find((t) => t.id === snapshot.activeId)
  const saved = new Set(bookmarks.map((b) => b.url))
  const base: ShellMenuContext = {
    layout: settings.layout,
    sidebarOpen,
    theme: settings.theme,
    closedCount: snapshot.closedCount,
    unpinnedCount: snapshot.tabs.filter((t) => !t.pinned).length,
    bookmarkable: bookmarkableTabs(snapshot, bookmarks).length,
    canGroup: canAutoGroup(snapshot.tabs, snapshot.groups ?? []),
  }
  // Chats on an engine with its own sign-in need no key, so the menu stops offering one (ST-58).
  return { ...base, hasApiKey: settings.hasApiKey || engineHasOwnAccount(settings.engine), bookmarksBar: settings.bookmarksBar, canBookmark: !!active && isWebUrl(active.url) && !saved.has(active.url) }
}

/** Bookmarks every open web page that isn't saved yet; the store only toggles, so saved ones are skipped first. */
export async function bookmarkAll(snapshot: TabsSnapshot, bookmarks: readonly Bookmark[]): Promise<void> {
  const pages = bookmarkableTabs(snapshot, bookmarks)
  if (pages.length === 0) {
    toast.show({ message: t('tabs.sidebarShellMenu.everyOpenPageIs') })
    return
  }
  try {
    for (const page of pages) await call('bookmarks', 'toggle', page.url, page.title)
    toast.show({ message: pages.length === 1 ? t('tabs.sidebarShellMenu.bookmarked1Page') : t('tabs.sidebarShellMenu.bookmarkedPages', { length: pages.length }), tone: 'success' })
  } catch (err) {
    toast.show({ message: t('tabs.sidebarShellMenu.couldnTBookmarkEvery', { value: errorText(err) }), tone: 'error' })
  }
}

const open = (url: string): void => void call('pages', 'open', url)

/** Runs a background- or main-menu choice. Returns false for ids it doesn't know. */
export function runShellMenu(id: string, deps: ShellMenuDeps): boolean {
  const { snapshot, settings, bookmarks, sidebarOpen, shell } = deps
  const active = snapshot.tabs.find((t) => t.id === snapshot.activeId)
  const sidebarLayout = settings.layout === 'sidebar'
  switch (id) {
    case 'new-tab':
      // Like ⌘T: the new tab opens with the address field ready.
      void atelier.tabs.create(undefined, { position: sidebarLayout ? 'top' : 'end' }).then(shell.focusAddress)
      return true
    case 'reopen':
      void call('tabs', 'reopenClosed')
      return true
    case 'bookmark-all':
      void bookmarkAll(snapshot, bookmarks)
      return true
    case 'close-all':
      void clearTabs()
      return true
    case 'group-auto':
      // Main groups and shows the outcome with Undo (DC-18).
      void call('tabGroups', 'auto').catch((err: unknown) => toast.show({ message: t('tabs.error.action', { what: t('tabs.error.group'), reason: errorText(err) }), tone: 'error' }))
      return true
    case 'layout-sidebar':
    case 'layout-horizontal':
      void atelier.settings.set({ layout: id === 'layout-sidebar' ? 'sidebar' : 'horizontal' })
      return true
    case 'toggle-sidebar':
      void call('window', 'setSidebarOpen', !sidebarOpen)
      return true
    case 'toggle-agent':
      shell.togglePanel()
      return true
    case 'new-chat-beside':
      shell.newChatBeside()
      return true
    case 'theme-system':
    case 'theme-light':
    case 'theme-dark':
      void atelier.settings.set({ theme: id === 'theme-system' ? 'system' : id === 'theme-light' ? 'light' : 'dark' })
      return true
    case 'appearance-settings':
      open('atelier://settings/appearance')
      return true
    case 'rename-window':
      shell.renameWindow()
      return true
    case 'profile':
      open('atelier://settings/you')
      return true
    case 'api-key':
      open('atelier://settings/model')
      return true
    case 'dest-chats':
    case 'dest-routines':
    case 'dest-skills':
    case 'dest-connectors':
      open(`atelier://${id.slice('dest-'.length)}`)
      return true
    case 'bookmark':
      // ⌘D semantics: adds only; removing needs the star.
      if (active && isWebUrl(active.url) && !bookmarks.some((b) => b.url === active.url)) void call('bookmarks', 'toggle', active.url, active.title)
      return true
    case 'bar-always':
    case 'bar-newtab':
    case 'bar-never':
      void atelier.settings.set({ bookmarksBar: id === 'bar-always' ? 'always' : id === 'bar-newtab' ? 'newtab' : 'never' })
      return true
    case 'bookmarks':
      open('atelier://bookmarks')
      return true
    case 'history':
      open('atelier://history')
      return true
    case 'downloads':
      open('atelier://downloads')
      return true
    case 'find':
      shell.openFind()
      return true
    case 'first-week':
      open('atelier://first-week')
      return true
    case 'settings':
      open('atelier://settings')
      return true
    default:
      return false
  }
}
