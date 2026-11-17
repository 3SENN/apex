/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { POPOVER_MAX_ROWS, ROW_URL_MAX, type DownloadsPopoverProps } from '@shared/downloads'
import { MENU_POLICY, type SurfaceModule } from '../../../types'
import { DownloadsPopover } from './DownloadsPopover'

// The `downloads` popover module. It stays open across tab
// switches: a download link often opens and closes a tab of its own.

const count = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER)

const row = z
  .object({
    id: z.string().min(1).max(64),
    url: z.string().max(ROW_URL_MAX),
    filename: z.string().max(1024),
    state: z.enum(['progressing', 'completed', 'cancelled', 'interrupted']),
    receivedBytes: count,
    totalBytes: z.number().finite().min(-1).max(Number.MAX_SAFE_INTEGER),
    startedAt: count,
    speedBps: count,
    etaSeconds: count.nullable(),
    danger: z.enum(['none', 'uncommon', 'dangerous']),
    byAgent: z.boolean(),
    mime: z.string().max(256),
  })
  .strict()

export const downloadsSurface: SurfaceModule<DownloadsPopoverProps> = {
  component: DownloadsPopover,
  props: z.object({ items: z.array(row).max(POPOVER_MAX_ROWS).nullable(), total: z.number().int().min(0).max(1_000_000) }).strict(),
  policy: { ...MENU_POLICY, onTabSwitch: 'stay' },
}
