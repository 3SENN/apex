/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Menu contributions. Native menus and the main-menu popover are
// built from one model; features add items only through
// registerMenuContribution, never by restructuring menu.ts. Main is the only
// caller: the popover receives the built model through IPC.
import type { CommandId } from './shortcuts'
import type { WindowKind, WindowSummary } from './windows'

export type MenuTarget =
  | 'app'
  | 'file'
  | 'edit'
  | 'view'
  | 'tabs'
  | 'bookmarks'
  | 'history'
  | 'window'
  | 'help'
  | 'extensions'
  | 'dock'
  | 'tray'
  | 'main-menu'
  | 'main-menu:profile'
  | 'main-menu:tools'
  | 'main-menu:help'

export interface MenuItemModel {
  id: string
  label: string
  type?: 'normal' | 'separator' | 'checkbox' | 'radio'
  commandId?: CommandId
  accelerator?: string
  enabled?: boolean
  checked?: boolean
  icon?: string
  role?: string
  submenu?: MenuItemModel[]
  // Additive: how the popover draws a row; native menus map each to a plain item
  /** 'switch' flips in place (a checkbox natively); 'header' labels a group and 'note' is muted text (both disabled natively). */
  variant?: 'switch' | 'header' | 'note'
  /** Hidden natively but its accelerator still works (⌘1–9, alternates). */
  visible?: boolean
  /** A data: URL for a 16 px favicon (native menus and the popover). */
  image?: string
}

/** What a contribution's build() sees. */
export interface MenuState {
  windows: WindowSummary[]
  focusedWindow: { id: number; kind: WindowKind } | null
  tabs: { id: string; title: string; url: string; pinned: boolean }[]
  activeTabId: string | null
  /** 'page', 'chrome', 'overlay' or a surface id. */
  focusedSurface: string | null
  commands: Record<string, { enabled: boolean; checked?: boolean }>
  update: { state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'; percent: number | null }
}

export interface MenuContribution {
  id: string
  target: MenuTarget
  /** An item id to insert after; without it the items go at the end of the target. */
  after?: string
  build(s: MenuState): MenuItemModel[]
  /**
   * Runs one of this contribution's items that has no commandId (* additive). Items with a commandId run that command instead.
   */
  run?(itemId: string, windowId: number | null): void | Promise<void>
}

const contributions: MenuContribution[] = []
const listeners = new Set<() => void>()
let pending: ReturnType<typeof setTimeout> | null = null

function changed(): void {
  if (pending) return
  // Debounced: a burst of state changes rebuilds the menus once.
  pending = setTimeout(() => {
    pending = null
    for (const fn of [...listeners]) fn()
  }, 50)
}

export function registerMenuContribution(c: MenuContribution): () => void {
  if (contributions.some((x) => x.id === c.id)) throw new Error(`Menu contribution ${c.id} is already registered.`)
  contributions.push(c)
  changed()
  return () => {
    const i = contributions.indexOf(c)
    if (i >= 0) contributions.splice(i, 1)
    changed()
  }
}

/** Contributions for one target, in registration order. */
export function menuContributions(target: MenuTarget): readonly MenuContribution[] {
  return contributions.filter((c) => c.target === target)
}

/**
 * Inserts each contribution's items into a base item list: after the item
 * named by `after` (searched at the top level), or at the end.
 */
export function applyContributions(target: MenuTarget, base: MenuItemModel[], state: MenuState, owners?: Map<string, MenuContribution>): MenuItemModel[] {
  const out = [...base]
  for (const c of menuContributions(target)) {
    let items: MenuItemModel[]
    try {
      items = c.build(state)
    } catch {
      // One contribution's broken builder must not take the whole menu bar down.
      continue
    }
    if (items.length === 0) continue
    // Remember who built each item, so an item without a command runs through its contribution.
    if (owners) noteOwners(items, c, owners)
    const at = c.after ? out.findIndex((i) => i.id === c.after) : -1
    if (at >= 0) out.splice(at + 1, 0, ...items)
    else out.push(...items)
  }
  return out
}

function noteOwners(items: readonly MenuItemModel[], c: MenuContribution, owners: Map<string, MenuContribution>): void {
  for (const item of items) {
    owners.set(item.id, c)
    if (item.submenu) noteOwners(item.submenu, c, owners)
  }
}

export const menus = {
  /** Asks for a debounced rebuild of every native menu and the open popover. */
  invalidate(): void {
    changed()
  },
  /** Main's menu builder listens here. */
  onInvalidate(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}
