/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'
import { AppWindow, Bookmark, CircleArrowUp, CircleHelp, Download, Folder, Globe, History, KeyRound, Menu, Package, Palette, Puzzle, Settings, Share, UserRound, Wrench } from 'lucide-react'
import type { MenuItemModel } from '@shared/menuModel'
import { formatShortcut } from '../../ui/logic/shortcut'
import type { KitItem } from './types'

// Main's menu model (MenuItemModel) as kit rows: the main-menu popover
// and anything else that renders a model-built menu in the overlay.

/** Glyphs for the icon names menu models use (lucide, design-spec choices). Unknown names draw no glyph. */
const ICONS: Record<string, () => ReactNode> = {
  tabs: () => <AppWindow />,
  bookmark: () => <Bookmark />,
  history: () => <History />,
  download: () => <Download />,
  'key-round': () => <KeyRound />,
  puzzle: () => <Puzzle />,
  package: () => <Package />,
  palette: () => <Palette />,
  share: () => <Share />,
  wrench: () => <Wrench />,
  help: () => <CircleHelp />,
  settings: () => <Settings />,
  globe: () => <Globe />,
  folder: () => <Folder />,
  user: () => <UserRound />,
  'circle-arrow-up': () => <CircleArrowUp />,
  menu: () => <Menu />,
}

export interface FromModelOptions {
  mac: boolean
  /** Per-id overrides: special rows the caller draws itself (the zoom row, the appearance flyout). */
  override?(item: MenuItemModel): Partial<KitItem> | null
}

export function fromMenuModel(items: readonly MenuItemModel[], options: FromModelOptions): KitItem[] {
  const out: KitItem[] = []
  for (const item of items) {
    if (item.visible === false || item.role) continue
    if (item.type === 'separator') {
      // No leading, trailing or doubled separators.
      if (out.length && out[out.length - 1]?.kind !== 'separator') out.push({ id: item.id, label: '', kind: 'separator' })
      continue
    }
    const kind: KitItem['kind'] = item.variant === 'switch' ? 'switch' : item.variant === 'header' ? 'header' : item.variant === 'note' ? 'note' : 'item'
    const icon = item.icon ? ICONS[item.icon]?.() : undefined
    const row: KitItem = {
      id: item.id,
      label: item.label,
      kind,
      ...(icon ? { icon } : {}),
      ...(item.image && /^(https?:|data:image\/)/i.test(item.image) ? { image: item.image } : {}),
      ...(item.enabled === false ? { disabled: true } : {}),
      ...(item.checked !== undefined ? { checked: item.checked } : {}),
      ...(item.type === 'radio' || (item.type === 'checkbox' && kind !== 'switch') ? { checkable: true } : {}),
      ...(item.accelerator ? { shortcut: formatShortcut(item.accelerator, options.mac) } : {}),
      ...(item.submenu ? { submenu: fromMenuModel(item.submenu, options) } : {}),
      ...options.override?.(item),
    }
    out.push(row)
  }
  while (out.length && out[out.length - 1]?.kind === 'separator') out.pop()
  return out
}
