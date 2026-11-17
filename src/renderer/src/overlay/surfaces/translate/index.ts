/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { TranslatePopoverProps } from '@shared/overlay/translate'
import { MENU_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { TranslatePopover } from './TranslatePopover'
import './translate.css'

// Page translation's surface (TR-11): the popover under the pill's translate
// button. It belongs to its tab (a tab switch closes it) and to the click
// that opened it (an outside click or Esc closes it).

const tag = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/)
const count = z.number().int().min(0).max(10_000_000)

const state = z
  .object({
    status: z.enum(['offer', 'translating', 'translated', 'error']),
    language: tag,
    target: tag,
    engine: z.enum(['apple', 'companion']).nullable(),
    error: z.enum(['not-installed', 'unsupported', 'unavailable', 'companion-unavailable', 'unknown-language', 'failed']).nullable(),
    progress: z.object({ done: count, total: count }).strict().nullable(),
    always: z.boolean(),
    neverSite: z.boolean(),
    host: z.string().max(253).nullable(),
  })
  .strict()

export const translatePopover: SurfaceModule<TranslatePopoverProps> = {
  component: TranslatePopover,
  props: z.object({ tabId: z.string().min(1).max(128), state, companion: z.string().max(200) }).strict(),
  policy: { ...MENU_POLICY, onTabSwitch: 'close' },
  placement: 'below',
  gap: 6,
}

export const TRANSLATE_SURFACE_MAP: SurfaceMap = {
  'translate-popover': translatePopover as unknown as SurfaceModule<never>,
}
