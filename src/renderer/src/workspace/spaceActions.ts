/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// "Move to space" for the tab menus: moves tabs into another
// project's space in their window. The tab menu mounts spaceSubmenu and
// routes ids starting with SPACE_MOVE_PREFIX to handleSpaceMenu.
import type { MenuItemSpec } from '@shared/menu'
import { t } from '@shared/i18n/core'
import type { SpaceInfo } from '@shared/workspace'
import { call } from '../api'
import { SPACE_MOVE_PREFIX, spaceMoveSpec, spaceMoveTarget } from './logic'
import { fail } from './open'

export { SPACE_MOVE_PREFIX }

/** The submenu for `tabIds`, from the window's spaces (useSpaces); null while there are no projects. */
export function spaceSubmenu(spaces: readonly SpaceInfo[] | null, tabIds: string[]): MenuItemSpec | null {
  return spaceMoveSpec(spaces, tabIds, t('workspace.space.moveTabs'))
}

export async function handleSpaceMenu(itemId: string, tabIds: string[]): Promise<void> {
  const target = spaceMoveTarget(itemId)
  if (target === undefined || tabIds.length === 0) return
  try {
    await call('spaces', 'moveTabs', tabIds, target)
  } catch (err) {
    fail(err)
  }
}
