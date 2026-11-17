/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { HapticsServices } from '@shared/haptics'

// Argument schemas for Services.haptics. main/services.ts spreads them.
export const NATIVE_SCHEMAS: { haptics: { [M in keyof HapticsServices['haptics']]: z.ZodType<unknown[]> } } = {
  haptics: {
    perform: z.tuple([z.enum(['alignment', 'level-change', 'generic'])]),
  },
}
