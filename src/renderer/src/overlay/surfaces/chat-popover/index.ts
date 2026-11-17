/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { ChatPopoverSurfaceProps } from '@shared/overlay/chat-popover'
import { MENU_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { ChatPopover } from './ChatPopover'

// The chat popover (`chat-popover`, CH-50: the chat-list popover from the panel
// header; a MENU_POLICY surface). Props are in @shared/overlay/chat-popover.

const props: z.ZodType<ChatPopoverSurfaceProps['chat-popover']> = z
  .object({
    chatId: z.string().min(1).max(64).nullable(),
    panel: z.object({ canPopOut: z.boolean(), dock: z.enum(['left', 'right']) }).strict().nullable(),
  })
  .strict()

export const chatPopoverModule: SurfaceModule<ChatPopoverSurfaceProps['chat-popover']> = {
  component: ChatPopover,
  props,
  policy: { ...MENU_POLICY, onTabSwitch: 'stay' },
  placement: 'below',
  gap: 4,
}

export const CHAT_POPOVER_SURFACE_MAP: SurfaceMap = {
  'chat-popover': chatPopoverModule as unknown as SurfaceModule<never>,
}
