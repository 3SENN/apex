/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { SystemServices } from '@shared/system'

// Argument schemas for Services.system. main/services.ts spreads them.

/** A 32 px overlay badge is small; 200k characters is ample and caps abuse. */
export const OVERLAY_ICON_MAX = 200_000
const overlayPng = z.string().max(OVERLAY_ICON_MAX).regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)

export const SYSTEM_SCHEMAS: { system: { [M in keyof SystemServices['system']]: z.ZodType<unknown[]> } } = {
  system: {
    loginItem: z.tuple([]),
    setOpenAtLogin: z.tuple([z.boolean()]),
    openLoginItemsSettings: z.tuple([]),
    setTaskbarOverlay: z.tuple([z.enum(['companion', 'attention', 'unread']), overlayPng.nullable(), z.string().max(200)]),
    trayAvailable: z.tuple([]),
  },
}
