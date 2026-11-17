/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AgentControlState } from '@shared/services/chat'
import type { LogItem } from '../../agentLog'

// CH-38: one request tray docked above the composer. Every request waiting on
// you (approvals, questions, connector and site requests,
// sign-in or CAPTCHA hand-offs) is one entry; the tray shows one at a time
// with a counter, previous and next, Allow all and Dismiss.

/** A request as the tray lists it. `kind` picks the card; `data` is the kind's own payload. */
export interface TrayEntry {
  id: string
  kind: string
  data: unknown
}

/** A tab this chat hands to you: a check to solve, or one you took over. */
export interface Handoff {
  tabId: string
  title: string
  state: Extract<AgentControlState, 'challenge' | 'taken-over'>
}

type Approval = Extract<LogItem, { kind: 'approval' }>

export interface TrayInput {
  items: readonly LogItem[]
  /** Requests from registered sources (the agent's tools and connectors), already limited to kinds with a card. */
  sourced: readonly TrayEntry[]
  handoffs: readonly Handoff[]
  /** Whether a registered card draws approvals, so the tray leaves its own out. */
  approvalCard: boolean
}

/** Everything waiting, oldest first: hand-offs lead, since the run is stuck on them. */
export function trayEntries({ items, sourced, handoffs, approvalCard }: TrayInput): TrayEntry[] {
  const out: TrayEntry[] = handoffs.map((h) => ({ id: `handoff:${h.tabId}`, kind: 'handoff', data: h }))
  if (!approvalCard) {
    for (const item of items) if (item.kind === 'approval' && item.resolved === null) out.push({ id: item.id, kind: 'approval', data: item satisfies Approval })
  }
  const seen = new Set(out.map((e) => e.id))
  for (const entry of sourced) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push(entry)
  }
  return out
}

export interface TrayState {
  /** The entry on show; null shows the first. */
  currentId: string | null
  dismissed: ReadonlySet<string>
}

export const EMPTY_TRAY: TrayState = { currentId: null, dismissed: new Set() }

export type TrayAction =
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'show'; id: string }
  | { type: 'dismiss'; id: string }
  /** Brings dismissed requests back. */
  | { type: 'restore' }

/** The entries the tray shows: those not dismissed. */
export function visibleEntries(entries: readonly TrayEntry[], state: TrayState): TrayEntry[] {
  return entries.filter((e) => !state.dismissed.has(e.id))
}

/** The entry on show and its place: the chosen one while it waits, else the one that took its place. */
export function trayView(entries: readonly TrayEntry[], state: TrayState): { entry: TrayEntry | null; index: number; total: number; hidden: number } {
  const visible = visibleEntries(entries, state)
  const hidden = entries.length - visible.length
  if (visible.length === 0) return { entry: null, index: -1, total: 0, hidden }
  const at = state.currentId ? visible.findIndex((e) => e.id === state.currentId) : -1
  const index = at >= 0 ? at : 0
  return { entry: visible[index] ?? null, index, total: visible.length, hidden }
}

export function trayReduce(entries: readonly TrayEntry[], state: TrayState, action: TrayAction): TrayState {
  const visible = visibleEntries(entries, state)
  const { index } = trayView(entries, state)
  switch (action.type) {
    case 'next':
    case 'previous': {
      if (visible.length < 2) return state
      const step = action.type === 'next' ? 1 : visible.length - 1
      return { ...state, currentId: visible[(index + step) % visible.length]?.id ?? null }
    }
    case 'show':
      return visible.some((e) => e.id === action.id) ? { ...state, currentId: action.id } : state
    case 'dismiss': {
      const dismissed = new Set(state.dismissed)
      dismissed.add(action.id)
      // The next one along takes its place; at the end, the one before it.
      const rest = visible.filter((e) => e.id !== action.id)
      const nextIndex = Math.min(index, rest.length - 1)
      return { dismissed, currentId: rest[nextIndex]?.id ?? null }
    }
    case 'restore':
      return { ...state, dismissed: new Set() }
  }
}

/** Forgets dismissals of requests that were answered meanwhile, so the set doesn't grow. */
export function pruneTray(entries: readonly TrayEntry[], state: TrayState): TrayState {
  const ids = new Set(entries.map((e) => e.id))
  const stale = [...state.dismissed].some((id) => !ids.has(id))
  const currentGone = state.currentId !== null && !ids.has(state.currentId)
  if (!stale && !currentGone) return state
  return { currentId: currentGone ? null : state.currentId, dismissed: stale ? new Set([...state.dismissed].filter((id) => ids.has(id))) : state.dismissed }
}

/** The approvals Allow all answers: every visible plain approval. */
export function allowAllTargets(entries: readonly TrayEntry[], state: TrayState): string[] {
  return visibleEntries(entries, state).filter((e) => e.kind === 'approval').map((e) => e.id)
}
