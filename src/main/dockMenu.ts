/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { registerMenuContribution, type MenuItemModel, type MenuState } from '@shared/menuModel'
import { mainT } from './i18n/mainT'

// The Dock menu (SH-60): the open windows, then New Window and New Private
// Window. It is a menu contribution to the 'dock' target, so other features
// (profiles) add their own rows the same way.

export const DOCK_WINDOW_PREFIX = 'core-dock-window:'

/** The Dock rows for the windows open right now. */
export function dockItems(state: Pick<MenuState, 'windows'>): MenuItemModel[] {
  const windows = state.windows.filter((w) => w.kind !== 'popup')
  const rows: MenuItemModel[] = windows.map((w) => {
    const title = w.title.trim() || mainT('core.window.untitled')
    return {
      id: `${DOCK_WINDOW_PREFIX}${w.id}`,
      label: w.kind === 'private' ? `${title} (${mainT('core.privateWindow')})` : title,
      type: 'checkbox',
      checked: w.focused,
    }
  })
  if (rows.length > 0) rows.push({ id: 'core-dock-separator', label: '', type: 'separator' })
  rows.push(
    { id: 'core-dock-new-window', label: mainT('core.dock.newWindow'), commandId: 'new-window' },
    { id: 'core-dock-new-private-window', label: mainT('core.dock.newPrivateWindow'), commandId: 'new-private-window' },
  )
  return rows
}

/** The window id a Dock row stands for, or null. */
export function dockWindowId(itemId: string): number | null {
  if (!itemId.startsWith(DOCK_WINDOW_PREFIX)) return null
  const id = Number(itemId.slice(DOCK_WINDOW_PREFIX.length))
  return Number.isInteger(id) && id > 0 ? id : null
}

export function registerDockMenu(focusWindow: (id: number) => void): () => void {
  return registerMenuContribution({
    id: 'core:dock',
    target: 'dock',
    build: dockItems,
    run: (itemId) => {
      const id = dockWindowId(itemId)
      if (id !== null) focusWindow(id)
    },
  })
}
