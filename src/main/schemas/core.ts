/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { CoreServices } from '@shared/services/core'
import { chatIdSchema, urlSchema, windowIdSchema, type SchemaMap } from './types'

// Argument schemas for the core services (windows).
export const CORE_SCHEMAS: SchemaMap<CoreServices> = {
  windows: {
    list: z.tuple([]),
    open: z.tuple([z.enum(['normal', 'private']), z.object({ url: urlSchema.optional() }).strict().optional()]),
    focus: z.tuple([windowIdSchema]),
    close: z.tuple([windowIdSchema.optional()]),
    openChat: z.tuple([chatIdSchema]),
    recentlyClosed: z.tuple([]),
    reopen: z.tuple([z.number().int().min(0).max(100).optional()]),
    current: z.tuple([]),
    setFocusMode: z.tuple([z.boolean()]),
  },
}
