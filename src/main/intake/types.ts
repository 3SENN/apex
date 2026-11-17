/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { AttachmentRef, AttachmentSource } from '@shared/attachments'
import type { ChatContextPage, ChatContextSource, ChatFileEntry } from '@shared/chatContext'

// Main-only intake APIs that the agent turn builds requests
// from, and that the viewer opens attachments and chat files through.

/** An attachment ready to go into a request. Paths are under userData/attachments/<chatId>/<id>/. */
export interface PreparedAttachment {
  ref: AttachmentRef
  payload:
    | { type: 'image'; mediaType: string; path: string }
    | { type: 'pdf'; path: string; pages: number; text: string }
    | { type: 'text'; text: string; title: string; sourceUrl: string | null }
    | { type: 'office'; path: string; mediaType: string }
    | { type: 'skill'; skillId: string }
}

export interface AttachmentStore {
  /** Throws "Wait for attachments to finish preparing" while any of them is not ready. */
  resolve(chatId: string, ids: readonly string[]): PreparedAttachment[]
  /** Ties draft attachments to the user message that sent them (edit and resend reuses them). */
  bindToMessage(chatId: string, ids: readonly string[], userMessageId: string): void
  /** CH-47: duplicate copies them; the count that failed goes in the 'chat-duplicated' event. */
  copyForChat(fromChatId: string, toChatId: string, ids?: readonly string[]): { copied: number; failed: number }
  removeChat(chatId: string): void
  /** A Files API upload made under one key (its fingerprint), so a key change uploads again. */
  setRemoteFile(chatId: string, id: string, keyFingerprint: string, fileId: string): void
  /** Remote file ids to delete with the chat. */
  remoteFiles(chatId: string): string[]
  /** For Settings › Storage ('chat-attachments'). */
  sizes(): { chatAttachments: number }
  /** ST-54: drops sent chat images older than this (in every chat, or only these), keeping their text; returns how many went. */
  pruneImages(olderThanDays: number, chatIds?: readonly string[]): number
  /** ST-54's per-chat rows: one chat's attachments on disk, and the image part of that. */
  chatSize(chatId: string): { bytes: number; imageBytes: number }
  // Main-only; the chat session and the files feature use them
  /** Same as the service's add, for main: older inline images become refs at send time. */
  add(chatId: string, source: AttachmentSource): AttachmentRef
  /** Resolves once none of these is preparing (MV-14: a meeting waits for its transcript). */
  settled(chatId: string, ids: readonly string[]): Promise<AttachmentRef[]>
  /** The Files API id uploaded for this attachment under this key, or null to upload it. */
  remoteFile(chatId: string, id: string, keyFingerprint: string): string | null
  /** The attachment's saved files, for the viewer (the SVG original is kept for it). Null when gone. */
  file(chatId: string, id: string): { ref: AttachmentRef; originalPath: string | null; preparedPath: string | null } | null
}

export interface ChatContextRegistry {
  record(chatId: string, page: { tabId: string | null; url: string; title: string; favicon: string | null; source: ChatContextSource }): void
  /** The tabs the chat's agent controls now; they can't be removed while controlled. */
  setControlled(chatId: string, tabIds: readonly string[]): void
  inContext(chatId: string): ChatContextPage[]
}

/** The chat's virtual files (CH-28), for the viewer's chat-file target. */
export interface ChatFilesReader {
  list(chatId: string, folder: string): ChatFileEntry[]
  read(chatId: string, path: string): { text?: string; dataUrl?: string; truncated: boolean }
  /** The real file behind a path, when there is one. */
  physicalPath(chatId: string, path: string): string | null
}
