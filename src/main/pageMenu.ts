/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Menu, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'
import type { WindowContext } from './features/types'
import type { Tab, TabManager } from './tabs'

// The page context menu's contributor API. Each feature adds a
// section; sections are separated and ordered by `order`:
// 10 links and search · 20 split and picture-in-picture · 30 ask the
// companion · 40 exit full screen · 50 extensions · 90 print, QR code,
// view source and Inspect.

export interface PageMenuSection {
  id: string
  order: number
  build(params: ContextMenuParams, tab: Tab, win: WindowContext): MenuItemConstructorOptions[]
}

const sections: PageMenuSection[] = []

export function registerPageMenuSection(section: PageMenuSection): () => void {
  if (sections.some((s) => s.id === section.id)) throw new Error(`Page menu section ${section.id} is already registered.`)
  sections.push(section)
  sections.sort((a, b) => a.order - b.order)
  return () => {
    const i = sections.indexOf(section)
    if (i >= 0) sections.splice(i, 1)
  }
}

/** Every section's items, with one separator between non-empty sections. */
export function buildPageMenu(params: ContextMenuParams, tab: Tab, win: WindowContext): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const section of sections) {
    const items = section.build(params, tab, win)
    if (items.length === 0) continue
    if (out.length > 0) out.push({ type: 'separator' })
    out.push(...items)
  }
  return out
}

export function pageMenuSections(): readonly PageMenuSection[] {
  return sections
}

// TabManager asks here first; without a bound
// window or any contributed item, TabManager's own menu shows instead.
const windowsByTabs = new WeakMap<TabManager, WindowContext>()

/** The address feature binds each window, so TabManager's handler can find it. */
export function bindPageMenuWindow(win: WindowContext): void {
  windowsByTabs.set(win.tabs, win)
}

/** Pops the contributed page menu for a tab; false when there is nothing to show. */
export function showPageMenu(tabs: TabManager, tab: Tab, params: ContextMenuParams): boolean {
  const win = windowsByTabs.get(tabs)
  if (!win || win.window.isDestroyed()) return false
  const items = buildPageMenu(params, tab, win)
  if (items.length === 0) return false
  Menu.buildFromTemplate(items).popup({ window: win.window })
  return true
}
