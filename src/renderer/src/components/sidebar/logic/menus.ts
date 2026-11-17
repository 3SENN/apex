/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Native menu descriptions for the shell: the tab menu, the chat menu, the
// sidebar background menu and the main (profile) menu. Builders are pure and
// return ids the caller acts on, so the wording and enabled states are tested.
import type { ChatSummary } from '@shared/chats'
import type { BookmarksBarMode, LayoutMode, TabInfo } from '@shared/ipc'
import type { MenuItemSpec } from '@shared/menu'
import type { ThemePreference } from '@shared/theme'
import { isBlankUrl, isInternalUrl } from '@shared/url'
import { t, type MessageKey } from '@shared/i18n/core'
import { GROUP_COLORS, type TabGroup } from '@shared/tabs'

const sep = (n: number): MenuItemSpec => ({ id: `sep-${n}`, label: '', type: 'separator' })

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Pages that can be bookmarked or copied as a link. */
export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

export interface TabMenuContext {
  tab: TabInfo
  /** The rows in list order (pinned first), for "close below". */
  tabs: readonly TabInfo[]
  split: { primaryId: string; secondaryId: string } | null
  closedCount: number
  bookmarked: boolean
  /** Other tabs to pair with, most recent first. */
  splitCandidates: readonly TabInfo[]
  /** What the menu acts on: the selection when the row is in it, else the row (SH-25). */
  targets?: readonly TabInfo[]
  /** The window's groups, for Add to Group. */
  groups?: readonly TabGroup[]
  /** How many tabs the window has (Move to New Window needs more than one). */
  windowTabCount?: number
  /** The bookmark folders, for Bookmark In (SH-19); without them the item saves to the bar. */
  bookmarkFolders?: readonly { id: string; title: string; depth: number }[]
}

/** Save the page in a folder: `bookmark-in:<folder id>`. */
export const BOOKMARK_IN = 'bookmark-in:'

export const SPLIT_WITH = 'split-with:'
/** Add to an existing group: `add-to-group:<id>`. */
export const ADD_TO_GROUP = 'add-to-group:'

/**
 * Whether Group tabs (DC-18) has something to work with: two ungrouped,
 * unpinned web tabs, or one and a named group it could join.
 */
export function canAutoGroup(tabs: readonly TabInfo[], groups: readonly TabGroup[]): boolean {
  const free = tabs.filter((t) => !t.pinned && t.groupId === null && isWebUrl(t.url)).length
  return free >= 2 || (free === 1 && groups.some((g) => g.name.trim() !== ''))
}

/**
 * The tab context menu (SH-19). With several selected tabs it becomes the
 * bulk version: counts on bulk items, and split pairs the two directly.
 */
export function tabMenu({ tab, tabs, split, closedCount, bookmarked, splitCandidates, targets: given, groups = [], windowTabCount, bookmarkFolders = [] }: TabMenuContext): MenuItemSpec[] {
  const targets = given && given.length > 0 ? given : [tab]
  const n = targets.length
  const many = n > 1
  const counted = (key: MessageKey): string => t(key, { count: n })
  const inSplit = split !== null && (split.primaryId === tab.id || split.secondaryId === tab.id)
  const unpinnedOthers = tabs.filter((t) => !t.pinned && t.id !== tab.id).length
  const index = tabs.findIndex((t) => t.id === tab.id)
  const below = index === -1 ? 0 : tabs.slice(index + 1).filter((t) => !t.pinned).length
  const unpinned = tabs.filter((t) => !t.pinned).length
  const web = isWebUrl(tab.url)
  const candidates = splitCandidates.filter((t) => t.id !== tab.id).slice(0, 8)
  const allPinned = targets.every((x) => x.pinned)
  const allMuted = targets.every((x) => x.muted)
  const anyGrouped = targets.some((x) => x.groupId !== null)
  const groupable = targets.filter((x) => !x.pinned)
  const total = windowTabCount ?? tabs.length
  const unpinnedTargets = targets.filter((x) => !x.pinned).length

  const splitItem: MenuItemSpec = many
    ? { id: 'split-pair', label: t('tabs.menu.splitPair'), enabled: n === 2 && !inSplit }
    : inSplit
      ? { id: 'split-separate', label: t('tabs.sidebarMenus.separateSplitView') }
      : {
          id: 'split',
          label: t('tabs.sidebarMenus.openInSplitView'),
          enabled: candidates.length > 0,
          submenu: candidates.length
            ? candidates.map((tab) => ({ id: `${SPLIT_WITH}${tab.id}`, label: tab.title || t('tabs.sidebarMenus.newTab') }))
            : [{ id: 'split-none', label: t('tabs.sidebarMenus.noOtherTabs'), enabled: false }],
        }

  const groupItems: MenuItemSpec[] = [
    {
      id: 'group',
      label: many ? counted('tabs.menu.addManyToGroup') : t('tabs.menu.addToGroup'),
      enabled: groupable.length > 0,
      submenu: [
        { id: 'group-new', label: t('tabs.menu.newGroup') },
        ...(groups.length ? [sep(40)] : []),
        ...groups.map((g) => ({ id: `${ADD_TO_GROUP}${g.id}`, label: g.name || t(`tabs.groupColor.${g.color}` as MessageKey), enabled: !targets.every((x) => x.groupId === g.id) })),
      ],
    },
    ...(anyGrouped ? [{ id: 'group-remove', label: many ? counted('tabs.menu.removeManyFromGroup') : t('tabs.menu.removeFromGroup') }] : []),
    // DC-18: by site, or by topic with the decision model; the selected tabs, else the window's.
    { id: 'group-auto', label: many ? counted('tabs.menu.groupManyTabs') : t('tabs.menu.groupTabs'), enabled: canAutoGroup(many ? targets : tabs, groups) },
    { id: 'move-window', label: many ? counted('tabs.menu.moveManyToWindow') : t('tabs.menu.moveToWindow'), enabled: total > 1 && n < total },
  ]

  if (many) {
    return [
      { id: 'new-tab-next', label: t('tabs.sidebarMenus.newTabBelow') },
      { id: 'reopen', label: t('tabs.sidebarMenus.reopenClosedTab'), accelerator: 'CmdOrCtrl+Shift+T', enabled: closedCount > 0 },
      sep(1),
      splitItem,
      sep(2),
      ...groupItems,
      sep(3),
      { id: 'reload', label: counted('tabs.menu.reloadMany') },
      { id: 'duplicate', label: counted('tabs.menu.duplicateMany') },
      { id: allPinned ? 'unpin' : 'pin', label: counted(allPinned ? 'tabs.menu.unpinMany' : 'tabs.menu.pinMany') },
      { id: allMuted ? 'unmute' : 'mute', label: counted(allMuted ? 'tabs.menu.unmuteMany' : 'tabs.menu.muteMany') },
      { id: 'bookmark-many', label: counted('tabs.menu.bookmarkMany'), enabled: targets.some((x) => isWebUrl(x.url)) },
      sep(4),
      { id: 'close', label: t('tabs.menu.closeMany', { count: unpinnedTargets }), accelerator: 'CmdOrCtrl+W', enabled: unpinnedTargets > 0 },
    ]
  }

  return [
    { id: 'new-tab-next', label: t('tabs.sidebarMenus.newTabBelow') },
    { id: 'reopen', label: t('tabs.sidebarMenus.reopenClosedTab'), accelerator: 'CmdOrCtrl+Shift+T', enabled: closedCount > 0 },
    sep(1),
    splitItem,
    sep(2),
    ...groupItems,
    sep(5),
    { id: 'reload', label: t('tabs.sidebarMenus.reload'), accelerator: 'CmdOrCtrl+R', enabled: !isBlankUrl(tab.url) },
    { id: 'duplicate', label: t('tabs.sidebarMenus.duplicate') },
    { id: 'copy-link', label: t('tabs.sidebarMenus.copyLink'), enabled: web },
    { id: tab.pinned ? 'unpin' : 'pin', label: tab.pinned ? t('tabs.sidebarMenus.unpinTab') : t('tabs.sidebarMenus.pinTab') },
    { id: tab.muted ? 'unmute' : 'mute', label: tab.muted ? t('tabs.sidebarMenus.unmuteSite') : t('tabs.sidebarMenus.muteSite'), enabled: web },
    ...(bookmarked
      ? [
          { id: 'edit-bookmark', label: t('tabs.menu.editBookmark'), enabled: web },
          { id: 'unbookmark', label: t('tabs.sidebarMenus.removeBookmark'), enabled: web },
        ]
      : bookmarkFolders.length > 0
        ? [
            {
              id: 'bookmark-in',
              label: t('tabs.menu.bookmarkIn'),
              enabled: web,
              submenu: bookmarkFolders.map((f) => ({ id: `${BOOKMARK_IN}${f.id}`, label: `${'   '.repeat(Math.min(4, f.depth))}${f.title}` })),
            },
          ]
        : [{ id: 'bookmark', label: t('tabs.sidebarMenus.bookmarkPage'), enabled: web }]),
    // WA-01: a site you use a lot, kept as an app (Workspace › Apps).
    { id: 'save-app', label: t('platform.webApps.saveTab'), enabled: web },
    sep(3),
    { id: 'close', label: t('tabs.sidebarMenus.closeTab'), accelerator: 'CmdOrCtrl+W' },
    { id: 'close-others', label: unpinnedOthers > 1 ? t('tabs.sidebarMenus.closeOtherTabs', { unpinnedOthers }) : t('tabs.sidebarMenus.closeOtherTabs2'), enabled: unpinnedOthers > 0 },
    { id: 'close-below', label: below > 1 ? t('tabs.sidebarMenus.closeTabsBelow', { below }) : t('tabs.sidebarMenus.closeTabsBelow2'), enabled: below > 0 },
    { id: 'close-unpinned', label: unpinned > 1 ? t('tabs.sidebarMenus.closeAllUnpinnedTabs', { unpinned }) : t('tabs.sidebarMenus.closeAllUnpinnedTabs2'), enabled: unpinned > 0 },
  ]
}

/** Prefixes for a split row's per-page submenus (SH-19). */
export const SPLIT_PAGE = ['page0:', 'page1:'] as const

/**
 * A split row's menu: separate and swap first, then one submenu per page
 * holding that page's own menu (its ids prefixed with page0: or page1:).
 */
export function splitRowMenu(left: TabMenuContext, right: TabMenuContext): MenuItemSpec[] {
  const prefixed = (items: MenuItemSpec[], prefix: string): MenuItemSpec[] =>
    items.map((i) => ({ ...i, id: i.type === 'separator' ? `${prefix}${i.id}` : `${prefix}${i.id}`, submenu: i.submenu ? prefixed(i.submenu, prefix) : undefined }))
  const page = (ctx: TabMenuContext, prefix: string): MenuItemSpec[] => prefixed(tabMenu({ ...ctx, targets: [ctx.tab] }).filter((i) => i.id !== 'split-separate' && i.id !== 'split'), prefix)
  return [
    { id: 'split-separate', label: t('tabs.sidebarMenus.separateSplitView') },
    { id: 'split-swap', label: t('tabs.split.swap') },
    sep(60),
    { id: 'page0', label: left.tab.title || t('tabs.sidebarMenus.newTab'), submenu: page(left, SPLIT_PAGE[0]) },
    { id: 'page1', label: right.tab.title || t('tabs.sidebarMenus.newTab'), submenu: page(right, SPLIT_PAGE[1]) },
  ]
}

/** The group header's menu (SH-24). */
export function groupMenu(group: TabGroup, count: number): MenuItemSpec[] {
  return [
    { id: 'toggle', label: group.collapsed ? t('tabs.group.expand') : t('tabs.group.collapse') },
    { id: 'rename', label: t('tabs.group.rename') },
    {
      id: 'color',
      label: t('tabs.group.color'),
      submenu: GROUP_COLORS.map((c) => ({ id: `color:${c}`, label: t(`tabs.groupColor.${c}` as MessageKey), type: 'radio' as const, checked: group.color === c })),
    },
    sep(70),
    { id: 'new-tab', label: t('tabs.group.newTab'), accelerator: 'Alt+CmdOrCtrl+T' },
    { id: 'ungroup', label: t('tabs.group.ungroup') },
    sep(71),
    { id: 'close', label: t('tabs.group.close', { count }), danger: true },
  ]
}

// The projectSubmenu, set by sidebar/chatActions.ts so this module stays pure
let projectMenu: ((chatIds: string[]) => MenuItemSpec) | null = null

/** Sets the "Move to project" submenu builder the chat menu adds; null removes it. */
export function setChatProjectMenu(build: ((chatIds: string[]) => MenuItemSpec) | null): void {
  projectMenu = build
}

/**
 * The chat menu (sidebar rows and All chats). With several chats it becomes
 * the bulk version: counts in the labels and only actions that make sense
 * for many.
 */
export function chatMenu(chats: readonly ChatSummary[], { inSidebar }: { inSidebar: boolean }): MenuItemSpec[] {
  if (chats.length === 0) return []
  const many = chats.length > 1
  const n = chats.length
  const allPinned = chats.every((c) => c.pinned)
  const anyUnread = chats.some((c) => c.unread)
  const allArchived = chats.every((c) => c.archived)
  const count = (label: string): string => (many ? t('tabs.sidebarMenus.withCount', { label, count: n }) : label)
  const items: MenuItemSpec[] = []
  if (!many) {
    items.push({ id: 'open', label: t('tabs.sidebarMenus.open') }, { id: 'open-new-tab', label: t('tabs.sidebarMenus.openInNewTab') }, sep(1))
  }
  items.push(
    { id: allPinned ? 'unpin' : 'pin', label: count(allPinned ? t('tabs.sidebarMenus.unpin') : t('tabs.sidebarMenus.pin')) },
    { id: anyUnread ? 'mark-read' : 'mark-unread', label: anyUnread ? count(t('tabs.sidebarMenus.markRead')) : count(t('tabs.sidebarMenus.markUnread')) },
  )
  if (!many) items.push({ id: 'rename', label: t('tabs.sidebarMenus.rename') }, { id: 'duplicate', label: t('tabs.sidebarMenus.duplicate') })
  items.push({ id: allArchived ? 'unarchive' : 'archive', label: count(allArchived ? t('tabs.sidebarMenus.restore') : t('tabs.sidebarMenus.archive')) })
  // CH-36; the project submenu, registered by the renderer; private chats are never saved
  const saved = chats.filter((c) => !c.draft && !c.private)
  if (saved.length === n) {
    if (projectMenu) items.push(projectMenu(saved.map((c) => c.id)))
    items.push({ id: 'export', label: many ? t('tabs.sidebarMenus.exportChats', { count: n }) : t('tabs.sidebarMenus.export2') })
  }
  items.push(sep(2))
  if (inSidebar) items.push({ id: 'close', label: many ? t('tabs.sidebarMenus.closeChats', { count: n }) : t('tabs.sidebarMenus.closeChat') })
  items.push({ id: 'delete', label: many ? t('tabs.sidebarMenus.deleteChats', { count: n }) : t('tabs.sidebarMenus.delete2'), danger: true })
  return items
}

export interface ShellMenuContext {
  layout: LayoutMode
  sidebarOpen: boolean
  theme: ThemePreference
  closedCount: number
  /** Unpinned tabs, for "close all". */
  unpinnedCount: number
  /** Open web pages not bookmarked yet. */
  bookmarkable: number
  /** Group tabs (DC-18) has tabs to group; offered enabled when not given. */
  canGroup?: boolean
}

function layoutItems({ layout, sidebarOpen }: ShellMenuContext): MenuItemSpec[] {
  const items: MenuItemSpec[] = [
    { id: 'layout-sidebar', label: t('tabs.sidebarMenus.tabsInSidebar'), type: 'radio', checked: layout === 'sidebar' },
    { id: 'layout-horizontal', label: t('tabs.sidebarMenus.tabsAlongTheTop'), type: 'radio', checked: layout === 'horizontal' },
  ]
  if (layout === 'sidebar') items.push(sep(20), { id: 'toggle-sidebar', label: t('tabs.sidebarMenus.showSidebar'), type: 'checkbox', checked: sidebarOpen, accelerator: 'CmdOrCtrl+S' })
  return items
}

function themeItems({ theme }: ShellMenuContext): MenuItemSpec[] {
  return [
    { id: 'theme-system', label: t('tabs.sidebarMenus.matchSystem'), type: 'radio', checked: theme === 'system' },
    { id: 'theme-light', label: t('tabs.sidebarMenus.light'), type: 'radio', checked: theme === 'light' },
    { id: 'theme-dark', label: t('tabs.sidebarMenus.dark'), type: 'radio', checked: theme === 'dark' },
    sep(30),
    { id: 'appearance-settings', label: t('tabs.sidebarMenus.appearanceSettings') },
  ]
}

/** Right-click on empty sidebar or strip space. */
export function backgroundMenu(ctx: ShellMenuContext): MenuItemSpec[] {
  return [
    { id: 'new-tab', label: t('tabs.sidebarMenus.newTab'), accelerator: 'CmdOrCtrl+T' },
    { id: 'reopen', label: t('tabs.sidebarMenus.reopenClosedTab'), accelerator: 'CmdOrCtrl+Shift+T', enabled: ctx.closedCount > 0 },
    { id: 'bookmark-all', label: ctx.bookmarkable > 1 ? t('tabs.sidebarMenus.bookmarkTabs', { bookmarkable: ctx.bookmarkable }) : t('tabs.sidebarMenus.bookmarkAllTabs'), enabled: ctx.bookmarkable > 0 },
    { id: 'close-all', label: t('tabs.sidebarMenus.closeAllTabs'), enabled: ctx.unpinnedCount > 0 },
    { id: 'group-auto', label: t('tabs.menu.groupTabs'), enabled: ctx.canGroup ?? true },
    sep(1),
    {
      id: 'layout',
      label: t('tabs.sidebarMenus.layout'),
      submenu: [
        ...layoutItems(ctx),
        sep(21),
        { id: 'toggle-agent', label: t('tabs.sidebarMenus.companionPanel'), accelerator: 'CmdOrCtrl+J' },
        { id: 'new-chat-beside', label: t('tabs.sidebarMenus.newChatBesidePage'), accelerator: 'CmdOrCtrl+Shift+E' },
      ],
    },
    { id: 'appearance', label: t('tabs.sidebarMenus.appearance'), submenu: themeItems(ctx) },
    sep(2),
    { id: 'rename-window', label: t('tabs.sidebarMenus.nameThisWindow') },
  ]
}

export interface MainMenuContext extends ShellMenuContext {
  hasApiKey: boolean
  bookmarksBar: BookmarksBarMode
  /** The active tab can be bookmarked and is not yet. */
  canBookmark: boolean
}

/** The profile row's menu as a native menu (the popover is the usual form). No account or plan items. */
export function mainMenu(ctx: MainMenuContext): MenuItemSpec[] {
  return [
    { id: 'profile', label: t('tabs.sidebarMenus.yourNameAndPicture') },
    ...(ctx.hasApiKey ? [] : [{ id: 'api-key', label: t('tabs.sidebarMenus.addYourApiKey') }]),
    sep(1),
    { id: 'new-tab', label: t('tabs.sidebarMenus.newTab'), accelerator: 'CmdOrCtrl+T' },
    { id: 'new-chat-beside', label: t('tabs.sidebarMenus.newChatBesidePage'), accelerator: 'CmdOrCtrl+Shift+E' },
    { id: 'reopen', label: t('tabs.sidebarMenus.reopenClosedTab'), accelerator: 'CmdOrCtrl+Shift+T', enabled: ctx.closedCount > 0 },
    sep(2),
    { id: 'dest-chats', label: t('tabs.sidebarMenus.allChats'), accelerator: 'CmdOrCtrl+Shift+L' },
    { id: 'dest-routines', label: t('tabs.sidebarMenus.routines') },
    { id: 'dest-skills', label: t('tabs.sidebarMenus.skills') },
    { id: 'dest-connectors', label: t('tabs.sidebarMenus.connectors') },
    sep(3),
    { id: 'bookmark', label: t('tabs.sidebarMenus.bookmarkThisPage'), accelerator: 'CmdOrCtrl+D', enabled: ctx.canBookmark },
    { id: 'bookmark-all', label: t('tabs.sidebarMenus.bookmarkAllTabs'), enabled: ctx.bookmarkable > 0 },
    {
      id: 'bookmarks-bar',
      label: t('tabs.sidebarMenus.bookmarksBar'),
      submenu: [
        { id: 'bar-always', label: t('tabs.sidebarMenus.always'), type: 'radio', checked: ctx.bookmarksBar === 'always' },
        { id: 'bar-newtab', label: t('tabs.sidebarMenus.onNewTabsOnly'), type: 'radio', checked: ctx.bookmarksBar === 'newtab' },
        { id: 'bar-never', label: t('tabs.sidebarMenus.never'), type: 'radio', checked: ctx.bookmarksBar === 'never' },
      ],
    },
    { id: 'bookmarks', label: t('tabs.sidebarMenus.allBookmarks'), accelerator: 'CmdOrCtrl+Alt+B' },
    { id: 'history', label: t('tabs.sidebarMenus.history'), accelerator: 'CmdOrCtrl+Y' },
    { id: 'downloads', label: t('tabs.sidebarMenus.downloads'), accelerator: 'CmdOrCtrl+Shift+J' },
    sep(4),
    { id: 'appearance', label: t('tabs.sidebarMenus.appearance'), submenu: [...themeItems(ctx).slice(0, 3), sep(31), ...layoutItems(ctx), sep(32), { id: 'appearance-settings', label: t('tabs.sidebarMenus.appearanceSettings') }] },
    { id: 'find', label: t('tabs.sidebarMenus.findInPage'), accelerator: 'CmdOrCtrl+F' },
    { id: 'rename-window', label: t('tabs.sidebarMenus.nameThisWindow') },
    sep(5),
    // The getting-started plan (ON-15) stays reachable after its first-run tab is closed.
    { id: 'first-week', label: t('tabs.sidebarMenus.gettingStarted') },
    { id: 'settings', label: t('tabs.sidebarMenus.settings'), accelerator: 'CmdOrCtrl+,' },
  ]
}

/** The address pill's context menu. */
export function addressMenu({ url, showFullUrls, canPaste }: { url: string; showFullUrls: boolean; canPaste: boolean }): MenuItemSpec[] {
  const hasAddress = !isBlankUrl(url) && !isInternalUrl(url)
  return [
    { id: 'copy', label: t('tabs.sidebarMenus.copyAddress'), enabled: hasAddress },
    { id: 'paste-go', label: t('tabs.sidebarMenus.pasteAndGo'), enabled: canPaste },
    { id: 'edit', label: t('tabs.sidebarMenus.editAddress') },
    sep(1),
    { id: 'full-urls', label: t('tabs.sidebarMenus.showFullAddresses'), type: 'checkbox', checked: showFullUrls },
  ]
}

/** Counts behind the All chats row and the collapsed-sidebar dot. */
export function chatCounts(chats: readonly ChatSummary[]): { unread: number; needsInput: number } {
  let unread = 0
  let needsInput = 0
  for (const c of chats) {
    if (c.archived || c.draft) continue
    if (c.unread) unread++
    if (c.needsInput || c.status === 'needs-approval') needsInput++
  }
  return { unread, needsInput }
}
