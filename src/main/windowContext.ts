/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { session as electronSession, type Session } from 'electron'
import { UI, type AgentOverlay, type Bounds, type InitialState } from '@shared/ipc'
import type { AppEvent, Services } from '@shared/services'
import { uiOriginOf, type InternalNames } from '@shared/url'
import type { SavedWindow, WindowKind } from '@shared/windows'
import { mergeServices } from './features'
import type { ServiceParts, SessionInfo, WindowContext } from './features/types'
import { HistoryStore } from './history'
import { DEFAULT_PROFILE_ID, profilePartition } from '@shared/profiles'
import type { ProfileManager } from './profiles/service'
import { PinnedTabsStore } from './tabState'
import { OverlayHost } from './overlayHost'
import type { PageBridge } from './pageBridge'
import { PeekManager } from './peek'
import type { SettingsStore, WindowStateStore } from './settings'
import { restoreSavedWindowExtras } from './sessionRestore'
import { shellServices } from './shell'
import type { TabRegistry } from './tabRegistry'
import { TabManager, type Tab } from './tabs'
import type { ThemeController } from './theme'
import { ChromeWindow, createChromeWindow } from './window'
import { applyWindowMaterial } from './windowMaterial'

// Builds a window after the first: its own browser
// window, ChromeWindow, TabManager, PeekManager and OverlayHost, its session
// (an in-memory partition for a private window, with every feature's
// session installer run on it), its window-scoped services merged over the
// app-wide ones, and its events. index.ts still builds the first window.

export interface WindowFactoryDeps {
  uiUrl: string
  preloadUi: string
  preloadPage: string
  settings: SettingsStore
  theme: ThemeController
  history: HistoryStore
  bridge: PageBridge
  windowStore: WindowStateStore
  webSession: Session
  names: InternalNames
  agentOverlay(tab: Tab): Omit<AgentOverlay, 'active'>
  installSession(session: Session, info: SessionInfo): void
  addWindow(win: WindowContext): ServiceParts
  /** The app-wide services (the first window's merged set); a window's own parts go over them. */
  appServices(): Services
  tabsRegistry: TabRegistry
  smoke: boolean
  /** Each profile's session, data folder and stores; without it every window is the default profile's. */
  profiles?: ProfileManager
}

export interface WindowCreateOptions {
  kind: Exclude<WindowKind, 'popup'>
  /** The first tab's address; a blank new tab when omitted. */
  url?: string
  bounds?: Bounds
  /** A saved window to restore (session restore, reopening a closed window). */
  saved?: SavedWindow
  /** The profile the window opens in (the default profile when omitted). */
  profileId?: string
}

export interface CreatedWindow {
  win: WindowContext
  services: Services
  initialState(): InitialState
  chromeWindow: ChromeWindow
  /** Resolves once the chrome loaded. */
  loaded: Promise<void>
}

let privateCount = 0

/** Private windows record nothing: history writes are dropped. */
const NO_HISTORY = {
  record: () => undefined,
  updateTitle: () => undefined,
  noteTyped: () => undefined,
  notePick: () => undefined,
} as unknown as HistoryStore

export function createWindowContext(deps: WindowFactoryDeps, opts: WindowCreateOptions): CreatedWindow {
  const { settings, theme } = deps
  const isPrivate = opts.kind === 'private'
  // SH-61: the window's profile; an unknown one falls back to the default profile.
  const profiles = deps.profiles
  const profileId = opts.profileId && profiles?.get(opts.profileId) ? opts.profileId : DEFAULT_PROFILE_ID
  const ownProfile = profileId !== DEFAULT_PROFILE_ID && profiles ? profiles : null
  let session = deps.webSession
  let partition = profilePartition(DEFAULT_PROFILE_ID)
  if (ownProfile && !isPrivate) {
    session = ownProfile.sessionFor(profileId)
    partition = profilePartition(profileId)
  }
  if (isPrivate) {
    // No 'persist:' prefix: the partition lives in memory and is gone with the window.
    partition = `apex-private-${++privateCount}-${Date.now().toString(36)}`
    session = electronSession.fromPartition(partition, { cache: true })
    deps.installSession(session, { private: true, partition })
  }

  const window = createChromeWindow({ preload: deps.preloadUi, mode: theme.state().mode, layout: settings.getFor(profileId).layout, hue: settings.getFor(profileId).profileHue })
  // Pinned tabs come back in the first window of a profile only, so they never double up.
  const pinned = ownProfile && !isPrivate && ownProfile.windowsOf(profileId).length === 0 ? ownProfile.store(profileId, 'pinned', (dir) => new PinnedTabsStore(dir)) : undefined
  profiles?.attachWindow(window, profileId)
  if (opts.bounds) window.setBounds(opts.bounds)
  if (deps.smoke) window.webContents.setBackgroundThrottling(false)
  const chrome = window.webContents
  const send = (event: AppEvent): void => {
    if (!window.isDestroyed()) chrome.send(UI.appEvent, event)
  }

  let peek: PeekManager | null = null
  const tabs = new TabManager({
    window,
    session,
    preloadPath: deps.preloadPage,
    history: isPrivate ? NO_HISTORY : ownProfile ? ownProfile.store(profileId, 'history', (dir) => new HistoryStore(dir)) : deps.history,
    ...(pinned ? { pinned } : {}),
    bridge: deps.bridge,
    onFindResult: (result) => send({ type: 'find', result }),
    onPeek: (url) => peek?.open(url),
    windowId: window.id,
    names: deps.names,
    agentOverlay: deps.agentOverlay,
  })
  peek = new PeekManager(window, session, tabs, (state) => send({ type: 'peek', state }))
  const key = isPrivate ? `private-${window.id}` : `window-${window.id}`
  const chromeWindow = new ChromeWindow({ window, kind: opts.kind, key, store: deps.windowStore, tabs, theme, layout: () => settings.getFor(profileId).layout, uiUrl: deps.uiUrl })
  if (opts.saved) {
    chromeWindow.setSidebarOpen(opts.saved.sidebarOpen)
    if (opts.saved.name) chromeWindow.setName(opts.saved.name)
  }
  const overlay = new OverlayHost(window.id)
  overlay.attach({ window, chrome, tabs, uiUrl: deps.uiUrl, preload: deps.preloadUi })
  // Settings reach the windows of the profile they belong to (app keys reach every profile).
  const onSettings = (id: string): void => {
    if (id !== profileId) return
    const event: AppEvent = { type: 'settings', view: settings.viewFor(profileId) }
    send(event)
    overlay.relay(event)
  }
  settings.on('profileChanged', onSettings)
  window.once('closed', () => settings.off('profileChanged', onSettings))

  const win: WindowContext = { id: window.id, kind: opts.kind, window, chrome, tabs, peek, overlay, chromeWindow, session, send }
  tabs.on('created', (tab) => deps.tabsRegistry.add(tab, window.id))
  tabs.on('closed', (tab, info?: { moved?: boolean }) => {
    if (!info?.moved) deps.tabsRegistry.remove(tab.id, { private: opts.kind === 'private' })
  })
  // A closed window's tabs go with it (their pages are closed in windows.ts).
  window.once('closed', () => {
    for (const tab of tabs.all()) if (deps.tabsRegistry.windowOf(tab.id) === window.id) deps.tabsRegistry.remove(tab.id, { private: opts.kind === 'private' })
  })

  // Tabs reach the chrome through their own channel, batched.
  let pending = false
  const pushTabs = (): void => {
    if (pending) return
    pending = true
    setImmediate(() => {
      pending = false
      if (!window.isDestroyed()) chrome.send(UI.tabsChanged, tabs.snapshot())
    })
  }
  tabs.on('changed', pushTabs)
  chrome.on('did-finish-load', pushTabs)
  chromeWindow.on('changed', (state) => send({ type: 'window', state }))
  const onTheme = (): void => tabs.refreshAgentOverlay()
  theme.on('changed', onTheme)
  window.once('closed', () => theme.off('changed', onTheme))
  applyWindowMaterial(window, (material) => send({ type: 'window-material', material }))

  const uiOrigin = uiOriginOf(deps.uiUrl)
  chrome.on('will-navigate', (event) => {
    if (uiOrigin === null || uiOriginOf(event.url) !== uiOrigin) event.preventDefault()
  })
  chrome.on('did-start-loading', () => {
    tabs.resetChromeState()
    peek?.close()
  })
  // SS-01: the window shows once the chrome painted (its placeholder shell at the least).
  window.once('ready-to-show', () => window.show())

  const parts = deps.addWindow(win)
  const services = mergeServices(deps.appServices(), windowParts(win, chromeWindow, theme), parts)
  const initialState = (): InitialState => ({ theme: theme.state(), settings: settings.viewFor(profileId), window: chromeWindow.state(), tabs: tabs.snapshot() })

  const loaded = window.loadURL(deps.uiUrl).catch(() => undefined)
  void loaded.then(() => {
    if (window.isDestroyed()) return
    if (opts.saved) restoreSaved(tabs, opts.saved, window.id)
    else tabs.create(opts.url ?? 'about:blank')
    if (opts.saved?.displayMode === 'maximized') window.maximize()
    else if (opts.saved?.displayMode === 'fullscreen') window.setFullScreen(true)
  })
  return { win, services, initialState, chromeWindow, loaded: loaded.then(() => undefined) }
}

/** A saved window's tabs, groups and split, loading lazily. */
export function restoreSaved(tabs: TabManager, saved: SavedWindow, windowId?: number): void {
  try {
    tabs.restore(saved.tabs, { lazy: true, groups: saved.groups, split: saved.split, activeIndex: saved.activeIndex })
  } catch {
    // Without a working restore: open the addresses, without history.
    for (const tab of saved.tabs) tabs.create(tab.url, { activate: false, pinned: tab.pinned })
    const active = tabs.all()[saved.activeIndex]
    if (active) tabs.activate(active.id)
  }
  if (tabs.all().length === 0) tabs.create('about:blank')
  // The saved extras (spaces) get their fields back with the new tab ids.
  if (windowId !== undefined) restoreSavedWindowExtras(windowId, saved, tabs.all().map((t) => t.id))
}

/** The window-scoped parts, wired by hand as for the first window: find, peek, split, pages and the shell. */
function windowParts(win: WindowContext, chromeWindow: ChromeWindow, theme: ThemeController): ServiceParts {
  const { tabs, peek, window } = win
  return {
    ...shellServices({ window, tabs, chrome: chromeWindow, theme }),
    find: {
      start: (text, forward, findNext) => {
        const wc = tabs.active()?.view.webContents
        if (wc && text) wc.findInPage(text, { forward, findNext })
      },
      stop: () => tabs.active()?.view.webContents.stopFindInPage('clearSelection'),
    },
    peek: {
      open: (url) => peek.open(url),
      close: () => peek.close(),
      promote: () => peek.promote(),
    },
    split: {
      open: () => tabs.openSplit(),
      close: () => tabs.closeSplit(),
      swap: () => tabs.swapSplit(),
      openWith: (id, partnerId) => tabs.openSplitWith(id, partnerId),
    },
    pages: {
      open: (url, options) => tabs.openInternal(url, options),
      snapshot: (id) => tabs.capture(id, win.chrome),
    },
  } as ServiceParts
}
