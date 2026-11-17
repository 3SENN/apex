/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SHORTCUTS, type ShortcutId } from '@shared/shortcuts'
import { tooltipText } from './shortcut'

// What an icon button's overlay tooltip shows (DS-95).

/** An accelerator's keys, order and case aside ('Shift+CmdOrCtrl+T' is 'CmdOrCtrl+Shift+T'). */
function keysOf(accelerator: string): string {
  return accelerator
    .split('+')
    .map((k) => k.trim().toLowerCase())
    .sort()
    .join('+')
}

/**
 * The label, with the shortcut as key caps when it is a shortcut table row,
 * or written after the label when it isn't. Null for none.
 */
export function iconTooltip(label: string, shortcut: string | undefined, tooltip: string | false | undefined, mac: boolean): { label: string; shortcutId: ShortcutId | null } | null {
  if (tooltip === false) return null
  if (tooltip !== undefined) return tooltip ? { label: tooltip, shortcutId: null } : null
  if (!label) return null
  if (!shortcut) return { label, shortcutId: null }
  const keys = keysOf(shortcut)
  const row = SHORTCUTS.find((s) => keysOf(s.accelerator) === keys)
  return row ? { label, shortcutId: row.id } : { label: tooltipText(label, shortcut, mac), shortcutId: null }
}
