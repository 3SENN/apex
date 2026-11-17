/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chat-list overlay surface: the popover from
// the panel header (CH-50).
export const CHAT_POPOVER_SURFACES = ['chat-popover'] as const

export type ChatPopoverSurfaceId = (typeof CHAT_POPOVER_SURFACES)[number]

export interface ChatPopoverSurfaceProps {
  /** The chat the panel shows, highlighted in the list; null on a fresh panel. */
  'chat-popover': {
    chatId: string | null
    /** The side panel's own actions (CH-03), shown in the footer; null elsewhere. */
    panel: { canPopOut: boolean; dock: 'left' | 'right' } | null
  }
}

/** What the popover answers with; the panel acts on it (attach, new chat, All chats). */
export type ChatPopoverResult =
  | { kind: 'open'; chatId: string; newTab: boolean }
  | { kind: 'new' }
  | { kind: 'all' }
  | { kind: 'pop-out' }
  | { kind: 'dock' }
