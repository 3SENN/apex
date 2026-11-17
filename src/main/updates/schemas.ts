/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { UpdatesServices } from '@shared/updates'

// Argument schemas for Services.updates. main/services.ts spreads them.
export const UPDATES_SCHEMAS: { updates: { [M in keyof UpdatesServices['updates']]: z.ZodType<unknown[]> } } = {
  updates: {
    status: z.tuple([]),
    check: z.tuple([]),
    download: z.tuple([]),
    install: z.tuple([z.object({ whenIdle: z.boolean().optional() }).strict().optional()]),
    later: z.tuple([]),
    snoozeUnsupported: z.tuple([]),
    whatsNew: z.tuple([]),
    dismissWhatsNew: z.tuple([]),
    notes: z.tuple([]),
  },
}
