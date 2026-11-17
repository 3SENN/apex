/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The base menus (SH-50 to SH-58, SH-54): one model for the native menu bar,
// the Dock menu and the main-menu popover. Pure: main fills MenuState and
// MenuData, applies contributions and turns the result into Electron
// templates; the popover renders the main-menu part. Items that run a
// command carry its id and the accelerator from SHORTCUTS; the rest carry an
// action id (MENU_ACTIONS or a prefixed dynamic id) that main runs itself.
import { t } from './i18n/core'
import type { BookmarksBarMode, LayoutMode } from './ipc'
import { MENU_LIMITS, escapeMnemonic, folderRows, menuLabel, pickTabList, recentClosed, recentVisits, type MenuBookmarkNode, type MenuBookmarks, type MenuChat, type MenuTab, type MenuVisit } from './menuLists'
import { applyContributions, menuContributions, type MenuContribution, type MenuItemModel, type MenuState, type MenuTarget } from './menuModel'
import { HOLD_PREFIX, SHORTCUTS, isCommandId, type CommandId, type ShortcutDef } from './shortcuts'
import type { ThemePreference } from './theme'
import type { ClosedEntry } from './windows'

/** What the base menus need beyond MenuState. Main collects it at each rebuild. */
export interface MenuData {
  platform: string
  appName: string
  version: string
  theme: ThemePreference
  layout: LayoutMode
  bookmarksBar: BookmarksBarMode
  warnBeforeQuit: boolean
  adblock: boolean
  sidebarOpen: boolean
  isDefaultBrowser: boolean
  /** The active tab, in list order with the rest. */
  tabs: MenuTab[]
  active: { web: boolean; muted: boolean } | null
  closed: ClosedEntry[]
  visited: MenuVisit[]
  chats: MenuChat[]
  bookmarks: MenuBookmarks
}

/** What the main-menu popover renders (SH-54): main builds it per window. */
export interface MainMenuModel {
  platform: string
  appName: string
  items: MenuItemModel[]
  theme: ThemePreference
  layout: LayoutMode
  /** An AccentChoice: 'companion' or one of ACCENT_HUES. */
  accent: string
  adblock: boolean
  /** The focused surface's zoom; null when nothing can zoom. */
  zoomPercent: number | null
}

/** The 'main-menu' surface's props: main's model plus what the chrome knows. */
export interface MainMenuSurfaceProps {
  model: MainMenuModel
  /** `engine` is the EngineId new chats use. */
  profile: { name: string; avatar: string | null; engine: string; hasApiKey: boolean }
  /** This month's estimated spend on your own key (DS-18's measure); API-key engine only. */
  spend: { usd: number; budgetUsd: number | null } | null
  /** Above the sidebar footer, or below the toolbar's menu button. */
  placement: 'above' | 'below'
}

/** The top-level native menus, in menu-bar order. */
export const NATIVE_TOP: readonly MenuTarget[] = ['app', 'file', 'edit', 'view', 'tabs', 'bookmarks', 'history', 'extensions', 'window', 'help']

/** Action ids main runs itself (no command). Dynamic ids use the prefixes below. */
export const MENU_ACTIONS = [
  'theme-system',
  'theme-light',
  'theme-dark',
  'appearance-settings',
  'layout-sidebar',
  'layout-horizontal',
  'bar-always',
  'bar-newtab',
  'bar-never',
  'warn-before-quit',
  'close-all-tabs',
  'duplicate-tab',
  'mute-site',
  'home',
  'inspect',
  'copy-diagnostics',
  'getting-started',
  'adblock',
  'copy-markdown',
  'screenshot',
  'search-engine',
  'clear-cache',
  'default-browser',
  'manage-profile',
  'zoom-row',
  'rename-window',
] as const

export type MenuAction = (typeof MENU_ACTIONS)[number]

export const DYNAMIC_PREFIXES = {
  tab: 'tab:',
  window: 'window:',
  closed: 'closed:',
  open: 'open:',
  chat: 'chat:',
  openAll: 'open-all:',
  /** Windows and Linux: the main menu's Menu bar rows pop one top-level native menu (SH-59). */
  menubar: 'menubar:',
} as const

/** Main-menu rows the popover draws itself (the zoom row, the appearance flyout). */
export const MAIN_MENU_SPECIAL = { zoom: 'zoom-row', appearance: 'appearance', profile: 'profile' } as const

const sep = (id: string): MenuItemModel => ({ id, label: '', type: 'separator' })

/**
 * The accelerator a menu shows and registers for a shortcut row, or
 * undefined: holds, unmodified keys (Escape would swallow it everywhere) and
 * website-only keys (⌘← would break text editing) stay with the router.
 */
export function menuAccelerator(def: ShortcutDef, platform: string): string | undefined {
  if (def.when === 'website') return undefined
  const keys = platform === 'darwin' ? def.keys.mac : def.keys.other
  if (keys.startsWith(HOLD_PREFIX)) return undefined
  const hasModifier = /(^|\+)(Cmd|Ctrl|CmdOrCtrl|Command|Control|Alt|Option|Shift|Super|Meta)\+/i.test(keys)
  if (!hasModifier && !/^F\d{1,2}$/.test(keys)) return undefined
  return keys
}

const SHORTCUT_BY_ID = new Map(SHORTCUTS.map((s) => [s.id as string, s]))

/** Builds items for one platform. */
function itemsFor(platform: string) {
  const cmd = (id: CommandId, label: string, extra: Partial<MenuItemModel> = {}): MenuItemModel => {
    const def = SHORTCUT_BY_ID.get(id)
    const accelerator = def ? menuAccelerator(def, platform) : undefined
    return { id, label, commandId: id, ...(accelerator ? { accelerator } : {}), ...extra }
  }
  /** A hidden item: no row, but its accelerator works (⌘1–9, Ctrl+Tab, alternates). */
  const hidden = (id: CommandId): MenuItemModel => ({ ...cmd(id, id), id: `hidden:${id}`, visible: false })
  return { cmd, hidden }
}

function radio(id: MenuAction, label: string, checked: boolean): MenuItemModel {
  return { id, label, type: 'radio', checked }
}

function closedLabel(entry: ClosedEntry): string {
  if (entry.kind === 'window') return entry.title ? `${menuLabel(entry.title, '')} · ${t('menus.history.closedWindow', { count: entry.tabCount })}` : t('menus.history.closedWindow', { count: entry.tabCount })
  if (entry.kind === 'chat') return menuLabel(entry.title, t('menus.history.untitledChat'))
  return menuLabel(entry.title || entry.url, t('menus.tabs.untitled'))
}

/** A bookmark folder as a submenu: its rows, a note when some were left out, and Open All. */
export function folderSubmenu(id: string, title: string, children: readonly MenuBookmarkNode[], platform: string, depth = 0): MenuItemModel {
  const { shown, omitted, bookmarks } = folderRows(children)
  const rows: MenuItemModel[] = []
  for (const node of shown) {
    if (node.kind === 'bookmark') rows.push({ id: `${DYNAMIC_PREFIXES.open}${node.url}`, label: escapeMnemonic(menuLabel(node.title, node.url), platform), ...(node.image ? { image: node.image } : {}) })
    else if (depth + 1 < MENU_LIMITS.folderDepth) rows.push(folderSubmenu(node.id, node.title, node.children, platform, depth + 1))
  }
  if (rows.length === 0) rows.push({ id: `empty:${id}`, label: t('menus.bookmarks.empty'), enabled: false, variant: 'note' })
  if (omitted > 0) rows.push({ id: `more:${id}`, label: t('menus.bookmarks.more', { count: omitted }), enabled: false, variant: 'note' })
  if (bookmarks > 0) rows.push(sep(`sep-open-all:${id}`), { id: `${DYNAMIC_PREFIXES.openAll}${id}`, label: t('menus.bookmarks.openAll', { count: bookmarks }) })
  return { id: `folder:${id}`, label: escapeMnemonic(menuLabel(title, t('menus.bookmarks.bar')), platform), icon: 'folder', submenu: rows }
}

/** The base native menus, before contributions. */
export function baseNativeMenus(state: MenuState, data: MenuData): Record<MenuTarget, MenuItemModel[]> {
  const { platform, appName } = data
  const mac = platform === 'darwin'
  const { cmd, hidden } = itemsFor(platform)

  const app: MenuItemModel[] = mac
    ? [
        cmd('about', t('menus.app.about', { name: appName })),
        { id: 'version', label: t('menus.app.version', { version: data.version }), enabled: false },
        sep('app-1'),
        cmd('open-settings', t('menus.app.settings')),
        ...(data.isDefaultBrowser ? [] : [{ id: 'default-browser', label: t('menus.app.makeDefault', { name: appName }) }]),
        cmd('clear-data', t('menus.app.clearData')),
        sep('app-2'),
        { id: 'services', label: '', role: 'services' },
        sep('app-3'),
        { id: 'hide', label: '', role: 'hide' },
        { id: 'hide-others', label: '', role: 'hideOthers' },
        { id: 'show-all', label: '', role: 'unhide' },
        sep('app-4'),
        { id: 'warn-before-quit', label: t('menus.app.warnBeforeQuit'), type: 'checkbox', checked: data.warnBeforeQuit },
        cmd('quit', t('menus.app.quit', { name: appName })),
      ]
    : []

  const file: MenuItemModel[] = [
    cmd('new-tab', t('menus.file.newTab')),
    cmd('new-tab-in-group', t('menus.file.newTabInGroup')),
    cmd('new-window', t('menus.file.newWindow')),
    cmd('new-private-window', t('menus.file.newPrivateWindow')),
    sep('file-1'),
    cmd('reopen-closed', t('menus.file.reopenClosed')),
    cmd('focus-address', t('menus.file.openLocation')),
    sep('file-2'),
    cmd('close-window', t('menus.file.closeWindow')),
    cmd('close-tab', t('menus.file.closeTab')),
    { id: 'close-all-tabs', label: t('menus.file.closeAllTabs'), enabled: data.tabs.some((tab) => !tab.pinned) },
    sep('file-3'),
    // ⌘S belongs to the sidebar, so Save Page As has no shortcut.
    cmd('save-page', t('menus.file.savePage')),
    cmd('save-as-pdf', t('menus.file.savePdf')),
    ...(mac ? [cmd('share', t('menus.file.share'))] : []),
    sep('file-4'),
    cmd('print', t('menus.file.print')),
    ...(mac
      ? []
      : [
          sep('file-5'),
          cmd('open-settings', t('menus.app.settings')),
          ...(data.isDefaultBrowser ? [] : [{ id: 'default-browser', label: t('menus.app.makeDefault', { name: appName }) }]),
          cmd('clear-data', t('menus.app.clearData')),
          { id: 'warn-before-quit', label: t('menus.app.warnBeforeQuit'), type: 'checkbox' as const, checked: data.warnBeforeQuit },
          cmd('quit', t('menus.app.quit', { name: appName })),
        ]),
  ]

  const edit: MenuItemModel[] = [
    { id: 'undo', label: '', role: 'undo' },
    { id: 'redo', label: '', role: 'redo' },
    sep('edit-1'),
    { id: 'cut', label: '', role: 'cut' },
    { id: 'copy', label: '', role: 'copy' },
    { id: 'paste', label: '', role: 'paste' },
    cmd('paste-match-style', t('menus.edit.pasteMatchStyle')),
    { id: 'delete', label: '', role: 'delete' },
    { id: 'select-all', label: '', role: 'selectAll' },
    sep('edit-2'),
    cmd('copy-url', t('menus.edit.copyUrl'), { enabled: data.active?.web ?? false }),
    cmd('copy-markdown-link', t('menus.edit.copyMarkdownLink'), { enabled: data.active?.web ?? false }),
    sep('edit-3'),
    {
      id: 'find-menu',
      label: t('menus.edit.find'),
      submenu: [cmd('find', t('menus.edit.findInPage')), cmd('find-next', t('menus.edit.findNext')), cmd('find-previous', t('menus.edit.findPrevious'))],
    },
    ...(mac
      ? [
          {
            id: 'speech',
            label: t('menus.edit.speech'),
            submenu: [
              { id: 'speech-start', label: '', role: 'startSpeaking' },
              { id: 'speech-stop', label: '', role: 'stopSpeaking' },
            ],
          },
        ]
      : []),
  ]

  const sidebarLayout = data.layout === 'sidebar'
  const view: MenuItemModel[] = [
    {
      id: 'appearance-menu',
      label: t('menus.view.appearance'),
      submenu: [
        radio('theme-system', t('menus.view.themeSystem'), data.theme === 'system'),
        radio('theme-light', t('menus.view.themeLight'), data.theme === 'light'),
        radio('theme-dark', t('menus.view.themeDark'), data.theme === 'dark'),
        sep('view-appearance-1'),
        { id: 'appearance-settings', label: t('menus.view.appearanceSettings') },
      ],
    },
    {
      id: 'layout-menu',
      label: t('menus.view.layout'),
      submenu: [radio('layout-sidebar', t('menus.view.layoutSidebar'), sidebarLayout), radio('layout-horizontal', t('menus.view.layoutTop'), !sidebarLayout), sep('view-layout-1'), cmd('switch-layout', t('menus.view.switchLayout'))],
    },
    cmd('toggle-sidebar', t('menus.view.showSidebar'), { type: 'checkbox', checked: sidebarLayout && data.sidebarOpen, ...(sidebarLayout ? {} : { enabled: false }) }),
    sep('view-1'),
    cmd('toggle-panel', t('menus.view.companionPanel')),
    cmd('new-chat', t('menus.view.newChatBeside')),
    cmd('toggle-split', t('menus.view.splitView')),
    cmd('focus-mode', t('menus.view.focusMode')),
    cmd('toggle-reader', t('reader.menu.toggle'), { type: 'checkbox' }), // reader (RD-04)
    {
      id: 'bar-menu',
      label: t('menus.view.bookmarksBar'),
      submenu: [
        radio('bar-always', t('menus.view.barAlways'), data.bookmarksBar === 'always'),
        radio('bar-newtab', t('menus.view.barNewTab'), data.bookmarksBar === 'newtab'),
        radio('bar-never', t('menus.view.barNever'), data.bookmarksBar === 'never'),
        sep('view-bar-1'),
        cmd('toggle-bookmarks-bar', t('menus.view.toggleBar')),
      ],
    },
    sep('view-2'),
    cmd('stop', t('menus.view.stop')),
    cmd('reload', t('menus.view.reload')),
    cmd('hard-reload', t('menus.view.forceReload')),
    sep('view-3'),
    cmd('zoom-reset', t('menus.view.actualSize')),
    cmd('zoom-in', t('menus.view.zoomIn')),
    hidden('zoom-in-equal'),
    cmd('zoom-out', t('menus.view.zoomOut')),
    sep('view-4'),
    cmd('toggle-fullscreen', t('menus.view.fullScreen')),
    sep('view-5'),
    {
      id: 'developer-menu',
      label: t('menus.view.developer'),
      submenu: [cmd('view-source', t('menus.view.viewSource')), cmd('devtools', t('menus.view.devtools')), { id: 'inspect', label: t('menus.view.inspect') }, cmd('console', t('menus.view.console'))],
    },
  ]

  const { shown, omitted } = pickTabList(data.tabs, state.activeTabId)
  const tabs: MenuItemModel[] = [
    cmd('new-tab-in-group', t('menus.file.newTabInGroup'), { id: 'tabs:new-tab-in-group', accelerator: undefined }),
    sep('tabs-1'),
    cmd('next-entry', t('menus.tabs.next')),
    cmd('previous-entry', t('menus.tabs.previous')),
    hidden('next-tab'),
    hidden('previous-tab'),
    hidden('next-entry-bracket'),
    hidden('previous-entry-bracket'),
    hidden('move-tab-up'),
    hidden('move-tab-down'),
    ...(['select-1', 'select-2', 'select-3', 'select-4', 'select-5', 'select-6', 'select-7', 'select-8', 'select-last'] as const).map(hidden),
    sep('tabs-2'),
    { id: 'duplicate-tab', label: t('menus.tabs.duplicate'), enabled: data.active !== null },
    { id: 'mute-site', label: data.active?.muted ? t('menus.tabs.unmuteSite') : t('menus.tabs.muteSite'), enabled: data.active?.web ?? false },
    cmd('close-tab', t('menus.file.closeTab'), { id: 'tabs:close-tab', accelerator: undefined }),
    sep('tabs-3'),
    cmd('search-tabs-chats', t('menus.tabs.searchTabsChats')),
    ...(shown.length ? [sep('tabs-4')] : []),
    ...shown.map(
      (tab): MenuItemModel => ({
        id: `${DYNAMIC_PREFIXES.tab}${tab.id}`,
        label: escapeMnemonic(menuLabel(tab.title || tab.url, t('menus.tabs.untitled')), platform),
        type: 'checkbox',
        checked: tab.id === state.activeTabId,
        ...(tab.image ? { image: tab.image } : {}),
      }),
    ),
    ...(omitted > 0 ? [{ id: 'tabs-more', label: t('menus.tabs.more', { count: omitted }), enabled: false, variant: 'note' as const }] : []),
  ]

  const recent = data.bookmarks.recent.slice(0, MENU_LIMITS.recentBookmarks)
  const bookmarks: MenuItemModel[] = [
    cmd('bookmark-page', t('menus.bookmarks.bookmarkPage'), { enabled: data.active?.web ?? false }),
    cmd('bookmark-all-tabs', t('menus.bookmarks.bookmarkAll'), { enabled: data.tabs.some((tab) => /^https?:/i.test(tab.url)) }),
    cmd('open-bookmarks', t('menus.bookmarks.manager')),
    ...(recent.length
      ? [
          sep('bookmarks-1'),
          { id: 'bookmarks-recent', label: t('menus.bookmarks.recent'), enabled: false, variant: 'header' as const },
          ...recent.map((b): MenuItemModel => ({ id: `${DYNAMIC_PREFIXES.open}${b.url}`, label: escapeMnemonic(menuLabel(b.title, b.url), platform), ...(b.image ? { image: b.image } : {}) })),
        ]
      : []),
    sep('bookmarks-2'),
    folderSubmenu('bar', t('menus.bookmarks.bar'), data.bookmarks.bar, platform),
    ...(data.bookmarks.other.length ? [folderSubmenu('other', t('menus.bookmarks.other'), data.bookmarks.other, platform)] : []),
  ]

  const closed = recentClosed(data.closed)
  const visited = recentVisits(data.visited)
  const chats = data.chats.slice(0, MENU_LIMITS.chats)
  const history: MenuItemModel[] = [
    cmd('back', t('menus.history.back')),
    cmd('forward', t('menus.history.forward')),
    { id: 'home', label: t('menus.history.home') },
    sep('history-1'),
    {
      id: 'recently-closed',
      label: t('menus.history.recentlyClosed'),
      submenu: closed.length
        ? closed.map((entry, i): MenuItemModel => ({ id: `${DYNAMIC_PREFIXES.closed}${i}`, label: escapeMnemonic(closedLabel(entry), platform) }))
        : [{ id: 'closed-none', label: t('menus.history.closedNothing'), enabled: false, variant: 'note' }],
    },
    ...(mac ? [] : [cmd('clear-data', t('menus.app.clearData'), { id: 'history:clear-data', accelerator: undefined })]),
    ...(visited.length
      ? [
          sep('history-2'),
          { id: 'history-visited', label: t('menus.history.recentlyVisited'), enabled: false, variant: 'header' as const },
          ...visited.map((v): MenuItemModel => ({ id: `${DYNAMIC_PREFIXES.open}${v.url}`, label: escapeMnemonic(menuLabel(v.title, v.url), platform), ...(v.image ? { image: v.image } : {}) })),
        ]
      : []),
    sep('history-3'),
    { id: 'history-chats', label: t('menus.history.recentChats'), enabled: false, variant: 'header' },
    ...(chats.length
      ? chats.map((c): MenuItemModel => ({ id: `${DYNAMIC_PREFIXES.chat}${c.id}`, label: escapeMnemonic(menuLabel(c.title, t('menus.history.untitledChat')), platform) }))
      : [{ id: 'chats-none', label: t('menus.history.noChats'), enabled: false, variant: 'note' as const }]),
    cmd('open-library', t('menus.history.allChats')),
    sep('history-4'),
    cmd('open-history', t('menus.history.showAll')),
  ]

  const window: MenuItemModel[] = [
    cmd('minimize', t('menus.window.minimize')),
    ...(mac ? [{ id: 'zoom-window', label: '', role: 'zoom' }] : []),
    cmd('minimize-all', t('menus.window.minimizeAll')),
    ...(mac ? [sep('window-1'), { id: 'front', label: '', role: 'front' }] : []),
    sep('window-2'),
    cmd('open-downloads', t('menus.window.downloads')),
    ...(state.windows.length ? [sep('window-3')] : []),
    ...state.windows.map(
      (w): MenuItemModel => ({
        id: `${DYNAMIC_PREFIXES.window}${w.id}`,
        label: w.kind === 'private' ? t('menus.window.private', { title: escapeMnemonic(menuLabel(w.title, t('menus.window.untitled')), platform) }) : escapeMnemonic(menuLabel(w.title, t('menus.window.untitled')), platform),
        type: 'checkbox',
        checked: w.focused,
      }),
    ),
  ]

  const help: MenuItemModel[] = [
    cmd('shortcuts-sheet', t('menus.help.shortcuts')),
    cmd('help', t('menus.help.topics', { name: appName })),
    { id: 'getting-started', label: t('menus.help.gettingStarted') },
    sep('help-1'),
    { id: 'copy-diagnostics', label: t('menus.help.copyDiagnostics') },
    ...(mac ? [] : [sep('help-2'), cmd('about', t('menus.app.about', { name: appName }))]),
  ]

  return {
    app,
    file,
    edit,
    view,
    tabs,
    bookmarks,
    history,
    window,
    help,
    extensions: [],
    dock: [],
    tray: [],
    'main-menu': [],
    'main-menu:profile': [],
    'main-menu:tools': [],
    'main-menu:help': [],
  }
}

/** Labels of the top-level native menus; app takes the app's name. */
export function topLabel(target: MenuTarget, appName: string): string {
  switch (target) {
    case 'app':
      return appName
    case 'file':
      return t('menus.top.file')
    case 'edit':
      return t('menus.top.edit')
    case 'view':
      return t('menus.top.view')
    case 'tabs':
      return t('menus.top.tabs')
    case 'bookmarks':
      return t('menus.top.bookmarks')
    case 'history':
      return t('menus.top.history')
    case 'window':
      return t('menus.top.window')
    case 'help':
      return t('menus.top.help')
    case 'extensions':
      return t('menus.top.extensions')
    default:
      return target
  }
}

/** Every native menu with contributions applied; `owners` hears which contribution built each item. */
export function nativeMenus(state: MenuState, data: MenuData, owners?: Map<string, MenuContribution>): Record<MenuTarget, MenuItemModel[]> {
  const base = baseNativeMenus(state, data)
  const out = { ...base }
  for (const target of [...NATIVE_TOP, 'dock', 'tray'] as MenuTarget[]) out[target] = applyContributions(target, base[target], state, owners)
  return out
}

/**
 * The main-menu popover's rows (SH-54), contributions applied: tabs,
 * bookmarks, history, downloads and tool rows; appearance, save and share,
 * more tools; update rows and the default-browser banner; help and settings.
 * No account, plan or upgrade rows.
 */
export function mainMenuItems(state: MenuState, data: MenuData, owners?: Map<string, MenuContribution>): MenuItemModel[] {
  const { platform, appName } = data
  const mac = platform === 'darwin'
  const { cmd } = itemsFor(platform)
  const visited = recentVisits(data.visited, MENU_LIMITS.mainHistory)
  const profile = applyContributions('main-menu:profile', [], state, owners)
  const tools = applyContributions('main-menu:tools', [cmd('open-downloads', t('menus.main.downloads'), { icon: 'download' })], state, owners)
  const banner = applyContributions('main-menu', data.isDefaultBrowser ? [] : [{ id: 'default-browser', label: t('menus.main.defaultBanner', { name: appName }), icon: 'globe' }], state, owners)
  const help = applyContributions(
    'main-menu:help',
    [cmd('shortcuts-sheet', t('menus.help.shortcuts')), cmd('help', t('menus.help.topics', { name: appName })), { id: 'getting-started', label: t('menus.help.gettingStarted') }, cmd('about', t('menus.main.about', { name: appName }))],
    state,
    owners,
  )
  const group = (id: string, items: MenuItemModel[]): MenuItemModel[] => (items.length ? [sep(id), ...items] : [])
  return [
    ...profile,
    ...group('main-1', [
      {
        id: 'tabs-menu',
        label: t('menus.main.tabs'),
        icon: 'tabs',
        submenu: [
          cmd('new-tab', t('menus.main.newTab')),
          cmd('new-window', t('menus.main.newWindow')),
          cmd('new-private-window', t('menus.main.newPrivateWindow')),
          cmd('search-tabs-chats', t('menus.main.searchTabsChats')),
          sep('main-tabs-1'),
          cmd('reopen-closed', t('menus.file.reopenClosed')),
        ],
      },
      {
        id: 'bookmarks-menu',
        label: t('menus.main.bookmarks'),
        icon: 'bookmark',
        submenu: [
          cmd('bookmark-page', t('menus.main.bookmarkTab'), { enabled: data.active?.web ?? false }),
          cmd('bookmark-all-tabs', t('menus.main.bookmarkAll'), { enabled: data.tabs.some((tab) => /^https?:/i.test(tab.url)) }),
          {
            id: 'main-bar-menu',
            label: t('menus.main.barVisibility'),
            submenu: [
              radio('bar-always', t('menus.view.barAlways'), data.bookmarksBar === 'always'),
              radio('bar-newtab', t('menus.view.barNewTab'), data.bookmarksBar === 'newtab'),
              radio('bar-never', t('menus.view.barNever'), data.bookmarksBar === 'never'),
            ],
          },
          sep('main-bookmarks-1'),
          cmd('open-bookmarks', t('menus.main.bookmarkManager')),
        ],
      },
      {
        id: 'history-menu',
        label: t('menus.main.history'),
        icon: 'history',
        submenu: [
          ...(visited.length
            ? visited.map((v): MenuItemModel => ({ id: `${DYNAMIC_PREFIXES.open}${v.url}`, label: menuLabel(v.title, v.url), ...(v.image ? { image: v.image } : {}) }))
            : [{ id: 'history-empty', label: t('menus.main.historyEmpty'), enabled: false, variant: 'note' as const }]),
          sep('main-history-1'),
          cmd('open-history', t('menus.main.showHistory')),
        ],
      },
      ...tools,
    ]),
    ...group('main-2', [
      {
        id: MAIN_MENU_SPECIAL.appearance,
        label: t('menus.main.appearance'),
        icon: 'palette',
        // The popover draws a compact flyout; these rows are its native-equivalent fallback.
        submenu: [
          radio('theme-system', t('menus.view.themeSystem'), data.theme === 'system'),
          radio('theme-light', t('menus.view.themeLight'), data.theme === 'light'),
          radio('theme-dark', t('menus.view.themeDark'), data.theme === 'dark'),
          sep('main-appearance-1'),
          radio('layout-sidebar', t('menus.main.layoutSidebar'), data.layout === 'sidebar'),
          radio('layout-horizontal', t('menus.main.layoutTop'), data.layout === 'horizontal'),
          sep('main-appearance-2'),
          { id: 'appearance-settings', label: t('menus.view.appearanceSettings') },
        ],
      },
      {
        id: 'save-share-menu',
        label: t('menus.main.saveShare'),
        icon: 'share',
        submenu: [
          { id: 'copy-markdown', label: t('menus.main.copyMarkdown'), enabled: data.active?.web ?? false },
          { id: 'screenshot', label: t('menus.main.screenshot'), enabled: data.active !== null },
          cmd('save-as-pdf', t('menus.main.savePdf'), { enabled: data.active?.web ?? false }),
          cmd('save-page', t('menus.main.savePage'), { enabled: data.active?.web ?? false }),
          ...(mac ? [cmd('share', t('menus.main.share'), { enabled: data.active?.web ?? false })] : []),
        ],
      },
      {
        id: 'more-tools-menu',
        label: t('menus.main.moreTools'),
        icon: 'wrench',
        submenu: [
          { id: 'adblock', label: t('menus.main.adblock'), type: 'checkbox', variant: 'switch', checked: data.adblock },
          sep('main-tools-1'),
          cmd('print', t('menus.main.print')),
          cmd('find', t('menus.main.find')),
          { id: MAIN_MENU_SPECIAL.zoom, label: t('menus.main.zoom') },
          sep('main-tools-2'),
          { id: 'rename-window', label: t('menus.main.renameWindow') },
          { id: 'search-engine', label: t('menus.main.searchEngine') },
          { id: 'clear-cache', label: t('menus.main.clearCache') },
          cmd('devtools', t('menus.main.devtools')),
        ],
      },
    ]),
    ...group('main-3', banner),
    ...group('main-4', [
      ...menuBarRow(state, data),
      { id: 'help-menu', label: t('menus.main.help'), icon: 'help', submenu: help },
      cmd('open-settings', t('menus.main.settings'), { icon: 'settings' }),
    ]),
  ]
}

/**
 * Windows and Linux have no global menu bar and Apex's window has no native
 * one, so the main menu offers every top-level menu (SH-59): choosing a row
 * pops that native menu beside the anchor. macOS keeps its menu bar.
 */
function menuBarRow(state: MenuState, data: MenuData): MenuItemModel[] {
  if (data.platform === 'darwin') return []
  const base = baseNativeMenus(state, data)
  const targets = NATIVE_TOP.filter((target) => target !== 'app' && (base[target].length > 0 || menuContributions(target).length > 0))
  return [
    {
      id: 'menubar-menu',
      label: t('menus.main.menuBar'),
      icon: 'menu',
      submenu: targets.map((target): MenuItemModel => ({ id: `${DYNAMIC_PREFIXES.menubar}${target}`, label: topLabel(target, data.appName) })),
    },
  ]
}

/** The top-level menu a Menu bar row names, or null. */
export function menuBarTarget(id: string): MenuTarget | null {
  if (!id.startsWith(DYNAMIC_PREFIXES.menubar)) return null
  const target = id.slice(DYNAMIC_PREFIXES.menubar.length) as MenuTarget
  return NATIVE_TOP.includes(target) && target !== 'app' ? target : null
}

/** Every item in a tree, depth first. */
export function flattenMenu(items: readonly MenuItemModel[]): MenuItemModel[] {
  const out: MenuItemModel[] = []
  for (const item of items) {
    out.push(item)
    if (item.submenu) out.push(...flattenMenu(item.submenu))
  }
  return out
}

/** Resolves enabled and checked from command availability: a command item is enabled only when its command is registered and enabled (or a fallback runs it). */
export function resolveStates(items: readonly MenuItemModel[], available: (id: CommandId) => { enabled: boolean; checked?: boolean } | null): MenuItemModel[] {
  return items.map((item) => {
    const submenu = item.submenu ? resolveStates(item.submenu, available) : undefined
    if (!item.commandId || !isCommandId(item.commandId)) return submenu ? { ...item, submenu } : item
    const state = available(item.commandId)
    const enabled = (state?.enabled ?? false) && item.enabled !== false
    const checked = item.checked ?? state?.checked
    return { ...item, enabled, ...(checked === undefined ? {} : { checked }), ...(submenu ? { submenu } : {}) }
  })
}
