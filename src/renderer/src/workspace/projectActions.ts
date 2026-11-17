/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The "Move to project" menu pieces, used by the chat menus and
// bulk actions: a submenu of No project, every project (checked when all the
// chats are in it) and New project…. This file stays free of the chrome's
// IPC and UI so the menu builders (and their tests) can import it; the
// chrome connects the runner (projectMenuRunner.ts) at start-up, which keeps
// the project list current and carries out a click.
import type { MenuItemSpec } from '@shared/menu'
import { t } from '@shared/i18n/core'
import { PROJECT_MENU_PREFIX as PREFIX, projectMenuAction, projectMenuSpec, type Project, type ProjectMenuAction } from '@shared/workspace'

/** Item ids this submenu uses start with this prefix, so callers can route a click back to handleProjectMenu. */
export const PROJECT_MENU_PREFIX = PREFIX

export interface ProjectMenuRunner {
  projects(): readonly Project[]
  run(action: ProjectMenuAction, chatIds: string[]): Promise<void>
}

let runner: ProjectMenuRunner | null = null

/** The chrome's runner (projectMenuRunner.ts registers itself). */
export function connectProjectMenus(next: ProjectMenuRunner | null): void {
  runner = next
}

export function projectSubmenu(chatIds: string[]): MenuItemSpec {
  return projectMenuSpec(runner?.projects() ?? [], chatIds, { title: t('workspace.moveToProject'), none: t('workspace.menu.none'), new: t('workspace.menu.new') })
}

export async function handleProjectMenu(itemId: string, chatIds: string[]): Promise<void> {
  const action = projectMenuAction(itemId)
  if (!action || chatIds.length === 0) return
  if (!runner) throw new Error('The project menu runner is not connected')
  await runner.run(action, chatIds)
}
