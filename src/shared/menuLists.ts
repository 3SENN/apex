/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The recent lists the native menus and the main menu show (SH-55 to SH-58,
// SH-54), with their limits. Pure, so the limits are unit-tested; menuBase.ts
// turns them into menu items.
import type { ClosedEntry } from './windows'

export const MENU_LIMITS = {
  /** History › Recently Closed. */
  closed: 10,
  /** History › Recently Visited. */
  visited: 15,
  /** History › Recent Chats. */
  chats: 10,
  /** The main menu's History flyout. */
  mainHistory: 8,
  /** Bookmarks › Recently Added. */
  recentBookmarks: 10,
  /** The Tabs menu's list of open tabs. */
  tabs: 48,
  /** Rows per bookmark folder submenu before a "more not shown" note. */
  folderRows: 40,
  /** How deep folder submenus nest. */
  folderDepth: 4,
} as const

export interface MenuTab {
  id: string
  title: string
  url: string
  pinned: boolean
  muted: boolean
  lastActiveAt: number
  /** A data: URL, when the tab has one. */
  image?: string
}

export interface MenuVisit {
  url: string
  title: string
  image?: string
}

export interface MenuChat {
  id: string
  title: string
}

export type MenuBookmarkNode =
  | { kind: 'bookmark'; id: string; title: string; url: string; image?: string }
  | { kind: 'folder'; id: string; title: string; children: MenuBookmarkNode[] }

export interface MenuBookmarks {
  /** Newest first. */
  recent: Extract<MenuBookmarkNode, { kind: 'bookmark' }>[]
  bar: MenuBookmarkNode[]
  other: MenuBookmarkNode[]
}

/**
 * The Tabs menu's list: the `limit` most recently shown tabs, always with
 * the active one, kept in list order. `omitted` is how many were left out.
 */
export function pickTabList(tabs: readonly MenuTab[], activeId: string | null, limit: number = MENU_LIMITS.tabs): { shown: MenuTab[]; omitted: number } {
  if (tabs.length <= limit) return { shown: [...tabs], omitted: 0 }
  const keep = new Set<string>()
  if (activeId && tabs.some((t) => t.id === activeId)) keep.add(activeId)
  const byRecency = [...tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  for (const tab of byRecency) {
    if (keep.size >= limit) break
    keep.add(tab.id)
  }
  const shown = tabs.filter((t) => keep.has(t.id))
  return { shown, omitted: tabs.length - shown.length }
}

/** Newest first, capped. */
export function recentClosed(entries: readonly ClosedEntry[], limit: number = MENU_LIMITS.closed): ClosedEntry[] {
  return [...entries].sort((a, b) => b.closedAt - a.closedAt).slice(0, limit)
}

/** Web pages only, one per address, capped (the store is newest first already). */
export function recentVisits(visits: readonly MenuVisit[], limit: number = MENU_LIMITS.visited): MenuVisit[] {
  const seen = new Set<string>()
  const out: MenuVisit[] = []
  for (const v of visits) {
    if (out.length >= limit) break
    if (!/^https?:\/\//i.test(v.url) || seen.has(v.url)) continue
    seen.add(v.url)
    out.push(v)
  }
  return out
}

/** A folder's rows for a submenu: the first `limit` children, how many were left out, and its own bookmarks (for Open All). */
export function folderRows(children: readonly MenuBookmarkNode[], limit: number = MENU_LIMITS.folderRows): { shown: MenuBookmarkNode[]; omitted: number; bookmarks: number } {
  return {
    shown: children.slice(0, limit),
    omitted: Math.max(0, children.length - limit),
    bookmarks: children.filter((c) => c.kind === 'bookmark').length,
  }
}

/** Finds a folder anywhere in the tree. */
export function findFolder(nodes: readonly MenuBookmarkNode[], id: string): Extract<MenuBookmarkNode, { kind: 'folder' }> | null {
  for (const node of nodes) {
    if (node.kind !== 'folder') continue
    if (node.id === id) return node
    const inner = findFolder(node.children, id)
    if (inner) return inner
  }
  return null
}

/** Shortens a label for a native menu row (they don't ellipsize on every platform). */
export function menuLabel(text: string, fallback: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return fallback
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

/** Native menus treat & as a mnemonic marker on Windows and Linux; double it so titles show as written. */
export function escapeMnemonic(text: string, platform: string): string {
  return platform === 'darwin' ? text : text.replace(/&/g, '&&')
}
