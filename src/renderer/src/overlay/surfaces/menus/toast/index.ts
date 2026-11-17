/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { ToastSurfaceProps } from '@shared/dialogs'
import type { SurfaceModule } from '../../../types'
import { ToastSurface } from './ToastSurface'

// The `toast` surface module (OV-05). Interactive so Undo can be pressed,
// but it never takes focus or closes on outside presses; a tab switch closes
// it (main reports 'tab-switch' to whoever showed it).

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict()

export const toastSurface: SurfaceModule<ToastSurfaceProps> = {
  component: ToastSurface,
  props: z
    .object({
      toast: z
        .object({
          id: z.string().min(1).max(128),
          kind: z.enum(['info', 'success', 'error']),
          text: z.string().min(1).max(500),
          detail: z.string().max(2000).optional(),
          action: z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(60) }).strict().optional(),
          undo: z.boolean().optional(),
          durationMs: z.number().int().min(0).max(120_000).optional(),
          tabId: z.string().min(1).max(64).optional(),
        })
        .strict(),
      area: rect,
    })
    .strict(),
  policy: { tier: 'interactive', size: 'fixed', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'close', layer: 'hint', focus: false, exitMs: 140 },
  placement: 'top-center',
  gap: 12,
}
