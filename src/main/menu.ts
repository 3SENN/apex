/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import { BrowserWindow, Menu, app, clipboard, dialog, shell, type MenuItemConstructorOptions, type NativeImage, type WebContents } from 'electron'
import { UI, type MenuCommand } from '@shared/ipc'
import type { MenuItemSpec } from '@shared/menu'
import { DYNAMIC_PREFIXES, MENU_ACTIONS, NATIVE_TOP, flattenMenu, mainMenuItems, nativeMenus, resolveStates, topLabel, type MainMenuModel, type MenuAction, type MenuData } from '@shared/menuBase'
import { findFolder, type MenuBookmarks, type MenuVisit } from '@shared/menuLists'
import { menus, type MenuContribution, type MenuItemModel, type MenuState, type MenuTarget } from '@shared/menuModel'
import { isCommandId, type CommandId } from '@shared/shortcuts'
import type { ThemePreference } from '@shared/theme'
import { chatUrl } from '@shared/url'
import type { ClosedEntry } from '@shared/windows'
import { commands } from './commands'
import { collectSystemInfo, systemInfoText } from './diagnostics/systemInfo'
import { toasts } from './dialogs'
import type { WindowContext } from './features/types'
import { mainT } from './i18n/mainT'
import { log } from './log'
import { MenuIconCache } from './menuIcons'
import { RebuildScheduler } from './menuRebuild'
import type { SettingsStore } from './settings'
import type { TabManager } from './tabs'
import type { ChromeWindow } from './window'
import type { WindowManager } from './windows'

export interface MenuDeps {
  window: BrowserWindow
  tabs: TabManager
  settings: SettingsStore
  chrome: ChromeWindow
  /** Newest first; the History menu shows the first ten. */
  recentChats(): Array<{ id: string; title: string }>
  /** ⌘D: adds a bookmark for the active page; never removes one. */
  addBookmark(): void
  toggleSplit(): void
}

/**
 * Late-bound sources. The menus feature fills `windows`; index.ts and
 * the owning features fill the rest after start-up. Each is optional: a menu
 * without its source shows its empty state.
 */
export interface MenuSources {
  windows?: WindowManager
  /** Newest first. */
  visited?(limit: number): MenuVisit[]
  bookmarks?(): MenuBookmarks
  /** The recently closed tabs, windows and chats, newest first. */
  closed?(): ClosedEntry[]
  /** Reopens entry `index` of closed() (windows.reopen); false when it couldn't. */
  reopenClosed?(index: number): boolean
  isDefaultBrowser?(): boolean
  /** Opens the default-browser flow; without it Apex opens its settings page. */
  makeDefaultBrowser?(): void
  update?(): MenuState['update']
  /** Diagnostics for Help › Copy Diagnostics; the diagnostics feature may add to it. */
  diagnostics?(): Record<string, string>
  /** The zoom row (addressZoomRow): the active web tab's level, as the address pill shows it. */
  zoomRow?(win: WindowContext | null): { percent: number; applies: boolean }
}

export const menuSources: MenuSources = {}

const MAX_MENU_DEPTH = 5
const REBUILD_MS = 150

let current: AppMenu | null = null

/** The app's menu builder, once the shell made it. */
export function appMenu(): AppMenu | null {
  return current
}

/** What a fallback or local action acts on. */
interface ActionContext {
  win: WindowContext | null
  window: BrowserWindow
  tabs: TabManager
}

/**
 * The application menu (SH-50 to SH-59). The bar, the Dock menu and the
 * main-menu popover come from one model (shared/menuBase.ts) plus menu
 * contributions. Items run registered commands; until a command's
 * feature registers it, a basic built-in behaviour runs as a fallback, and anything
 * else renders disabled. Accelerators here work even while a page has
 * keyboard focus, which is why browser shortcuts live in the menu. It
 * rebuilds (debounced) on state changes and waits while a menu is open.
 */
export class AppMenu {
  readonly #deps: MenuDeps
  readonly #scheduler: RebuildScheduler
  readonly #icons: MenuIconCache
  /** Who built each contributed item, from the last build. */
  #owners = new Map<string, MenuContribution>()
  /** The last main-menu model, so run(id) finds dynamic rows. */
  #mainItems = new Map<string, MenuItemModel>()
  readonly #offInvalidate: () => void

  constructor(deps: MenuDeps) {
    this.#deps = deps
    current = this
    this.#scheduler = new RebuildScheduler(() => this.build(), REBUILD_MS)
    this.#icons = new MenuIconCache(() => this.invalidate())
    this.#offInvalidate = menus.onInvalidate(() => this.invalidate())
    // Tab titles, back and forward and the tab list follow the tabs.
    deps.tabs.on('changed', () => this.invalidate())
    this.build()
  }

  /** Schedules a rebuild; several changes in a row cost one, and an open menu is never replaced under the pointer. */
  invalidate(): void {
    this.#scheduler.request()
  }

  dispose(): void {
    this.#scheduler.dispose()
    this.#offInvalidate()
    if (current === this) current = null
  }

  build(): void {
    // A rebuild that lands while the last window closes (quitting) has nothing to describe.
    if (this.#context().window.isDestroyed()) return
    try {
      const { state, data, ctx } = this.#collect()
      const owners = new Map<string, MenuContribution>()
      const model = nativeMenus(state, data, owners)
      this.#owners = owners
      const available = (id: CommandId) => this.#available(id, ctx)
      const top: MenuItemConstructorOptions[] = []
      for (const target of NATIVE_TOP) {
        if (target === 'app' && data.platform !== 'darwin') continue
        const items = resolveStates(model[target], available)
        // The Extensions menu stays hidden until the extensions feature contributes to it.
        if (items.length === 0) continue
        top.push({
          label: topLabel(target, app.name),
          ...(target === 'help' ? { role: 'help' as const } : {}),
          submenu: this.#template(items, ctx, 0),
        })
      }
      const menu = Menu.buildFromTemplate(top)
      this.#watch(menu)
      Menu.setApplicationMenu(menu)
      if (data.platform === 'darwin' && app.dock) {
        const dock = resolveStates(model.dock, available)
        app.dock.setMenu(Menu.buildFromTemplate(this.#template(dock, ctx, 0)))
      }
    } catch (err) {
      log.error('menu', 'Menu rebuild failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** The main-menu popover's model for a window (SH-54), with enabled and checked states resolved. */
  mainMenu(win: WindowContext | null): MainMenuModel {
    const { state, data, ctx } = this.#collect(win)
    const owners = new Map<string, MenuContribution>()
    const items = resolveStates(mainMenuItems(state, data, owners), (id) => this.#available(id, ctx))
    for (const [id, c] of owners) this.#owners.set(id, c)
    this.#mainItems = new Map(flattenMenu(items).map((item) => [item.id, item]))
    const settings = this.#deps.settings.get()
    return {
      platform: data.platform,
      appName: app.name,
      items,
      theme: settings.theme,
      layout: settings.layout,
      accent: settings.accent,
      adblock: settings.adblock,
      zoomPercent: this.#zoomPercent(ctx),
    }
  }

  /** Runs a main-menu or Windows/Linux menu-button choice by id. */
  async run(itemId: string, win: WindowContext | null): Promise<void> {
    const ctx = this.#context(win)
    const item = this.#mainItems.get(itemId)
    if (item?.commandId && isCommandId(item.commandId)) return this.#runCommand(item.commandId, ctx)
    if (isCommandId(itemId)) return this.#runCommand(itemId, ctx)
    await this.#runItem({ id: itemId }, ctx)
  }

  /** Windows and Linux: pops one top-level menu from the in-window menu button. */
  popupTop(target: MenuTarget, x: number, y: number, win: WindowContext | null): void {
    const { state, data, ctx } = this.#collect(win)
    const items = resolveStates(nativeMenus(state, data, this.#owners)[target] ?? [], (id) => this.#available(id, ctx))
    if (items.length === 0) return
    const window = win?.window ?? this.#deps.window
    const zoom = window.webContents.getZoomFactor() || 1
    const menu = Menu.buildFromTemplate(this.#template(items, ctx, 0))
    this.#watch(menu)
    menu.popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom) })
  }

  // ---- state ----

  #context(win: WindowContext | null = null): ActionContext {
    const target = win ?? menuSources.windows?.focused() ?? null
    return { win: target, window: target?.window ?? this.#deps.window, tabs: target?.tabs ?? this.#deps.tabs }
  }

  #collect(win: WindowContext | null = null): { state: MenuState; data: MenuData; ctx: ActionContext } {
    const ctx = this.#context(win)
    const { settings, chrome } = this.#deps
    const current = settings.get()
    const snapshot = ctx.tabs.snapshot()
    const activeInfo = snapshot.tabs.find((t) => t.id === snapshot.activeId) ?? null
    const tabs = snapshot.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, pinned: t.pinned, muted: t.muted, lastActiveAt: t.lastActiveAt, ...(t.favicon ? { image: t.favicon } : {}) }))
    const windows = menuSources.windows?.list() ?? [{ id: ctx.window.id, kind: 'normal' as const, title: ctx.window.isDestroyed() ? '' : ctx.window.getTitle(), tabCount: snapshot.tabs.length, focused: ctx.window.isFocused() }]
    const commandStates: MenuState['commands'] = {}
    for (const [id, s] of Object.entries(commands.available(ctx.win))) if (s) commandStates[id] = s
    const state: MenuState = {
      windows,
      focusedWindow: ctx.win ? { id: ctx.win.id, kind: ctx.win.kind } : null,
      tabs: tabs.map(({ id, title, url, pinned }) => ({ id, title, url, pinned })),
      activeTabId: snapshot.activeId,
      focusedSurface: focusedSurface(ctx),
      commands: commandStates,
      update: menuSources.update?.() ?? { state: 'idle', percent: null },
    }
    const visited = menuSources.visited?.(15) ?? []
    const data: MenuData = {
      platform: process.platform,
      appName: app.name,
      version: app.getVersion(),
      theme: current.theme,
      layout: current.layout,
      bookmarksBar: current.bookmarksBar,
      warnBeforeQuit: current.warnBeforeQuit,
      adblock: current.adblock,
      sidebarOpen: chrome.state().sidebarOpen,
      isDefaultBrowser: menuSources.isDefaultBrowser?.() ?? true,
      tabs,
      active: activeInfo ? { web: /^https?:/i.test(activeInfo.url), muted: activeInfo.muted } : null,
      closed: menuSources.closed?.() ?? [],
      visited,
      chats: this.#deps.recentChats().map((c) => ({ id: c.id, title: c.title })),
      bookmarks: menuSources.bookmarks?.() ?? { recent: [], bar: [], other: [] },
    }
    return { state, data, ctx }
  }

  #available(id: CommandId, ctx: ActionContext): { enabled: boolean; checked?: boolean } | null {
    if (commands.has(id)) return commands.available(ctx.win)[id] ?? null
    const fallback = this.#fallbacks()[id]
    if (!fallback) return null
    return { enabled: fallback.enabled?.(ctx) ?? true }
  }

  #zoomPercent(ctx: ActionContext): number | null {
    // A web tab's level comes from the zoom controller, so the menu and the pill agree.
    const row = menuSources.zoomRow?.(ctx.win)
    if (row?.applies && target(ctx)?.kind === 'tab') return row.percent
    const wc = target(ctx)?.wc
    return wc && !wc.isDestroyed() ? Math.round(wc.getZoomFactor() * 100) : null
  }

  // ---- templates ----

  #template(items: readonly MenuItemModel[], ctx: ActionContext, depth: number): MenuItemConstructorOptions[] {
    if (depth >= MAX_MENU_DEPTH) return []
    const out: MenuItemConstructorOptions[] = []
    for (const item of items) {
      if (item.type === 'separator') {
        // No leading, trailing or doubled separators.
        if (out.length && out[out.length - 1]?.type !== 'separator') out.push({ type: 'separator' })
        continue
      }
      if (item.role && !item.submenu) {
        out.push({ role: item.role as MenuItemConstructorOptions['role'], ...(item.label ? { label: item.label } : {}) })
        continue
      }
      const icon = this.#icon(item.image, ctx)
      const base: MenuItemConstructorOptions = {
        id: item.id,
        label: item.label,
        enabled: item.enabled ?? true,
        ...(item.visible === false ? { visible: false } : {}),
        ...(icon ? { icon } : {}),
      }
      if (item.submenu) {
        out.push({ ...base, submenu: this.#template(item.submenu, ctx, depth + 1) })
        continue
      }
      const type = item.variant === 'switch' ? 'checkbox' : (item.type ?? 'normal')
      const header = item.variant === 'header' || item.variant === 'note'
      out.push({
        ...base,
        type,
        ...(header ? { enabled: false } : {}),
        ...(type === 'checkbox' || type === 'radio' ? { checked: item.checked ?? false } : {}),
        ...(item.accelerator ? { accelerator: item.accelerator } : {}),
        click: () => void this.#runItem(item, this.#context(ctx.win)),
      })
    }
    while (out.length && out[out.length - 1]?.type === 'separator') out.pop()
    return out
  }

  #icon(image: string | undefined, ctx: ActionContext): NativeImage | undefined {
    return image ? this.#icons.get(image, ctx.win?.session ?? null) : undefined
  }

  /** Counts open menus, so a rebuild waits until they close. */
  #watch(menu: Menu): void {
    menu.on('menu-will-show', () => this.#scheduler.menuOpened())
    menu.on('menu-will-close', () => this.#scheduler.menuClosed())
    for (const item of menu.items) if (item.submenu) this.#watch(item.submenu)
  }

  // ---- running ----

  async #runItem(item: Pick<MenuItemModel, 'id' | 'commandId'>, ctx: ActionContext): Promise<void> {
    try {
      if (item.commandId && isCommandId(item.commandId)) return await this.#runCommand(item.commandId, ctx)
      if ((MENU_ACTIONS as readonly string[]).includes(item.id)) return await this.#runAction(item.id as MenuAction, ctx)
      if (await this.#runDynamic(item.id, ctx)) return
      const owner = this.#owners.get(item.id)
      if (owner?.run) await owner.run(item.id, ctx.win?.id ?? null)
    } catch (err) {
      log.error('menu', `Menu item ${item.id} failed`, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  async #runCommand(id: CommandId, ctx: ActionContext): Promise<void> {
    if (commands.has(id)) {
      await commands.run(id, ctx.win)
      return
    }
    const fallback = this.#fallbacks()[id]
    if (fallback && fallback.enabled?.(ctx) !== false) await fallback.run(ctx)
  }

  async #runDynamic(id: string, ctx: ActionContext): Promise<boolean> {
    const { tabs } = ctx
    const after = (prefix: string): string | null => (id.startsWith(prefix) ? id.slice(prefix.length) : null)
    const tabId = after(DYNAMIC_PREFIXES.tab)
    if (tabId !== null) {
      if (tabs.find(tabId)) tabs.activate(tabId)
      return true
    }
    const windowId = after(DYNAMIC_PREFIXES.window)
    if (windowId !== null) {
      const win = menuSources.windows?.get(Number(windowId))
      if (win && !win.window.isDestroyed()) {
        if (win.window.isMinimized()) win.window.restore()
        win.window.focus()
      }
      return true
    }
    const closed = after(DYNAMIC_PREFIXES.closed)
    if (closed !== null) {
      const index = Number(closed)
      if (!menuSources.reopenClosed?.(index)) {
        // Without the window manager's list, reopen the closed tab the entry names.
        const entry = menuSources.closed?.()[index]
        if (entry?.kind === 'tab') tabs.create(entry.url, { activate: true })
        else if (entry?.kind === 'chat') tabs.openInternal(chatUrl(entry.chatId))
        else tabs.reopenClosed()
      }
      return true
    }
    const url = after(DYNAMIC_PREFIXES.open)
    if (url !== null) {
      if (/^https?:\/\//i.test(url)) this.#openUrl(url, ctx)
      return true
    }
    const chatId = after(DYNAMIC_PREFIXES.chat)
    if (chatId !== null) {
      tabs.openInternal(chatUrl(chatId))
      return true
    }
    const folderId = after(DYNAMIC_PREFIXES.openAll)
    if (folderId !== null) {
      const tree = menuSources.bookmarks?.()
      const nodes = folderId === 'bar' ? tree?.bar : folderId === 'other' ? tree?.other : (findFolder([...(tree?.bar ?? []), ...(tree?.other ?? [])], folderId)?.children ?? [])
      for (const node of nodes ?? []) if (node.kind === 'bookmark' && /^https?:\/\//i.test(node.url)) tabs.create(node.url, { activate: false })
      return true
    }
    return false
  }

  #openUrl(url: string, ctx: ActionContext): void {
    const active = ctx.tabs.active()
    // A blank tab takes the page; otherwise it opens in a new tab, like a bookmark click.
    if (active && !active.internalUrl && /^(about:blank)?$/.test(active.view.webContents.getURL())) ctx.tabs.navigate(active.id, url)
    else ctx.tabs.create(url, { activate: true, position: this.#deps.settings.get().layout === 'sidebar' ? 'top' : 'end' })
  }

  async #runAction(id: MenuAction, ctx: ActionContext): Promise<void> {
    const { settings } = this.#deps
    const setTheme = (theme: ThemePreference): void => void settings.update({ theme })
    const active = ctx.tabs.active()
    switch (id) {
      case 'theme-system':
        return setTheme('system')
      case 'theme-light':
        return setTheme('light')
      case 'theme-dark':
        return setTheme('dark')
      case 'appearance-settings':
        return ctx.tabs.openInternal('apex://settings/appearance')
      case 'layout-sidebar':
      case 'layout-horizontal':
        settings.update({ layout: id === 'layout-sidebar' ? 'sidebar' : 'horizontal' })
        return
      case 'bar-always':
      case 'bar-newtab':
      case 'bar-never':
        settings.update({ bookmarksBar: id === 'bar-always' ? 'always' : id === 'bar-newtab' ? 'newtab' : 'never' })
        return
      case 'warn-before-quit':
        settings.update({ warnBeforeQuit: !settings.get().warnBeforeQuit })
        return
      case 'close-all-tabs': {
        // The tab list's Clear: every unpinned tab, with Undo in the toast.
        const cleared = ctx.tabs.clearUnpinned()
        if (cleared && cleared.closed > 0 && ctx.win) {
          const text = cleared.closed === 1 ? mainT('tabs.clear.closedOne') : mainT('tabs.clear.closed', { count: cleared.closed })
          void toasts.show(ctx.win, { kind: 'info', text, undo: () => void ctx.tabs.undoClear(cleared.id) }).catch(() => undefined)
        }
        return
      }
      case 'duplicate-tab':
        if (active) ctx.tabs.duplicate(active.id)
        return
      case 'mute-site':
        if (active) ctx.tabs.setMuted(active.id, !active.view.webContents.isAudioMuted())
        return
      case 'home':
        ctx.tabs.create('about:blank', { activate: true, position: settings.get().layout === 'sidebar' ? 'top' : 'end' })
        focusAddressAfterTabs(ctx)
        return
      case 'inspect': {
        const t = target(ctx)
        if (!t) return shell.beep()
        // Inspect opens the tools in element-picking mode at the page's centre.
        const size = t.kind === 'tab' ? ctx.tabs.contentBounds() : { width: BrowserWindow.fromWebContents(t.wc)?.getContentSize()[0] ?? 0, height: BrowserWindow.fromWebContents(t.wc)?.getContentSize()[1] ?? 0 }
        t.wc.inspectElement(Math.round(size.width / 2), Math.round(size.height / 2))
        return
      }
      case 'copy-diagnostics': {
        clipboard.writeText(diagnosticsText(settings.get().engine))
        toastSafely(ctx, mainT('menus.help.copiedDiagnostics'))
        return
      }
      case 'getting-started':
        return ctx.tabs.openInternal('apex://first-week')
      case 'adblock':
        // The chrome's settings call applies the blocker; main's store only records it.
        settings.update({ adblock: !settings.get().adblock })
        return
      case 'copy-markdown':
      case 'screenshot':
        // Page actions; the menus feature routes these (features/menus.ts).
        await menuActionHooks[id]?.(ctx.win, active?.id)
        return
      case 'search-engine':
        return ctx.tabs.openInternal('apex://settings/search')
      case 'clear-cache':
        return this.#runCommand('clear-data', ctx)
      case 'default-browser':
        if (menuSources.makeDefaultBrowser) menuSources.makeDefaultBrowser()
        else ctx.tabs.openInternal('apex://settings/default-browser')
        return
      case 'manage-profile':
        return ctx.tabs.openInternal('apex://settings/you')
      case 'zoom-row':
      case 'rename-window':
        // Drawn and handled by the chrome.
        return
    }
  }

  /**
   * Basic behaviour for commands no feature has registered yet. A registered
   * command always wins, so these step aside on their own.
   */
  #fallbacks(): Partial<Record<CommandId, Fallback>> {
    if (this.#fallbackTable) return this.#fallbackTable
    const { settings, chrome } = this.#deps
    const sidebarLayout = (): boolean => settings.get().layout === 'sidebar'
    const newTab = (ctx: ActionContext): void => {
      ctx.tabs.create('about:blank', { position: sidebarLayout() ? 'top' : 'end' })
      focusAddressAfterTabs(ctx)
    }
    const open = (url: string): Fallback => ({ run: (ctx) => ctx.tabs.openInternal(url) })
    const step = (delta: 1 | -1): Fallback => ({ run: (ctx) => ctx.tabs.step(delta) })
    const nth = (n: number | 'last'): Fallback => ({ run: (ctx) => ctx.tabs.selectNth(n) })
    const zoom = (delta: number | null): Fallback => ({
      run: (ctx) => {
        const wc = target(ctx)?.wc
        if (!wc) return
        // 10% steps, as in SH-45; the zoom service takes over with per-host levels.
        const next = delta === null ? 1 : Math.min(5, Math.max(0.25, Math.round((wc.getZoomFactor() + delta) * 10) / 10))
        wc.setZoomFactor(next)
        menus.invalidate()
      },
    })
    const activeInfo = (ctx: ActionContext) => {
      const snap = ctx.tabs.snapshot()
      return snap.tabs.find((t) => t.id === snap.activeId) ?? null
    }
    const reload = (bypass: boolean): Fallback => ({
      run: (ctx) => {
        const t = target(ctx)
        if (!t) return
        if (t.kind === 'chrome') sendChrome(ctx, 'reload-page')
        else if (bypass) t.wc.reloadIgnoringCache()
        else t.wc.reload()
      },
    })
    this.#fallbackTable = {
      'new-tab': { run: newTab },
      'new-tab-in-group': { run: newTab },
      'focus-address': { run: (ctx) => sendChrome(ctx, 'focus-omnibox') },
      'search-tabs-chats': { run: (ctx) => sendChrome(ctx, 'focus-omnibox') },
      'reopen-closed': { run: (ctx) => void ctx.tabs.reopenClosed(), enabled: (ctx) => ctx.tabs.snapshot().closedCount > 0 },
      'close-tab': { run: closeTab },
      'close-window': { run: () => BrowserWindow.getFocusedWindow()?.close() },
      find: { run: (ctx) => sendChrome(ctx, 'find') },
      'toggle-sidebar': { run: () => chrome.toggleSidebar(), enabled: sidebarLayout },
      'switch-layout': { run: () => void settings.update({ layout: sidebarLayout() ? 'horizontal' : 'sidebar' }) },
      'toggle-panel': { run: (ctx) => sendChrome(ctx, 'toggle-agent', false) },
      'new-chat': { run: (ctx) => sendChrome(ctx, 'new-chat') },
      'toggle-split': { run: () => this.#deps.toggleSplit() },
      'toggle-bookmarks-bar': { run: () => void settings.update({ bookmarksBar: settings.get().bookmarksBar === 'always' ? 'never' : 'always' }) },
      stop: { run: (ctx) => target(ctx)?.wc.stop() },
      reload: reload(false),
      'hard-reload': reload(true),
      'zoom-in': zoom(0.1),
      'zoom-in-equal': zoom(0.1),
      'zoom-out': zoom(-0.1),
      'zoom-reset': zoom(null),
      'actual-size': zoom(null),
      back: { run: (ctx) => { const id = ctx.tabs.activeId(); if (id) ctx.tabs.back(id) }, enabled: (ctx) => activeInfo(ctx)?.canGoBack ?? false },
      forward: { run: (ctx) => ctx.tabs.active()?.view.webContents.navigationHistory.goForward(), enabled: (ctx) => activeInfo(ctx)?.canGoForward ?? false },
      'bookmark-page': { run: () => this.#deps.addBookmark() },
      'open-bookmarks': open('apex://bookmarks'),
      'bookmark-manager': open('apex://bookmarks'),
      'next-entry': step(1),
      'previous-entry': step(-1),
      'next-entry-bracket': step(1),
      'previous-entry-bracket': step(-1),
      'next-tab': step(1),
      'previous-tab': step(-1),
      'select-1': nth(0),
      'select-2': nth(1),
      'select-3': nth(2),
      'select-4': nth(3),
      'select-5': nth(4),
      'select-6': nth(5),
      'select-7': nth(6),
      'select-8': nth(7),
      'select-last': nth('last'),
      minimize: { run: () => BrowserWindow.getFocusedWindow()?.minimize() },
      'minimize-all': { run: () => BrowserWindow.getAllWindows().forEach((w) => w.isMinimizable() && w.minimize()) },
      'toggle-fullscreen': { run: (ctx) => ctx.window.setFullScreen(!ctx.window.isFullScreen()) },
      quit: { run: () => app.quit() },
      'open-settings': open('apex://settings'),
      'open-library': open('apex://chats'),
      'import-data': open('apex://settings/import'),
      'check-default-browser': open('apex://settings/default-browser'),
      'clear-data': { run: (ctx) => sendChrome(ctx, 'clear-data') },
      'close-other-tabs': {
        run: (ctx) => {
          const id = ctx.tabs.activeId()
          ctx.tabs.closeMany(ctx.tabs.all().filter((t) => !t.pinned && t.id !== id).map((t) => t.id))
        },
      },
    }
    return this.#fallbackTable
  }

  #fallbackTable: Partial<Record<CommandId, Fallback>> | null = null
}

interface Fallback {
  run(ctx: ActionContext): void | Promise<void>
  enabled?(ctx: ActionContext): boolean
}

/** Hooks for actions implemented elsewhere (the page actions); the menus feature fills them. */
export const menuActionHooks: Partial<Record<'copy-markdown' | 'screenshot', (win: WindowContext | null, tabId: string | undefined) => void | Promise<void>>> = {}

/** Toasts go through the toast presenter; dropped quietly until it is ready. */
function toastSafely(ctx: ActionContext, text: string): void {
  if (ctx.win) toasts.show(ctx.win, { kind: 'success', text })
}

/**
 * Opens the address bar over a tab just created. The chrome gets tab snapshots
 * batched on the next turn (windowContext's pushTabs), so the command waits a
 * turn too and arrives after the new tab: sent at once, the bar could open on
 * the previous tab's address and commit there.
 */
function focusAddressAfterTabs(ctx: ActionContext): void {
  const window = ctx.win?.window ?? ctx.window
  if (!window.isDestroyed()) window.webContents.focus()
  setImmediate(() => sendChrome(ctx, 'focus-omnibox', false))
}

function sendChrome(ctx: ActionContext, command: MenuCommand | 'clear-data', focus = true): void {
  const window = ctx.win?.window ?? ctx.window
  if (window.isDestroyed()) return
  if (focus) window.webContents.focus()
  window.webContents.send(UI.command, command)
}

/** ⌘W closes a focused popup itself, otherwise the browser window's active tab. */
function closeTab(ctx: ActionContext): void {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && focused !== ctx.window) {
    focused.close()
    return
  }
  if (!ctx.window.isFocused()) return
  // On a destination, ⌘W closes the destination and the tab behind it shows again.
  if (ctx.tabs.rail() !== null) return ctx.tabs.leaveRail()
  const id = ctx.tabs.activeId()
  if (id) ctx.tabs.close(id)
}

/**
 * What reload, zoom and the developer items act on: a focused popup, the
 * chrome itself when it draws the active tab (apex:// pages and the new
 * tab), or the active web page. Null when nothing is focused.
 */
export function target(ctx: { window: BrowserWindow; tabs: TabManager }): { kind: 'popup' | 'chrome' | 'tab'; wc: WebContents } | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && focused !== ctx.window && !focused.isDestroyed()) return { kind: 'popup', wc: focused.webContents }
  const tab = ctx.tabs.active()
  if (!tab) return null
  // A destination on the window-level surface is drawn by the chrome too.
  return ctx.tabs.rail() !== null || ctx.tabs.isChromeDrawn(tab) ? { kind: 'chrome', wc: ctx.window.webContents } : { kind: 'tab', wc: tab.view.webContents }
}

/** The focused surface for MenuState: 'page', 'chrome', a popup, or null. */
function focusedSurface(ctx: ActionContext): string | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (!focused) return null
  if (focused !== ctx.window) return 'popup'
  const t = target(ctx)
  return t?.kind === 'tab' ? 'page' : 'chrome'
}

/**
 * The developer items (SH-53) on the focused surface: the page, a popup or
 * the chrome. A beep when nothing is focused.
 */
export function developerTools(ctx: { window: BrowserWindow; tabs: TabManager }, mode: 'devtools' | 'console'): void {
  if (!BrowserWindow.getFocusedWindow()) return shell.beep()
  const t = target(ctx)
  if (!t || t.wc.isDestroyed()) return shell.beep()
  if (mode === 'console') {
    // DevTools has no API for its starting panel; ask its front end once it is open.
    const show = (): void => void t.wc.devToolsWebContents?.executeJavaScript('globalThis.DevToolsAPI?.showPanel?.("console")').catch(() => undefined)
    if (t.wc.isDevToolsOpened()) show()
    else {
      t.wc.once('devtools-opened', show)
      t.wc.openDevTools()
    }
    return
  }
  t.wc.toggleDevTools()
}

/** Help › Copy Diagnostics: versions only, never anything personal. */
export function diagnosticsText(engine = 'api-key'): string {
  // The diagnostics systemInfo builder: the same details as a problem report's report.json.
  return systemInfoText({ ...collectSystemInfo(engine), ...(menuSources.diagnostics?.() ?? {}) })
}

/** Save Page As (a plain dialog), used when pageActions.savePage isn't available. */
export async function savePageAsDialog(ctx: { window: BrowserWindow; tabs: TabManager }): Promise<string | null> {
  const tab = ctx.tabs.active()
  if (!tab || ctx.tabs.isChromeDrawn(tab)) return null
  const wc = tab.view.webContents
  const name = (wc.getTitle() || 'page').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 120) || 'page'
  const result = await dialog.showSaveDialog(ctx.window, {
    defaultPath: join(app.getPath('downloads'), `${name}.html`),
    filters: [{ name: 'Web page, complete', extensions: ['html', 'htm'] }],
  })
  if (result.canceled || !result.filePath) return null
  await wc.savePage(result.filePath, 'HTMLComplete')
  return result.filePath
}

/** Converts the chrome's menu description into Electron's template; accelerators are shown, not registered. */
export function menuTemplate(items: readonly MenuItemSpec[], pick: (id: string) => void, depth = 0): MenuItemConstructorOptions[] {
  if (depth >= MAX_MENU_DEPTH) throw new Error('The menu is nested too deeply.')
  return items.map((item): MenuItemConstructorOptions => {
    if (item.type === 'separator') return { type: 'separator' }
    if (item.submenu) {
      return { id: item.id, label: item.label, enabled: item.enabled ?? true, submenu: menuTemplate(item.submenu, pick, depth + 1) }
    }
    // Native menus have no destructive style; `danger` items rely on their label (and a confirmation).
    return {
      id: item.id,
      label: item.label,
      type: item.type ?? 'normal',
      enabled: item.enabled ?? true,
      checked: item.checked ?? false,
      ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
      click: () => pick(item.id),
    }
  })
}

/** Shows a native menu at a point in the chrome (CSS pixels) and resolves to the picked id, or null when dismissed. */
export function popupMenu(window: BrowserWindow, items: readonly MenuItemSpec[], x: number, y: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (id: string | null): void => {
      if (settled) return
      settled = true
      resolve(id)
    }
    const menu = Menu.buildFromTemplate(menuTemplate(items, finish))
    const zoom = window.webContents.getZoomFactor() || 1
    menu.popup({
      window,
      x: Math.round(x * zoom),
      y: Math.round(y * zoom),
      // The close callback can run before the click on some platforms; give the click a moment to land first.
      callback: () => setTimeout(() => finish(null), 50),
    })
  })
}

