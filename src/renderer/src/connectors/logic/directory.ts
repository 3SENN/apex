/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CONNECTOR_CATEGORIES, type ConnectorCategory, type ConnectorHealth, type ConnectorV2, type DirectoryEntry } from '@shared/connectors'

// The connectors page's grouping and filters (SK-13): Connected
// (directory accounts), Your servers (custom), then the directory by Apex's
// categories without what is already connected. One search covers all of it.

export type StatusFilter = 'all' | 'connected' | 'attention' | 'off' | 'available'
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'connected', 'attention', 'off', 'available']

export interface DirectoryFilter {
  query: string
  status: StatusFilter
  category: 'all' | ConnectorCategory
}

/** What the page needs of a connector (the full Connector satisfies it). */
export type ConnectorRow = Pick<ConnectorV2, 'id' | 'displayName' | 'source' | 'directoryId' | 'health' | 'enabled'> &
  Partial<Pick<ConnectorV2, 'name' | 'accountLabel' | 'isDefault'>> & { url?: string }

export type DirectoryGroup<C extends ConnectorRow = ConnectorRow> =
  | { id: 'connected' | 'custom'; kind: 'connectors'; entries: C[] }
  | { id: ConnectorCategory; kind: 'directory'; entries: DirectoryEntry[] }

/** Rows a group shows before Show more. */
export const GROUP_PREVIEW = 6

const ATTENTION: ReadonlySet<ConnectorHealth> = new Set(['needs-reconnect', 'needs-approval', 'error'])

/** Health that asks you to do something: reconnect, approve the command, or look at an error. */
export function needsAttention(c: Pick<ConnectorRow, 'health' | 'enabled'>): boolean {
  return c.enabled && ATTENTION.has(c.health)
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

function matches(haystack: readonly (string | null | undefined)[], query: string): boolean {
  const terms = words(query)
  if (terms.length === 0) return true
  const text = haystack.filter(Boolean).join(' ').toLowerCase()
  return terms.every((t) => text.includes(t))
}

function categoryOf(c: ConnectorRow, directory: readonly DirectoryEntry[]): string | null {
  return c.directoryId ? (directory.find((e) => e.id === c.directoryId)?.category ?? null) : null
}

function connectorText(c: ConnectorRow, directory: readonly DirectoryEntry[]): (string | null | undefined)[] {
  const entry = c.directoryId ? directory.find((e) => e.id === c.directoryId) : undefined
  return [c.displayName, c.name, c.accountLabel, c.url, entry?.name, entry?.description]
}

/** Your connectors that pass the status filter (the directory's categories apply in directoryGroups). */
export function filterConnectors<C extends ConnectorRow>(list: readonly C[], filter: DirectoryFilter, directory: readonly DirectoryEntry[] = []): C[] {
  if (filter.status === 'available') return []
  return list.filter((c) => {
    if (filter.status === 'attention' && !needsAttention(c)) return false
    if (filter.status === 'off' && c.enabled) return false
    if (filter.status === 'connected' && !c.enabled) return false
    return matches(connectorText(c, directory), filter.query)
  })
}

/** The page's groups in order, empty ones left out. */
export function directoryGroups<C extends ConnectorRow>(list: readonly C[], directory: readonly DirectoryEntry[], filter: DirectoryFilter): DirectoryGroup<C>[] {
  const mine = filterConnectors(list, filter, directory).filter((c) => filter.category === 'all' || categoryOf(c, directory) === filter.category)
  const byName = (a: C, b: C): number => a.displayName.localeCompare(b.displayName) || Number(b.isDefault ?? false) - Number(a.isDefault ?? false)
  const groups: DirectoryGroup<C>[] = []
  const connected = mine.filter((c) => c.source === 'directory').sort(byName)
  const custom = mine.filter((c) => c.source === 'custom').sort(byName)
  if (connected.length) groups.push({ id: 'connected', kind: 'connectors', entries: connected })
  if (custom.length) groups.push({ id: 'custom', kind: 'connectors', entries: custom })
  if (filter.status !== 'all' && filter.status !== 'available') return groups
  const taken = new Set(list.map((c) => c.directoryId).filter(Boolean))
  for (const category of CONNECTOR_CATEGORIES) {
    if (filter.category !== 'all' && filter.category !== category) continue
    const entries = directory
      .filter((e) => e.category === category && !taken.has(e.id) && matches([e.name, e.description, e.site], filter.query))
      .sort((a, b) => a.name.localeCompare(b.name))
    if (entries.length) groups.push({ id: category, kind: 'directory', entries })
  }
  return groups
}

/** The rows a group shows: all of them while searching or expanded, else the first few. */
export function visibleRows<T>(entries: readonly T[], expanded: boolean, searching: boolean, limit = GROUP_PREVIEW): { shown: T[]; hidden: number } {
  if (expanded || searching || entries.length <= limit) return { shown: [...entries], hidden: 0 }
  return { shown: entries.slice(0, limit), hidden: entries.length - limit }
}

/** The header's count: every connector you added (each account counts). */
export function connectedCount(list: readonly Pick<ConnectorRow, 'enabled'>[]): number {
  return list.filter((c) => c.enabled).length
}

/** Whether any filter narrows the page (the filter button's dot). */
export function filterActive(filter: DirectoryFilter): boolean {
  return filter.status !== 'all' || filter.category !== 'all'
}

/** Other accounts of the same service, the default first. */
export function accountsOf<C extends ConnectorRow>(list: readonly C[], c: C): C[] {
  if (!c.directoryId) return [c]
  return list.filter((o) => o.directoryId === c.directoryId).sort((a, b) => Number(b.isDefault ?? false) - Number(a.isDefault ?? false) || a.displayName.localeCompare(b.displayName))
}
