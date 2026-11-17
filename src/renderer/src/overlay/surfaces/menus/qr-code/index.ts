/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { QrSurfaceProps } from '@shared/dialogs'
import { MENU_POLICY, type SurfaceModule } from '../../../types'
import { QrCard } from './QrCard'

// The `qr-code` module: a popover card at the top centre of the tab.

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict()

export const qrSurface: SurfaceModule<QrSurfaceProps> = {
  component: QrCard,
  props: z
    .object({
      url: z.string().min(1).max(2000),
      title: z.string().max(1000),
      // Only the SVG data URLs shared/qr.ts makes.
      svg: z.string().max(400_000).startsWith('data:image/svg+xml'),
      area: rect,
    })
    .strict(),
  policy: { ...MENU_POLICY, exitMs: 120 },
  placement: 'top-center',
  gap: 16,
}
