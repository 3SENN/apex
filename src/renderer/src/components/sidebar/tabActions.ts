/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TabInfo, TabsSnapshot } from '@shared/ipc'
import type { Bookmark } from '@shared/services'
import type { TabGroup } from '@shared/tabs'
import { apex, call, errorText } from '../../api'
import { t } from '@shared/i18n/core'
import { isMac, showContextMenu, toast } from '../../ui'
import type { TextDrop } from './dnd'
import { closeCard } from './hoverCard'
import { dropUrl } from './logic/drops'
import { menuTargets, rangeSelection, toggleSelection } from './logic/selection'
import { folderList } from '@shared/bookmarks'
import { ADD_TO_GROUP, BOOKMARK_IN, SPLIT_PAGE, SPLIT_WITH, groupMenu, splitRowMenu, tabMenu, type TabMenuContext } from './logic/menus'
import { openTabsSurface } from '../../overlay/surfaces/tabs/open'
import { copyText } from './util'
import { goWorkspace } from '../../workspace/open'
import { SPACE_MOVE_PREFIX, handleSpaceMenu, spaceSubmenu } from '../../workspace/spaceActions'

// The tab context menu, shared by sidebar rows, pinned tiles and the strip;
// row clicks with their modifiers (SH-18, SH-25); and the group menu (SH-24).

interface TabMenuOptions {
  tab: TabInfo
  snapshot: TabsSnapshot
  /** The rows in the order shown (pinned first), for "close below". */
  shown: readonly TabInfo[]
  bookmarks: readonly Bookmark[]
  /** A new group starts renaming: the list puts it in rename mode. */
  onGroupCreated?(group: TabGroup): void
}

function fail(what: string) {
  return (err: unknown): void => {
    toast.show({ message: t('tabs.error.action', { what, reason: errorText(err) }), tone: 'error' })
  }
}

/** Clear (the tab list's header, Close All Tabs): closes every unpinned tab in this window, with Undo in the toast. */
export async function clearTabs(): Promise<void> {
  const cleared = await call('tabs', 'clearTabs').catch((err: unknown) => void fail(t('tabs.clear.what'))(err))
  if (!cleared || cleared.closed === 0) return
  toast.show({
    message: cleared.closed === 1 ? t('tabs.clear.closedOne') : t('tabs.clear.closed', { count: cleared.closed }),
    undo: () => void call('tabs', 'undoClearTabs', cleared.id).catch(fail(t('tabs.clear.undoWhat'))),
  })
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.origin : null
  } catch {
    return null
  }
}

/** The bookmark folders for Bookmark In; the menu falls back to a plain Bookmark Page without them. */
async function bookmarkFolders(): Promise<TabMenuContext['bookmarkFolders']> {
  try {
    return folderList(await call('bookmarks', 'tree')).map(({ id, title, depth }) => ({ id, title, depth }))
  } catch {
    return []
  }
}

function contextFor({ tab, snapshot, shown, bookmarks }: TabMenuOptions, targets: readonly TabInfo[], folders: TabMenuContext['bookmarkFolders'] = []): TabMenuContext {
  return {
    bookmarkFolders: folders,
    tab,
    tabs: shown,
    split: snapshot.split,
    closedCount: snapshot.closedCount,
    bookmarked: bookmarks.some((b) => b.url === tab.url),
    splitCandidates: snapshot.tabs.filter((t) => t.id !== tab.id).sort((a, b) => b.lastActiveAt - a.lastActiveAt),
    targets,
    groups: snapshot.groups ?? [],
    windowTabCount: snapshot.tabs.length,
  }
}

/** Opens the native tab menu at the pointer and runs the choice; with a selection it acts on all of it. */
export async function openTabMenu(event: { clientX: number; clientY: number; currentTarget?: EventTarget | null; preventDefault(): void }, options: TabMenuOptions): Promise<void> {
  closeCard()
  const { tab, snapshot } = options
  const ids = menuTargets(snapshot.selection ?? [], tab.id)
  const targets = ids.map((id) => snapshot.tabs.find((t) => t.id === id)).filter((t): t is TabInfo => t !== undefined)
  const [folders, spaces] = await Promise.all([targets.length === 1 ? bookmarkFolders() : Promise.resolve([]), call('spaces', 'list').catch(() => null)])
  const items = tabMenu(contextFor(options, targets, folders))
  // "Move to space", once a project exists; it goes in front of the closing group.
  const spaceItem = spaceSubmenu(spaces, ids)
  if (spaceItem) {
    const lastSeparator = items.map((i) => i.type).lastIndexOf('separator')
    items.splice(lastSeparator < 0 ? items.length : lastSeparator, 0, spaceItem)
  }
  const id = await showContextMenu(event, items)
  if (!id) return
  if (id.startsWith(SPACE_MOVE_PREFIX)) return void handleSpaceMenu(id, ids)
  await runTabMenu(id, options, targets)
}

/** A split row's menu: separate, swap, and a submenu per page. */
export async function openSplitRowMenu(event: { clientX: number; clientY: number; currentTarget?: EventTarget | null; preventDefault(): void }, left: TabInfo, right: TabInfo, options: Omit<TabMenuOptions, 'tab'>): Promise<void> {
  closeCard()
  const id = await showContextMenu(event, splitRowMenu(contextFor({ ...options, tab: left }, [left]), contextFor({ ...options, tab: right }, [right])))
  if (!id) return
  if (id === 'split-separate') return void call('split', 'separate').catch(fail(t('tabs.error.separate')))
  if (id === 'split-swap') return void call('split', 'swap').catch(fail(t('tabs.error.swap')))
  const page = id.startsWith(SPLIT_PAGE[0]) ? left : id.startsWith(SPLIT_PAGE[1]) ? right : null
  if (page) await runTabMenu(id.slice(SPLIT_PAGE[0].length), { ...options, tab: page }, [page])
}

export async function runTabMenu(id: string, options: TabMenuOptions, targets: readonly TabInfo[]): Promise<void> {
  const { tab, snapshot, shown } = options
  const ids = targets.map((t) => t.id)
  if (id.startsWith(SPLIT_WITH)) {
    void call('split', 'openWith', tab.id, id.slice(SPLIT_WITH.length)).catch(fail(t('tabs.error.split')))
    return
  }
  if (id.startsWith(BOOKMARK_IN)) {
    void call('bookmarks', 'add', { url: tab.url, title: tab.title, parentId: id.slice(BOOKMARK_IN.length) }).catch(fail(t('tabs.error.tabs')))
    return
  }
  if (id === 'edit-bookmark') {
    // The bookmark editor, under the pointer's row.
    void call('bookmarks', 'forUrl', tab.url)
      .then((link) => (link ? openTabsSurface('bookmark-editor', { kind: 'tab', tabId: tab.id, rect: null }, { id: link.id, created: false }) : null))
      .catch(fail(t('tabs.error.tabs')))
    return
  }
  if (id.startsWith(ADD_TO_GROUP)) {
    void call('tabGroups', 'addTabs', id.slice(ADD_TO_GROUP.length), ids).catch(fail(t('tabs.error.group')))
    return
  }
  const index = shown.findIndex((t) => t.id === tab.id)
  const unpinned = (list: readonly TabInfo[]): string[] => list.filter((t) => !t.pinned).map((t) => t.id)
  const each = (fn: (t: TabInfo) => Promise<unknown>): void => void Promise.all(targets.map(fn)).catch(fail(t('tabs.error.tabs')))
  switch (id) {
    case 'new-tab-next':
      void apex.tabs.create(undefined, { afterId: tab.id })
      break
    case 'reopen':
      void call('tabs', 'reopenClosed')
      break
    case 'split-separate':
      void call('split', 'separate').catch(() => call('split', 'close'))
      break
    case 'split-pair': {
      const [a, b] = ids
      if (a && b) void call('split', 'openWith', a, b).catch(fail(t('tabs.error.split')))
      break
    }
    case 'group-new':
      try {
        const group = await call('tabGroups', 'create', ids)
        options.onGroupCreated?.(group)
      } catch (err) {
        fail(t('tabs.error.group'))(err)
      }
      break
    case 'group-remove':
      void call('tabGroups', 'removeTabs', ids).catch(fail(t('tabs.error.group')))
      break
    case 'group-auto':
      // DC-18: the selected tabs when several are, else the window's; main shows the outcome with Undo.
      void call('tabGroups', 'auto', targets.length > 1 ? ids : undefined).catch(fail(t('tabs.error.group')))
      break
    case 'move-window':
      void call('tabs', 'moveToNewWindow', ids).catch(fail(t('tabs.error.moveWindow')))
      break
    case 'reload':
      each((x) => apex.nav.reload(x.id))
      break
    case 'duplicate':
      each((x) => call('tabs', 'duplicate', x.id))
      break
    case 'copy-link':
      // The page actions copy with a confirmation toast; the clipboard is the fallback.
      void call('pageActions', 'copyUrl', tab.id).catch(async () => {
        if (await copyText(tab.url)) toast.show({ message: t('tabs.toast.linkCopied') })
      })
      break
    case 'pin':
    case 'unpin':
      each((x) => call('tabs', 'setPinned', x.id, id === 'pin'))
      break
    case 'mute':
    case 'unmute': {
      const muted = id === 'mute'
      // Mute site remembers it for the site; muting the tab itself is the fallback.
      each(async (x) => {
        const origin = originOf(x.url)
        try {
          if (!origin) throw new Error('no origin')
          await call('sites', 'setMuted', origin, muted)
        } catch {
          await call('tabs', 'setMuted', x.id, muted)
        }
      })
      break
    }
    case 'bookmark':
    case 'unbookmark':
      void call('bookmarks', 'toggle', tab.url, tab.title)
      break
    case 'save-app':
      void call('webApps', 'saveTab', tab.id).then(
        (app) => toast.show({ message: t('platform.webApps.saved', { name: app.name }), tone: 'success', action: { label: t('platform.webApps.showApps'), onAction: () => goWorkspace('apps') } }),
        fail(t('platform.webApps.saveTab')),
      )
      break
    case 'bookmark-many': {
      const marked = new Set(options.bookmarks.map((b) => b.url))
      each((x) => (/^https?:/i.test(x.url) && !marked.has(x.url) ? call('bookmarks', 'toggle', x.url, x.title) : Promise.resolve()))
      break
    }
    case 'close':
      if (targets.length > 1) void call('tabs', 'closeMany', ids)
      else void apex.tabs.close(tab.id)
      break
    case 'close-others':
      void call('tabs', 'closeMany', unpinned(shown.filter((t) => t.id !== tab.id)))
      break
    case 'close-below':
      void call('tabs', 'closeMany', unpinned(shown.slice(index + 1)))
      break
    case 'close-unpinned':
      void call('tabs', 'closeMany', unpinned(snapshot.tabs))
      break
  }
}

/**
 * Row clicks: ⌥-click pairs with the active tab, ⇧-click selects a range
 * from the active tab, ⌘-click toggles one tab, and a plain click activates
 * (which clears the selection in main). `order` is the rows as shown.
 */
export function activateTab(tab: TabInfo, snapshot: TabsSnapshot, event: { altKey: boolean; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }, order?: readonly string[]): void {
  closeCard()
  if (event.altKey && snapshot.activeId && snapshot.activeId !== tab.id) {
    void call('split', 'openWith', tab.id, snapshot.activeId)
    return
  }
  if (event.shiftKey && order) {
    void call('tabs', 'setSelection', rangeSelection(order, snapshot.activeId, tab.id))
    return
  }
  const toggle = isMac ? event.metaKey : event.ctrlKey
  if (toggle) {
    void call('tabs', 'setSelection', toggleSelection(snapshot.selection ?? [], snapshot.activeId, tab.id))
    return
  }
  void apex.tabs.activate(tab.id)
}

/** The group header's menu; `onRename` puts the header in rename mode. */
export async function openGroupMenu(event: { clientX: number; clientY: number; currentTarget?: EventTarget | null; preventDefault(): void }, group: TabGroup, count: number, onRename: () => void): Promise<void> {
  closeCard()
  const id = await showContextMenu(event, groupMenu(group, count))
  if (!id) return
  const run = (p: Promise<unknown>): void => void p.catch(fail(t('tabs.error.group')))
  if (id.startsWith('color:')) return run(call('tabGroups', 'update', group.id, { color: id.slice(6) as TabGroup['color'] }))
  switch (id) {
    case 'toggle':
      return run(call('tabGroups', 'update', group.id, { collapsed: !group.collapsed }))
    case 'rename':
      return onRename()
    case 'new-tab':
      return run(call('tabGroups', 'newTab', group.id))
    case 'ungroup':
      return run(call('tabGroups', 'ungroup', group.id))
    case 'close':
      return run(call('tabGroups', 'close', group.id))
  }
}

/**
 * Text or a link dropped onto the tab list: onto a tab it
 * loads there; between rows it opens a new tab at that place. Addresses open
 * and other text is searched. `rowIds` are the list's rows in order.
 */
export function runTextDrop(drop: TextDrop, engine: string, rowIds: readonly string[]): void {
  const url = dropUrl(drop.text, engine)
  if (!url) return
  if (drop.tabId) {
    void apex.nav.go(drop.tabId, url).catch(fail(t('tabs.error.tabs')))
    return
  }
  const before = drop.index > 0 ? rowIds[drop.index - 1] : undefined
  void apex.tabs.create(url, before ? { afterId: before } : { position: 'top' }).catch(fail(t('tabs.error.tabs')))
}
