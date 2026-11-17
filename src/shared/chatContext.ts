/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for what a chat holds as context: the pages in this
// chat (CH-34) and the chat's virtual files (CH-28). Main keeps both in
// src/main/intake/**; the toolbar's pages menu and the chat files modal read
// them.
import type { FilePreviewable } from './files'

export type ChatContextSource = 'opened' | 'acted' | 'attached'

export interface ChatContextPage {
  /** Null once the tab is closed; the page stays listed as context. */
  tabId: string | null
  url: string
  title: string
  favicon: string | null
  source: ChatContextSource
  /** Whether the page's content is in the conversation. */
  inContext: boolean
  /** The chat's agent controls the tab right now; it cannot be removed then. */
  controlled: boolean
  addedAt: number
}

export type ChatFileFolder = 'tabs' | 'attachments' | 'messages' | 'tool-results' | 'context' | 'generated'
export const CHAT_FILE_FOLDERS: readonly ChatFileFolder[] = ['tabs', 'attachments', 'messages', 'tool-results', 'context', 'generated']

export interface ChatFileEntry {
  /** '/'-separated, starting with the folder: 'attachments/notes.md'. */
  path: string
  name: string
  folder: ChatFileFolder
  kind: 'folder' | 'file'
  size: number
  /** Characters of text kinds; null for binary files and folders. */
  chars: number | null
  mediaType: string
  previewable: FilePreviewable
  /** Backed by a real file Finder can show. */
  revealable: boolean
  modifiedAt: number
}

export interface ChatContextServices {
  chatContext: {
    list(chatId: string): ChatContextPage[]
    /** Takes the page out of context; throws while the agent controls the tab. */
    remove(chatId: string, tabId: string): void
    focus(chatId: string, tabId: string): void
    close(chatId: string, tabId: string): void
  }
  chatFiles: {
    /** '' lists the folders themselves. */
    list(chatId: string, folder: string): ChatFileEntry[]
    read(chatId: string, path: string): { text?: string; dataUrl?: string; truncated: boolean }
    reveal(chatId: string, path: string): void
    count(chatId: string): number
  }
}

export type ChatContextEvent = { type: 'chat-context'; chatId: string; pages: ChatContextPage[] }
