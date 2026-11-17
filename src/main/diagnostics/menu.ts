/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MenuItemModel } from '@shared/menuModel'
import type { CommandId } from '@shared/shortcuts'
import { mainT } from '../i18n/mainT'

// The diagnostics Help items (SH-58, SH-54), contributed to 'help' and
// 'main-menu:help' (ids prefixed 'help:'): What's New, Send Feedback…,
// Report a Problem… (⇧⌘H) and Show Logs. Each runs a command by id:
// diagnostics registers report-problem, send-feedback and show-logs, and
// updates registers whats-new. Other features' Help items stay their own
// contributions.

const ITEMS: ReadonlyArray<{ id: string; commandId: CommandId; label: Parameters<typeof mainT>[0]; accelerator?: string }> = [
  { id: 'help:whats-new', commandId: 'whats-new', label: 'diagnostics.menu.whatsNew' },
  { id: 'help:send-feedback', commandId: 'send-feedback', label: 'diagnostics.menu.sendFeedback' },
  { id: 'help:report-problem', commandId: 'report-problem', label: 'diagnostics.menu.reportProblem', accelerator: 'CmdOrCtrl+Shift+H' },
  { id: 'help:show-logs', commandId: 'show-logs', label: 'diagnostics.menu.showLogs' },
]

let runner: ((id: CommandId) => void) | null = null

/** The feature points this at the command registry. */
export function setHelpMenuRunner(fn: ((id: CommandId) => void) | null): void {
  runner = fn
}

export function helpMenuItems(): MenuItemModel[] {
  return [{ id: 'help:separator', label: '', type: 'separator' }, ...ITEMS.map(({ id, commandId, label, accelerator }) => ({ id, label: mainT(label), commandId, ...(accelerator ? { accelerator } : {}) }))]
}

/** For builders that dispatch by item id rather than commandId. */
export function runHelpMenu(id: string): void {
  const item = ITEMS.find((i) => i.id === id)
  if (item) runner?.(item.commandId)
}
