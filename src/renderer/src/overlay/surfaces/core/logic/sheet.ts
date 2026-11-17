/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { formatKeys, type ShortcutDef, type ShortcutGroup } from '@shared/shortcuts'

// The ⌘/ sheet's model (SH-67): every row of the shortcut table, grouped by
// surface in a fixed order, with runtime shortcuts under their owner. Rows
// that share a label in a group (⌘+ and ⌘=) show as one row with both keys.

export const SHEET_GROUP_ORDER: readonly ShortcutGroup[] = ['tabs', 'windows', 'navigation', 'address', 'find', 'zoom', 'view', 'chat', 'bookmarks', 'edit', 'tools', 'help']

export interface SheetRow {
  id: string
  label: string
  /** One or more key combinations, each a list of caps. */
  keys: string[][]
}

export interface SheetGroup {
  id: ShortcutGroup | 'runtime'
  label: string
  rows: SheetRow[]
}

export interface RuntimeRow {
  id: string
  title: string
  accelerator: string
  owner: string
}

function matches(query: string, row: SheetRow, groupLabel: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return row.label.toLowerCase().includes(q) || groupLabel.toLowerCase().includes(q) || row.keys.some((k) => k.join('').toLowerCase().includes(q))
}

/** The sheet's groups for a platform; `label` turns i18n keys into text. */
export function sheetGroups(
  table: readonly ShortcutDef[],
  runtime: readonly RuntimeRow[],
  platform: string,
  label: (key: string) => string,
  query = '',
): SheetGroup[] {
  const out: SheetGroup[] = []
  for (const group of SHEET_GROUP_ORDER) {
    const groupLabel = label(`core.shortcutGroup.${group}`)
    const rows: SheetRow[] = []
    for (const def of table.filter((d) => d.group === group)) {
      const text = label(def.label)
      const caps = formatKeys(def, platform)
      const same = rows.find((r) => r.label === text)
      if (same) same.keys.push(caps)
      else rows.push({ id: def.id, label: text, keys: [caps] })
    }
    const shown = rows.filter((r) => matches(query.trim(), r, groupLabel))
    if (shown.length > 0) out.push({ id: group, label: groupLabel, rows: shown })
  }
  if (runtime.length > 0) {
    const groupLabel = label('core.shortcutGroup.runtime')
    const rows = runtime
      .map((r) => ({ id: `${r.owner}:${r.id}`, label: `${r.title} · ${r.owner}`, keys: [formatKeys({ keys: { mac: r.accelerator.replace(/CmdOrCtrl/g, 'Cmd'), other: r.accelerator.replace(/CmdOrCtrl/g, 'Ctrl') } }, platform)] }))
      .filter((r) => matches(query.trim(), r, groupLabel))
    if (rows.length > 0) out.push({ id: 'runtime', label: groupLabel, rows })
  }
  return out
}
