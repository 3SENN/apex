/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Status cues for the sidebar: waiting chats, background arrivals for the
// All chats icon, the header dots and the edge badges. Pure, so they are
// unit-tested. A chat row's mood and corner mark come from the companion
// presence store (useChatFace).
import type { ChatSummary } from '@shared/chats'
import { t } from '@shared/i18n/core'
import type { DownloadInfo } from '@shared/services'

/** Waiting for you: an approval or an answer. */
export function needsYou(chat: Pick<ChatSummary, 'status' | 'needsInput'>): boolean {
  return chat.needsInput || chat.status === 'needs-approval'
}

export interface ChatMark {
  unread: boolean
  routine: boolean
}

/** What the arrival detector remembers of each chat. */
export function chatMarks(chats: readonly ChatSummary[]): Map<string, ChatMark> {
  return new Map(chats.map((c) => [c.id, { unread: c.unread, routine: c.routineId !== null }]))
}

/**
 * A chat that arrived in the background since the last list: one that just
 * became unread, or a routine run that just appeared, while no visible pane
 * shows it. The newest wins. Null on the first list (nothing "arrives" at
 * launch) and when nothing new came in.
 */
export function detectArrival(previous: ReadonlyMap<string, ChatMark> | null, next: readonly ChatSummary[], visible: ReadonlySet<string>): ChatSummary | null {
  if (!previous) return null
  let best: ChatSummary | null = null
  for (const chat of next) {
    if (chat.archived || chat.draft || visible.has(chat.id)) continue
    const before = previous.get(chat.id)
    const arrived = before ? chat.unread && !before.unread : chat.routineId !== null || chat.unread
    if (arrived && (!best || chat.lastActiveAt > best.lastActiveAt)) best = chat
  }
  return best
}

export type EdgeCue = 'active' | 'needs'

export function edgeCueLabel(cue: EdgeCue): string {
  return cue === 'active' ? t('tabs.edgeCue.active') : t('tabs.edgeCue.needs')
}

/** A [data-cue] row as measured: its cue and its rect's vertical edges in window px. */
export interface CueRow {
  cue: EdgeCue
  top: number
  bottom: number
  /** Inside an inert subtree (a collapsed section, a row leaving). */
  inert?: boolean
}

/** Rows within this many px of the edge still count as in view. */
const EDGE_SLACK = 4

/**
 * Which important rows sit wholly out of view above and below the list's
 * viewport. The active row wins over a waiting one at the same edge. Rows
 * that aren't laid out (zero height: hidden, a collapsed group) never count,
 * so no pill points at a row the list can't scroll to.
 */
export function edgeCues(rows: readonly CueRow[], view: { top: number; bottom: number }): { above: EdgeCue | null; below: EdgeCue | null } {
  let above: EdgeCue | null = null
  let below: EdgeCue | null = null
  for (const row of rows) {
    if (row.inert || row.bottom - row.top <= 0) continue
    if (row.bottom <= view.top + EDGE_SLACK && (above === null || row.cue === 'active')) above = row.cue
    if (row.top >= view.bottom - EDGE_SLACK && (below === null || row.cue === 'active')) below = row.cue
  }
  return { above, below }
}

/** The dots a section header (or the toggle) shows at rest: needs-input wins its own dot, unread its own. */
export function headerDots(chats: readonly Pick<ChatSummary, 'status' | 'needsInput' | 'unread'>[]): { needs: boolean; unread: boolean } {
  return { needs: chats.some(needsYou), unread: chats.some((c) => c.unread) }
}

/** Combined progress of the downloads still running: 0–1, null when the size is unknown, undefined when none run. */
export function downloadProgress(downloads: readonly Pick<DownloadInfo, 'state' | 'receivedBytes' | 'totalBytes'>[]): number | null | undefined {
  const active = downloads.filter((d) => d.state === 'progressing')
  if (active.length === 0) return undefined
  const total = active.reduce((sum, d) => sum + d.totalBytes, 0)
  if (total <= 0) return null
  return Math.min(1, active.reduce((sum, d) => sum + d.receivedBytes, 0) / total)
}
