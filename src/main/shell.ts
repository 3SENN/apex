/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BrowserWindow } from 'electron'
import { accentTokens } from '@shared/accent'
import type { AgentOverlay, InitialState } from '@shared/ipc'
import type { AppEvent, Services } from '@shared/services'
import type { TabsServiceAdditions } from '@shared/services/tabs'
import type { ThemeMode } from '@shared/theme'
import { AppMenu, popupMenu } from './menu'
import type { SettingsStore, WindowStateStore } from './settings'
import type { TabManager } from './tabs'
import type { ThemeController } from './theme'
import { ChromeWindow } from './window'

// Wires the window shell: per-window state, the theme, the application menu
// and the services the chrome uses for them. Kept out of index.ts so the
// bootstrap stays a list of parts.

/** The in-page overlay's look for a chat's companion, readable in the current mode. */
export function agentOverlayLook(companion: { name: string; accent: string }, mode: ThemeMode): Omit<AgentOverlay, 'active'> {
  const tokens = accentTokens(companion.accent, mode)
  return { accent: tokens.accent, onAccent: tokens.text, label: `${companion.name} is working in this tab` }
}

interface ShellDeps {
  window: BrowserWindow
  tabs: TabManager
  settings: SettingsStore
  windowStore: WindowStateStore
  theme: ThemeController
  uiUrl: string
  sendEvent(event: AppEvent): void
  /** Newest first, for the History menu. */
  recentChats(): Array<{ id: string; title: string }>
  addBookmark(): void
}

export interface Shell {
  chrome: ChromeWindow
  menu: AppMenu
  // The tabs service additions come from the tabs feature, merged in index.ts.
  services: Pick<Services, 'menu' | 'window' | 'theme'> & { tabs: Omit<Services['tabs'], keyof TabsServiceAdditions> }
  initialState(): InitialState
  /** Call when chat titles or companion names change: tab titles, breadcrumbs and the History menu follow. */
  namesChanged(): void
  /** Call when the active companion (or its accent) changed. */
  companionChanged(): void
}

/** One window's shell services: its native popup menus, tab order and state, its window state and the theme (also used for windows after the first). */
export function shellServices({ window, tabs, chrome, theme }: { window: BrowserWindow; tabs: TabManager; chrome: ChromeWindow; theme: ThemeController }): Shell['services'] {
  return {
    menu: {
      popup: (items, x, y) => popupMenu(window, items, x, y),
    },
    tabs: {
      setOrder: (entries) => tabs.setOrder(entries),
      move: (id, index) => tabs.move(id, index),
      setPinned: (id, pinned) => tabs.setPinned(id, pinned),
      setMuted: (id, muted) => tabs.setMuted(id, muted),
      duplicate: (id) => void tabs.duplicate(id),
      closeMany: (ids) => tabs.closeMany(ids),
      clearTabs: () => tabs.clearUnpinned(),
      undoClearTabs: (id) => tabs.undoClear(id),
      reopenClosed: () => tabs.reopenClosed(),
      history: (id, direction) => tabs.history(id, direction),
      goToIndex: (id, index) => tabs.goToIndex(id, index),
    },
    window: {
      state: () => chrome.state(),
      setSidebarOpen: (open) => chrome.setSidebarOpen(open),
      setName: (name) => chrome.setName(name),
      setButtonPosition: (position) => chrome.setButtonPosition(position),
      setButtonsVisible: (visible) => chrome.setButtonsVisible(visible),
      trackSidebarPointer: (rect) => chrome.trackSidebarPointer(rect),
      close: () => window.close(),
    },
    theme: {
      state: () => theme.state(),
    },
  }
}

export function setupShell(deps: ShellDeps): Shell {
  const { window, tabs, settings, theme, sendEvent } = deps
  const chrome = new ChromeWindow({
    window,
    key: 'main',
    store: deps.windowStore,
    tabs,
    theme,
    layout: () => settings.get().layout,
    uiUrl: deps.uiUrl,
  })
  const menu = new AppMenu({
    window,
    tabs,
    settings,
    chrome,
    recentChats: deps.recentChats,
    addBookmark: deps.addBookmark,
    toggleSplit: () => (tabs.split() ? tabs.closeSplit() : tabs.openSplit()),
  })

  settings.on('changed', (next, previous) => {
    sendEvent({ type: 'settings', view: settings.view() })
    if (next.theme !== previous.theme || next.accent !== previous.accent) theme.refresh()
    if (next.theme !== previous.theme || next.layout !== previous.layout || next.bookmarksBar !== previous.bookmarksBar) menu.invalidate()
  })
  theme.on('changed', (state) => {
    sendEvent({ type: 'theme', theme: state })
    tabs.refreshAgentOverlay()
  })
  chrome.on('changed', (state) => {
    sendEvent({ type: 'window', state })
    menu.invalidate()
  })

  const services = shellServices({ window, tabs, chrome, theme })

  return {
    chrome,
    menu,
    services,
    initialState: () => ({ theme: theme.state(), settings: settings.view(), window: chrome.state(), tabs: tabs.snapshot() }),
    namesChanged: () => {
      tabs.refresh()
      menu.invalidate()
    },
    companionChanged: () => {
      theme.refresh()
      tabs.refreshAgentOverlay()
      tabs.refresh()
    },
  }
}
