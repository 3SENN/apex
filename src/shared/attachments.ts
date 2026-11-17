/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for chat attachments. Everything a chat holds as
// context before send: files, pasted text, tabs, selections, chats, skills,
// meetings and connector records. Main prepares each one off the main thread
// (src/main/intake/**) and the composer only ever sees these refs.
import type { AttachmentView, MessageAttachment } from './chats'

/** What an attachment is; decides how main prepares it and how the request carries it. */
export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'text'
  | 'office'
  | 'tab'
  | 'selection'
  | 'paste'
  | 'chat'
  | 'skill'
  | 'meeting'
  | 'connector-record'

export type AttachmentState = 'preparing' | 'ready' | 'failed'

export interface AttachmentRef {
  /** A uuid. Older inline attachments normalized on load get a stable `legacy-` id instead. */
  id: string
  kind: AttachmentKind
  name: string
  state: AttachmentState
  /** A plain reason while `state` is 'failed'; null otherwise. */
  error: string | null
  /** Bytes once prepared (0 while preparing). */
  size: number
  mediaType: string
  /** A data:image/webp thumbnail, at most 48 KB; null for kinds without one. */
  thumbnail: string | null
  /** Text attachments and long pastes: the line count the chip shows. */
  lines?: number
  /** PDFs: the page count. */
  pages?: number
  /** Where it came from: the tab, the selection's page or the dropped image's page. */
  source?: { url: string; title: string; tabId?: string }
  /** The record it stands for: a chat, skill, meeting or connector record id. */
  sourceId?: string
}

export const ATTACHMENT_LIMITS = {
  perMessage: 20,
  imageInputBytes: 30_000_000,
  imageLongEdge: 1568,
  imageMaxPixels: 1_150_000,
  pdfBytes: 32_000_000,
  pdfPages: 600,
  pdfPagesSmallContext: 100,
  textBytes: 2_000_000,
  officeBytes: 30_000_000,
  requestBytes: 32_000_000,
} as const

/** A paste at or above either bound becomes a chip instead of composer text (CH-24). */
export const LONG_PASTE = { chars: 1500, lines: 30 } as const

/** Thumbnails stay small: they are saved in the chat log. */
export const THUMBNAIL_MAX_BYTES = 48 * 1024

/** A dropped or picked file's base64, capped like companionFiles.add: about 30 MB of bytes. */
export const ATTACHMENT_FILE_BASE64_MAX = 40_000_000

/** An inline image attachment, as a voice screenshot passes it. */
export type InlineImageAttachment = Extract<MessageAttachment, { kind: 'image' }>

/** What the composer (or main, for inline images) hands the intake. */
export type AttachmentSource =
  | { type: 'file'; name: string; base64: string }
  | { type: 'paste'; text: string }
  | { type: 'tab'; tabId: string }
  | { type: 'selection'; text: string; url: string; title: string; links?: { text: string; url: string }[] }
  | { type: 'page-url'; tabId: string; url: string }
  | { type: 'chat'; chatId: string }
  | { type: 'skill'; skillId: string }
  | { type: 'meeting'; meetingId: string }
  | { type: 'connector-record'; connectorId: string; uri: string; title: string }
  | { type: 'inline'; attachment: InlineImageAttachment }

/** A message's attachment by reference: the uuid of an AttachmentStore entry (it widens the inline MessageAttachment). */
export interface RefAttachment {
  kind: 'ref'
  id: string
}

export interface AttachmentsServices {
  /** `draftKey` is the chat id: drafts already have one. */
  attachments: {
    /** Returns a 'preparing' ref at once; every state change arrives as an 'attachments' event. */
    add(draftKey: string, source: AttachmentSource): AttachmentRef
    /** The system file picker; resolves to the refs it added (empty when cancelled). */
    pick(draftKey: string): Promise<AttachmentRef[]>
    /** Reruns preparation from the saved original. */
    retry(draftKey: string, id: string): AttachmentRef
    remove(draftKey: string, id: string): void
    list(draftKey: string): AttachmentRef[]
    /** Edits a paste or text attachment in place (the paste preview). */
    updateText(draftKey: string, id: string, text: string): AttachmentRef
    /** The full text of a paste or text attachment ("Put back" restores it to the composer). */
    readText(draftKey: string, id: string): string
  }
}

export type AttachmentsEvent = { type: 'attachments'; draftKey: string; items: AttachmentRef[] }

/** True once every ref can be sent; Send waits for this (CH-22). */
export function attachmentsReady(items: readonly AttachmentRef[]): boolean {
  return items.every((a) => a.state === 'ready')
}

/** Whether pasted text becomes a chip rather than composer text. */
export function isLongPaste(text: string): boolean {
  if (text.length >= LONG_PASTE.chars) return true
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines >= LONG_PASTE.lines) return true
  return false
}

/**
 * The size an image is downscaled to: within `longEdge` on its long
 * side and about `maxPixels` in all, never upscaled. Floors, so neither cap
 * is ever exceeded. Main and the preprocessing renderer share it.
 */
export function fitWithin(width: number, height: number, longEdge: number = ATTACHMENT_LIMITS.imageLongEdge, maxPixels: number = ATTACHMENT_LIMITS.imageMaxPixels): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, longEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

/** The older logged attachment view, read only to normalize older chat logs. New logs carry AttachmentRef. */
export type LegacyAttachmentView = AttachmentView

/**
 * The normalizer for one older `user-message` attachment: a ready
 * ref that keeps the thumbnail, with the meeting id as `sourceId`. The id is
 * stable across loads so the log folds the same way every time.
 */
export function attachmentViewToRef(view: LegacyAttachmentView, messageId: string, index: number): AttachmentRef {
  const id = `legacy-${messageId}-${index}`
  if (view.kind === 'meeting') {
    return { id, kind: 'meeting', name: view.title, state: 'ready', error: null, size: 0, mediaType: 'text/plain', thumbnail: null, sourceId: view.meetingId }
  }
  const mediaType = /^data:(image\/[a-z+.-]+)[;,]/i.exec(view.thumbnail)?.[1] ?? 'image/jpeg'
  return { id, kind: 'image', name: view.label ?? '', state: 'ready', error: null, size: 0, mediaType, thumbnail: view.thumbnail }
}

/** Whether a logged attachment is already a ref (it has a state), as opposed to an older view. */
export function isAttachmentRef(value: unknown): value is AttachmentRef {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string' && typeof (value as { state?: unknown }).state === 'string'
}
