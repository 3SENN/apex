/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactNode } from 'react'

// The overlay kit's row model (DS-94): one shape for every in-window menu,
// whether it draws in an overlay surface or, before the overlay host lands,
// in the chrome. Builders turn a MenuItemModel (main's menu model) or their
// own data into these.

export interface KitItem {
  id: string
  label: string
  /** 'header' labels a group, 'note' is muted text, 'switch' flips in place, 'custom' draws `render`. */
  kind?: 'item' | 'header' | 'separator' | 'switch' | 'note' | 'custom'
  /** A leading 15 px glyph. */
  icon?: ReactNode
  /** A favicon address for a leading 16 px image. */
  image?: string
  /** A muted second part of the label. */
  description?: string
  checked?: boolean
  /** Shows a check circle on the checked row (radio and checkbox rows). */
  checkable?: boolean
  disabled?: boolean
  danger?: boolean
  /** Formatted key caps, shown right-aligned. */
  shortcut?: string
  /** A lock glyph for a choice that is fixed or unavailable. */
  locked?: boolean
  /** Extra words the search row matches. */
  keywords?: string
  /** Opens a cascading card beside the row. */
  submenu?: KitItem[]
  /** A side card drawn by the caller instead of rows (the appearance flyout). */
  panel?: () => ReactNode
  /** Gives the submenu its own search row (long lists get one anyway). */
  search?: string
  /** The row's own content for kind 'custom' (the main menu's zoom row). */
  render?: () => ReactNode
  /** Choosing it runs onAction and keeps the menu open. */
  keepOpen?: boolean
}

export interface KitHandlers {
  /** A row was chosen; the menu closes. */
  onChoose(item: KitItem): void
  /** A keepOpen row or a switch was used; the menu stays. */
  onAction?(item: KitItem, checked?: boolean): void
  /** Escape at the root, Tab, or a click outside. `refocus` asks for focus back on the anchor. */
  onDismiss(refocus: boolean): void
}
