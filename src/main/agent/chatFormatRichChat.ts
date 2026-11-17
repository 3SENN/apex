/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AgentEvent } from '@shared/ipc'
import type { LocalToolSnapshot, ToolPolicy } from '@shared/connectors'
import { attachmentViewToRef, isAttachmentRef, type AttachmentRef, type LegacyAttachmentView } from '@shared/attachments'

// The chat file format (version with attachments): the capability fields
// fixed at a chat's first message, and the older `user-message`
// attachments normalized to AttachmentRef on load. chats.ts calls these
// from its load path; the chat migrations build versioned steps on them.

/** The capability fields this format adds to ChatCapabilities, all fixed at the first message. */
export interface RichChatCapabilities {
  /** Code execution with the document skills. */
  documents: boolean
  /** Server-side compaction, keeping compaction blocks in history. */
  compaction: boolean
  /** The code-execution container to reuse; containers expire. */
  containerId: string | null
  /** Local connector tools as they were when the chat started. */
  localTools: LocalToolSnapshot[]
  /** Per connector, per tool, the policy at start (remote changes apply to new chats). */
  toolPolicies: Record<string, Record<string, ToolPolicy>>
  /** The extra client tools (suggest_next_steps, save_artifact, suggest_connector) the chat started with, sorted; [] in older files. */
  cClientTools: string[]
}

export const RICH_CHAT_CAPABILITY_DEFAULTS: RichChatCapabilities = { documents: false, compaction: false, containerId: null, localTools: [], toolPolicies: {}, cClientTools: [] }

const CLIENT_TOOL_NAME = /^[a-z_]{1,64}$/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Fills these capability fields for files saved before they existed (documents and compaction off, no container, no local tools). */
export function normalizeRichChatCapabilities(raw: Record<string, unknown>): RichChatCapabilities {
  return {
    documents: raw.documents === true,
    compaction: raw.compaction === true,
    containerId: typeof raw.containerId === 'string' && raw.containerId.length <= 256 ? raw.containerId : null,
    localTools: Array.isArray(raw.localTools) ? (raw.localTools.filter(isObject) as unknown as LocalToolSnapshot[]) : [],
    toolPolicies: isObject(raw.toolPolicies) ? (raw.toolPolicies as RichChatCapabilities['toolPolicies']) : {},
    cClientTools: Array.isArray(raw.cClientTools) ? raw.cClientTools.filter((n): n is string => typeof n === 'string' && CLIENT_TOOL_NAME.test(n)) : [],
  }
}

/**
 * Older `user-message.attachments` held AttachmentView entries; newer logs
 * AttachmentRef. Converts the old ones (ready, thumbnail kept, meetings with
 * `sourceId`) and leaves AttachmentRefs alone. Returns the same array when nothing changed.
 */
export function normalizeAttachmentLog(log: AgentEvent[]): AgentEvent[] {
  let changed = false
  const out = log.map((event) => {
    if (event.type !== 'user-message') return event
    const list = (event as { attachments?: unknown }).attachments
    if (!Array.isArray(list) || list.every(isAttachmentRef)) return event
    changed = true
    const attachments: AttachmentRef[] = list.flatMap((item, i) => {
      if (isAttachmentRef(item)) return [item]
      if (!isObject(item)) return []
      if (item.kind === 'image' && typeof item.thumbnail === 'string') return [attachmentViewToRef(item as LegacyAttachmentView, event.id, i)]
      if (item.kind === 'meeting' && typeof item.meetingId === 'string') {
        return [attachmentViewToRef({ kind: 'meeting', meetingId: item.meetingId, title: typeof item.title === 'string' ? item.title : '' }, event.id, i)]
      }
      return []
    })
    return { ...event, attachments } as AgentEvent
  })
  return changed ? out : log
}
