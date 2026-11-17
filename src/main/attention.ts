/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import type { AttentionState } from '@shared/notifications'

// Attention (NS-02): the Dock badge, bouncing or flashing, and
// the counts the tray reads. The settings feature keeps the counts from the
// chat store and installs the badge (debounced) and the bounce; the chat may also
// drive setUnread and request from its chat events.

const emitter = new EventEmitter<{ change: [AttentionState] }>()
let state: AttentionState = { unread: 0, needsYou: 0 }
let requester: (() => void) | null = null
let lastRequest = 0

/** Two approvals in quick succession bounce once. */
export const REQUEST_GAP_MS = 2000

function set(next: AttentionState): void {
  if (next.unread === state.unread && next.needsYou === state.needsYou) return
  state = next
  emitter.emit('change', { ...state })
}

export const attention = {
  setUnread(count: number): void {
    set({ ...state, unread: Math.max(0, Math.floor(count)) })
  },
  setNeedsYou(count: number): void {
    set({ ...state, needsYou: Math.max(0, Math.floor(count)) })
  },
  /** Bounces the Dock icon (macOS) or flashes the frame; the settings feature installs the platform call. */
  request(now = Date.now()): void {
    if (now - lastRequest < REQUEST_GAP_MS) return
    lastRequest = now
    requester?.()
  },
  setRequester(fn: (() => void) | null): void {
    requester = fn
  },
  state(): AttentionState {
    return { ...state }
  },
  onChange(fn: (s: AttentionState) => void): () => void {
    emitter.on('change', fn)
    return () => {
      emitter.off('change', fn)
    }
  },
}

/** The counts from chat summaries: unread finished work, and chats waiting on an approval or answer. */
export function attentionCounts(chats: ReadonlyArray<{ unread: boolean; archived: boolean; draft: boolean; status: string; needsInput: boolean }>): AttentionState {
  let unread = 0
  let needsYou = 0
  for (const c of chats) {
    if (c.draft || c.archived) continue
    if (c.unread) unread++
    if (c.status === 'needs-approval' || c.needsInput) needsYou++
  }
  return { unread, needsYou }
}

/** The badge text: the unread count, capped, or nothing. */
export function badgeText(unread: number): string {
  if (unread <= 0) return ''
  return unread > 99 ? '99+' : String(unread)
}

/**
 * Calls `apply` with the latest value once `ms` pass without a new one, so a
 * burst of chat updates sets the Dock badge once.
 */
export function debounced<T>(ms: number, apply: (value: T) => void): { push(value: T): void; flush(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { value: T } | null = null
  const fire = (): void => {
    timer = null
    if (!pending) return
    const { value } = pending
    pending = null
    apply(value)
  }
  return {
    push(value) {
      pending = { value }
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, ms)
    },
    flush() {
      if (timer) clearTimeout(timer)
      fire()
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    },
  }
}

/** Which chats just started waiting on an approval (they bounce the Dock once each). */
export function newlyWaiting(before: ReadonlyMap<string, string>, chats: ReadonlyArray<{ id: string; status: string }>): string[] {
  return chats.filter((c) => c.status === 'needs-approval' && before.get(c.id) !== undefined && before.get(c.id) !== 'needs-approval').map((c) => c.id)
}
