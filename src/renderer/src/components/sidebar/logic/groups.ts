/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tab groups in the list (SH-23): a group is a header row with its
// tabs under it, skipped while collapsed. In manual order main keeps a
// group's tabs together; in recent order the group moves as one block, at
// the place of its most recently used tab. Pure, so it is unit-tested.
import type { TabGroup } from '@shared/tabs'
import type { TabRowItem } from './order'

export type ListItem =
  | { kind: 'group'; group: TabGroup; tabIds: string[] }
  | (TabRowItem & { groupId: string | null })

export function leadId(item: TabRowItem): string {
  return item.kind === 'tab' ? item.tab.id : item.primary.id
}

function rowIds(item: TabRowItem): string[] {
  return item.kind === 'tab' ? [item.tab.id] : [item.primary.id, item.secondary.id]
}

/**
 * Gathers each group's rows into one block where its first row appears, with
 * a header row in front. Rows of a collapsed group are left out (the header
 * still counts them).
 */
export function groupedItems(rows: readonly TabRowItem[], groups: readonly TabGroup[], groupOf: (tabId: string) => string | null): ListItem[] {
  const byId = new Map(groups.map((g) => [g.id, g]))
  const groupOfRow = (item: TabRowItem): string | null => {
    const id = groupOf(leadId(item))
    return id && byId.has(id) ? id : null
  }
  const out: ListItem[] = []
  const done = new Set<string>()
  for (const row of rows) {
    const gid = groupOfRow(row)
    if (gid === null) {
      out.push({ ...row, groupId: null })
      continue
    }
    if (done.has(gid)) continue
    done.add(gid)
    const group = byId.get(gid)
    if (!group) continue
    const members = rows.filter((r) => groupOfRow(r) === gid)
    out.push({ kind: 'group', group, tabIds: members.flatMap(rowIds) })
    if (!group.collapsed) for (const m of members) out.push({ ...m, groupId: gid })
  }
  return out
}

/** Tab ids in the order the list draws them, without tabs hidden in collapsed groups. */
export function visibleTabIds(items: readonly ListItem[]): string[] {
  return items.flatMap((i) => (i.kind === 'group' ? [] : rowIds(i)))
}

/** The rows a collapsed group's hover card lists. */
export function groupMembers<T extends { id: string }>(tabs: readonly T[], tabIds: readonly string[]): T[] {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  return tabIds.map((id) => byId.get(id)).filter((t): t is T => t !== undefined)
}
