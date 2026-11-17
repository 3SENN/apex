/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The + menu's model (CH-21, DS-126), kept pure: the rows of the top level
// and of each submenu, how a search filters them (with an empty state
// different from a no-match state), and what each key does. AddMenu.tsx
// draws it; tests/composerIntake.test.ts covers it.

export type SubmenuId = 'skills' | 'meetings' | 'connectors' | 'tabs'
export type MenuLevel = 'root' | SubmenuId

export const SUBMENUS: readonly SubmenuId[] = ['skills', 'meetings', 'connectors', 'tabs']

export interface MenuRow {
  /** 'files', 'sub:<submenu>', 'tab:<id>', 'skill:<name>', 'meeting:<id>', 'connector:<id>', 'go:<url>' or a divider's own id. */
  id: string
  label: string
  kind: 'item' | 'submenu' | 'separator' | 'header'
  /** A muted second part (a host, a skill's description). */
  detail?: string
  /** Extra words the search matches (a tab's whole URL). */
  keywords?: string
  disabled?: boolean
  // CH-21: a row that flips in place, drawn as a menuitemcheckbox
  checked?: boolean
}

export const focusable = (row: MenuRow): boolean => (row.kind === 'item' || row.kind === 'submenu') && !row.disabled

export interface RecentTab {
  id: string
  title: string
  url: string
}

/** How many recently used tabs the top level offers. */
export const RECENT_TABS = 3

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Files…, a divider, the four submenus, then (when there are any) a divider
 * and up to three recent tabs. The local folder joins in is not
 * shown before then.
 */
export function rootRows(labels: Record<'files' | SubmenuId | 'recent', string>, recent: readonly RecentTab[], /* CH-21: the local folder row */ folder?: { label: string; detail?: string }): MenuRow[] {
  const rows: MenuRow[] = [
    { id: 'files', label: labels.files, kind: 'item' },
    ...(folder ? [{ id: 'folder', label: folder.label, kind: 'item' as const, ...(folder.detail ? { detail: folder.detail } : {}) }] : []),
    { id: 'sep-attach', label: '', kind: 'separator' },
    ...SUBMENUS.map((id): MenuRow => ({ id: `sub:${id}`, label: labels[id], kind: 'submenu' })),
  ]
  const tabs = recent.slice(0, RECENT_TABS)
  if (tabs.length > 0) {
    rows.push({ id: 'sep-recent', label: '', kind: 'separator' }, { id: 'recent', label: labels.recent, kind: 'header' })
    for (const tab of tabs) rows.push({ id: `tab:${tab.id}`, label: tab.title || tab.url, kind: 'item', ...(host(tab.url) ? { detail: host(tab.url) } : {}) })
  }
  return rows
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** The rows a search keeps: label, detail or keywords contain every word typed. Dividers and headings drop out while searching. */
export function filterRows(rows: readonly MenuRow[], query: string): MenuRow[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...rows]
  return rows.filter((row) => {
    if (row.kind !== 'item' && row.kind !== 'submenu') return false
    const hay = fold(`${row.label} ${row.detail ?? ''} ${row.keywords ?? ''}`)
    return words.every((w) => hay.includes(w))
  })
}

export type ListState = { kind: 'loading' } | { kind: 'error' } | { kind: 'empty' } | { kind: 'no-match' } | { kind: 'rows'; rows: MenuRow[] }

/** Nothing there at all reads differently from nothing matching the search. */
export function listState(rows: readonly MenuRow[] | 'loading' | 'error', query: string): ListState {
  if (rows === 'loading') return { kind: 'loading' }
  if (rows === 'error') return { kind: 'error' }
  if (!rows.some(focusable)) return { kind: 'empty' }
  const kept = filterRows(rows, query)
  return kept.some(focusable) ? { kind: 'rows', rows: kept } : { kind: 'no-match' }
}

/** The next focusable row in `direction`, wrapping; -1 when none can take focus. */
export function stepRow(rows: readonly MenuRow[], from: number, direction: 1 | -1): number {
  const n = rows.length
  if (n === 0) return -1
  let i = from < 0 ? (direction === 1 ? -1 : n) : from
  for (let step = 0; step < n; step++) {
    i = (((i + direction) % n) + n) % n
    const row = rows[i]
    if (row && focusable(row)) return i
  }
  return -1
}

export function edgeRow(rows: readonly MenuRow[], edge: 'first' | 'last'): number {
  return stepRow(rows, -1, edge === 'first' ? 1 : -1)
}

export type MenuKey =
  | { type: 'move'; active: number }
  | { type: 'open'; submenu: SubmenuId }
  | { type: 'choose'; row: MenuRow }
  | { type: 'back' }
  | { type: 'close' }

export function submenuOf(row: MenuRow | undefined): SubmenuId | null {
  if (!row || row.kind !== 'submenu') return null
  const id = row.id.slice(4) as SubmenuId
  return SUBMENUS.includes(id) ? id : null
}

/**
 * What a key does in the menu. ↑ and ↓ move and wrap, Home and End jump,
 * Enter (or → on a submenu row) opens or chooses, ← and Esc go back from a
 * submenu, Esc closes the top level and Tab closes either. `searchText` is
 * the submenu's search while focus is in it: the caret keys then belong to
 * the text, except ← at its very start (an empty search).
 */
export function menuKey(key: string, rows: readonly MenuRow[], active: number, level: MenuLevel, searchText: string | null = null): MenuKey | null {
  const inSearch = searchText !== null
  const row = active >= 0 ? rows[active] : undefined
  const enter = (): MenuKey | null => {
    if (!row || !focusable(row)) return null
    const sub = submenuOf(row)
    return sub && level === 'root' ? { type: 'open', submenu: sub } : { type: 'choose', row }
  }
  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      const next = stepRow(rows, active, key === 'ArrowDown' ? 1 : -1)
      return next === -1 ? null : { type: 'move', active: next }
    }
    case 'Home':
    case 'End': {
      if (inSearch) return null
      const next = edgeRow(rows, key === 'Home' ? 'first' : 'last')
      return next === -1 ? null : { type: 'move', active: next }
    }
    case 'Enter':
      return enter()
    case 'ArrowRight':
      if (inSearch || level !== 'root') return null
      return submenuOf(row) ? enter() : null
    case 'ArrowLeft':
      if (level === 'root') return null
      if (inSearch && searchText !== '') return null
      return { type: 'back' }
    case 'Escape':
      return level === 'root' ? { type: 'close' } : { type: 'back' }
    case 'Tab':
      return { type: 'close' }
    default:
      return null
  }
}
