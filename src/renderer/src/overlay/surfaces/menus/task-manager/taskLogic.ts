/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TaskRow } from '@shared/dialogs'

// The task manager's pure parts: sorting by a column, the totals
// line, keyboard selection and keeping the selection across refreshes. No
// DOM, so they are unit tested directly.

export type TaskSortKey = 'title' | 'memory' | 'cpu' | 'pid'

export interface TaskSort {
  key: TaskSortKey
  dir: 'asc' | 'desc'
}

/** How often the sheet asks main for a fresh sample. */
export const TASK_POLL_MS = 2000

/** Main's order (browser, chrome, overlay, tabs, then the rest) until a column is chosen. */
export function sortTasks(rows: readonly TaskRow[], sort: TaskSort | null): TaskRow[] {
  if (!sort) return [...rows]
  const sign = sort.dir === 'asc' ? 1 : -1
  const value = (r: TaskRow): number | string => (sort.key === 'title' ? r.title.toLocaleLowerCase() : sort.key === 'memory' ? r.memoryBytes : sort.key === 'cpu' ? r.cpuPercent : r.pid)
  return [...rows].sort((a, b) => {
    const va = value(a)
    const vb = value(b)
    const order = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb) : (va as number) - (vb as number)
    return order * sign || a.id.localeCompare(b.id)
  })
}

/** A column header press: a new column starts descending for numbers and ascending for names; the same column flips. */
export function nextSort(current: TaskSort | null, key: TaskSortKey): TaskSort {
  if (current?.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'title' ? 'asc' : 'desc' }
}

export function totals(rows: readonly TaskRow[]): { count: number; memoryBytes: number; cpuPercent: number } {
  let memoryBytes = 0
  let cpuPercent = 0
  for (const r of rows) {
    memoryBytes += r.memoryBytes
    cpuPercent += r.cpuPercent
  }
  return { count: rows.length, memoryBytes, cpuPercent: Math.round(cpuPercent * 10) / 10 }
}

/** CPU with one decimal, the way the column shows it. */
export function formatCpu(percent: number): string {
  return (Math.round(Math.max(0, percent) * 10) / 10).toFixed(1)
}

/** The row a key moves the selection to, or undefined when the key is not a move. */
export function moveSelection(rows: readonly TaskRow[], selectedId: string | null, key: string): string | null | undefined {
  if (rows.length === 0) return key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End' ? null : undefined
  const index = selectedId ? rows.findIndex((r) => r.id === selectedId) : -1
  switch (key) {
    case 'ArrowDown':
      return rows[index < 0 ? 0 : Math.min(rows.length - 1, index + 1)]!.id
    case 'ArrowUp':
      return rows[index < 0 ? rows.length - 1 : Math.max(0, index - 1)]!.id
    case 'Home':
      return rows[0]!.id
    case 'End':
      return rows[rows.length - 1]!.id
    case 'PageDown':
      return rows[Math.min(rows.length - 1, Math.max(0, index) + 10)]!.id
    case 'PageUp':
      return rows[Math.max(0, index - 10)]!.id
    default:
      return undefined
  }
}

/** A selection survives a refresh while its row is still there. */
export function keepSelection(rows: readonly TaskRow[], selectedId: string | null): string | null {
  return selectedId && rows.some((r) => r.id === selectedId) ? selectedId : null
}
