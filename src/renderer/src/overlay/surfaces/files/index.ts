/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { FilesSurfaceProps } from '@shared/overlay/files'
import type { ViewerTarget } from '@shared/files'
import { CASCADE_MENU_POLICY } from '../../kit/host'
import { MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { ChatFilesModalSurface } from './ChatFilesModal'
import { PagesMenuSurface } from './PagesMenu'
import { QuickLookSurface } from './QuickLook'

// Files: the pages-in-chat menu, the chat files modal and quick look.
// The pages menu is a card under the toolbar control that may reach over the
// page; the chat files modal and quick look are window modals over the page.

const uuid = z.string().regex(/^[0-9a-f-]{36}$/)
const recordId = z.string().min(1).max(128)
const relPath = z.string().min(1).max(1024).refine((p) => !p.includes('\0'))

// Shape only: main validates the target again and confines every path.
const target: z.ZodType<ViewerTarget> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('companion-file'), companionId: recordId, path: relPath }).strict(),
  z.object({ kind: z.literal('memory'), owner: recordId, path: relPath }).strict(),
  z.object({ kind: z.literal('skill'), skillId: recordId }).strict(),
  z.object({ kind: z.literal('meeting'), meetingId: recordId }).strict(),
  z.object({ kind: z.literal('chat-file'), chatId: uuid, path: relPath }).strict(),
  z.object({ kind: z.literal('attachment'), chatId: uuid, attachmentId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('local'), path: z.string().min(1).max(4096) }).strict(),
])

const pagesMenu: SurfaceModule<FilesSurfaceProps['chat-pages-menu']> = {
  component: PagesMenuSurface,
  props: z.object({ chatId: uuid, accent: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional() }).strict(),
  policy: CASCADE_MENU_POLICY,
}

const chatFiles: SurfaceModule<FilesSurfaceProps['chat-files-modal']> = {
  component: ChatFilesModalSurface,
  props: z.object({ chatId: uuid, folder: z.string().max(1024).optional() }).strict(),
  policy: { ...MODAL_POLICY, size: 'fill-window' },
}

const quickLook: SurfaceModule<FilesSurfaceProps['quick-look']> = {
  component: QuickLookSurface,
  props: z.object({ target }).strict(),
  // Over the tab; a tab switch closes it (its file belongs to that tab's context).
  policy: { ...MODAL_POLICY, size: 'fill-window', outsideClick: 'close', onTabSwitch: 'close', exitMs: 140 },
}

export const FILES_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; each schema checks props at open.
  'chat-pages-menu': pagesMenu as unknown as SurfaceModule<never>,
  'chat-files-modal': chatFiles as unknown as SurfaceModule<never>,
  'quick-look': quickLook as unknown as SurfaceModule<never>,
}
