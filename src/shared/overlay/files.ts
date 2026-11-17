/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Overlay domain `files`: the pages-in-this-chat menu, the
// chat files modal and document quick look. Components and policies live in
// src/renderer/src/overlay/surfaces/files/index.ts.
import type { ViewerTarget } from '../files'

export const FILES_SURFACES = ['chat-pages-menu', 'chat-files-modal', 'quick-look'] as const

export type FilesSurfaceId = (typeof FILES_SURFACES)[number]

export interface FilesSurfaceProps {
  /** `accent` is the chat's companion colour, for the glow on a page its agent drives. */
  'chat-pages-menu': { chatId: string; accent?: string }
  /** `folder` opens straight into one folder; '' or absent shows the folder list. */
  'chat-files-modal': { chatId: string; folder?: string }
  'quick-look': { target: ViewerTarget }
}
