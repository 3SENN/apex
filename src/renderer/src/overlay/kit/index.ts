/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The overlay kit (DS-94): Popover, MenuList and CascadeMenu, shared by
// the main menu, the bookmark folders, the sidebar options and later menus.
import './kit.css'

export { CascadeMenu, type CascadeMenuProps } from './CascadeMenu'
export { MenuList, type MenuListProps } from './MenuList'
export { Popover, type KitPopoverProps } from './Popover'
export { fromMenuModel, type FromModelOptions } from './model'
export { inChromeHost, openInChrome, pressAnchor, type ChromeSurfaceOptions } from './chromeHost'
export { CASCADE_MENU_POLICY, MenuScrim } from './host'
export { SUBMENU_GAP, cascadeKey, inSafeTriangle, placeSubmenu, unionBox, type Box, type Point } from './logic'
export type { KitHandlers, KitItem } from './types'
