/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore } from 'react'
import { MESSAGE_ATTACHMENTS_MAX, type MessageAttachment } from '@shared/chats'

// What a chat's next message carries: attached meetings
// and screenshots, kept per chat id beside its draft text. The Meetings
// pages add to it ("Ask about this meeting", "Attach to a chat") and the
// composer takes it on send. The file intake chips sit beside these.

export interface DraftAttachment {
  attachment: MessageAttachment
  /** The chip's text: a meeting's title or a screenshot's label. */
  label: string
  /** A small data URL for image chips. */
  thumbnail?: string
}

const drafts = new Map<string, DraftAttachment[]>()
const listeners = new Set<() => void>()
const EMPTY: readonly DraftAttachment[] = []

function emit(): void {
  for (const fn of [...listeners]) fn()
}

export function draftAttachments(chatId: string): readonly DraftAttachment[] {
  return drafts.get(chatId) ?? EMPTY
}

function key(a: MessageAttachment): string {
  return a.kind === 'meeting' ? `meeting:${a.meetingId}` : `image:${a.data.length}:${a.data.slice(0, 32)}`
}

/** Adds one attachment; a meeting already attached isn't added twice. Returns false when the message is full. */
export function attachToDraft(chatId: string, item: DraftAttachment): boolean {
  const list = drafts.get(chatId) ?? []
  if (list.some((d) => key(d.attachment) === key(item.attachment))) return true
  if (list.length >= MESSAGE_ATTACHMENTS_MAX) return false
  drafts.set(chatId, [...list, item])
  emit()
  return true
}

export function removeFromDraft(chatId: string, index: number): void {
  const list = drafts.get(chatId)
  if (!list || index < 0 || index >= list.length) return
  const next = list.filter((_, i) => i !== index)
  if (next.length) drafts.set(chatId, next)
  else drafts.delete(chatId)
  emit()
}

/** Takes everything for a send and empties the draft. */
export function takeDraftAttachments(chatId: string): DraftAttachment[] {
  const list = drafts.get(chatId) ?? []
  if (list.length) {
    drafts.delete(chatId)
    emit()
  }
  return [...list]
}

/** Puts attachments back after a failed or cancelled send, ahead of anything added since. */
export function restoreDraftAttachments(chatId: string, items: readonly DraftAttachment[]): void {
  if (items.length === 0) return
  const merged = [...items]
  for (const d of drafts.get(chatId) ?? []) if (!merged.some((m) => key(m.attachment) === key(d.attachment))) merged.push(d)
  drafts.set(chatId, merged.slice(0, MESSAGE_ATTACHMENTS_MAX))
  emit()
}

export function subscribeDrafts(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useDraftAttachments(chatId: string): readonly DraftAttachment[] {
  return useSyncExternalStore(subscribeDrafts, () => draftAttachments(chatId))
}
