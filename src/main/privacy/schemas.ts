/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { PrivacyPackServices } from '@shared/privacyPack'
import { tabIdSchema, type SchemaMap } from '../schemas/types'

// The privacy pack's zod contracts (src/main/services.ts spreads them).

const kind = z.enum(['https', 'cookieBanners'])
const host = z.string().min(1).max(253)

export const PRIVACY_PACK_SCHEMAS: SchemaMap<PrivacyPackServices> = {
  privacy: {
    summary: z.tuple([tabIdSchema]),
    exceptions: z.tuple([]),
    setException: z.tuple([kind, host, z.boolean()]),
    cookieLists: z.tuple([]),
    updateCookieLists: z.tuple([]),
  },
}
