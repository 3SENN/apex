/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummary } from '@shared/chats'
import type { LogItem } from '../../agentLog'

// All chats' selection mode and preview pane (CH-48, CH-49). A small reducer
// for the selection, what each bulk action applies to, and how ↑/↓ move the
// previewed row. Pure, so the rules are tested.

export interface SelectionState {
  /** Selection mode shows the checkboxes and the bulk bar. */
  active: boolean
  ids: ReadonlySet<string>
  /** Where a ⇧-click range starts. */
  anchor: string | null
}

export const EMPTY_SELECTION: SelectionState = { active: false, ids: new Set(), anchor: null }

export type SelectionAction =
  | { type: 'enter' }
  | { type: 'done' }
  | { type: 'toggle'; id: string; range: boolean; order: readonly string[] }
  | { type: 'select-all'; order: readonly string[] }
  | { type: 'clear' }
  | { type: 'prune'; present: readonly string[] }

function between(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a)
  const j = order.indexOf(b)
  if (i < 0 || j < 0) return [b]
  return order.slice(Math.min(i, j), Math.max(i, j) + 1)
}

export function reduceSelection(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'enter':
      return { ...state, active: true }
    case 'done':
      return EMPTY_SELECTION
    case 'toggle': {
      const ids = new Set(state.ids)
      if (action.range && state.anchor) {
        for (const id of between(action.order, state.anchor, action.id)) ids.add(id)
        return { active: true, ids, anchor: state.anchor }
      }
      if (ids.has(action.id)) ids.delete(action.id)
      else ids.add(action.id)
      return { active: true, ids, anchor: action.id }
    }
    case 'select-all':
      return { active: true, ids: new Set(action.order), anchor: state.anchor }
    case 'clear':
      return { ...state, ids: new Set(), anchor: null }
    case 'prune': {
      const present = new Set(action.present)
      const ids = new Set([...state.ids].filter((id) => present.has(id)))
      return ids.size === state.ids.size ? state : { ...state, ids }
    }
  }
}

export interface BulkAvailability {
  count: number
  /** Mark read when any is unread, else mark unread. */
  read: 'mark-read' | 'mark-unread'
  /** Restore when all are archived, else archive. */
  archive: 'archive' | 'unarchive'
  /** Running chats stop first when deleted. */
  running: boolean
}

export function bulkAvailability(chats: readonly Pick<ChatSummary, 'unread' | 'archived' | 'status'>[]): BulkAvailability {
  return {
    count: chats.length,
    read: chats.some((c) => c.unread) ? 'mark-read' : 'mark-unread',
    archive: chats.length > 0 && chats.every((c) => c.archived) ? 'unarchive' : 'archive',
    running: chats.some((c) => c.status === 'running' || c.status === 'needs-approval'),
  }
}

/** ↑/↓ in the list: the next previewed row, clamped at the ends; the first row when none is previewed. */
export function movePreview(order: readonly string[], current: string | null, direction: 1 | -1): string | null {
  if (order.length === 0) return null
  const at = current ? order.indexOf(current) : -1
  if (at < 0) return direction === 1 ? (order[0] ?? null) : (order[order.length - 1] ?? null)
  return order[Math.max(0, Math.min(order.length - 1, at + direction))] ?? null
}

/** The preview pane opens beside the list only when there is room for both. */
export const PREVIEW_MIN_WIDTH = 1040

/** The preview pane's messages: the last few of yours and the companion's, as plain text. */
export interface PreviewMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export const PREVIEW_MESSAGES = 12

export function previewMessages(items: readonly LogItem[], plain: (markdown: string) => string, max = PREVIEW_MESSAGES): PreviewMessage[] {
  const out: PreviewMessage[] = []
  for (const item of items) {
    if (item.kind === 'user' && item.text.trim()) out.push({ id: item.id, role: 'user', text: item.text })
    else if (item.kind === 'assistant' && item.text.trim()) out.push({ id: item.id, role: 'assistant', text: plain(item.text) })
  }
  return out.slice(-max)
}

/** Whether a click on a row previews it (wide window, not selecting, no modifier) or opens it. */
export function rowClickAction(input: { previewAvailable: boolean; selecting: boolean; shift: boolean; mod: boolean }): 'toggle-range' | 'toggle' | 'open-new-tab' | 'preview' | 'open' {
  if (input.shift) return 'toggle-range'
  if (input.selecting && !input.mod) return 'toggle'
  if (input.mod) return 'open-new-tab'
  return input.previewAvailable ? 'preview' : 'open'
}
