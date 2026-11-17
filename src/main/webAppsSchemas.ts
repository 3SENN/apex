/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { WEB_APP_LIMITS, type WebAppsServices } from '@shared/webApps'
import type { SchemaMap } from './schemas/types'

// WA-01: the webApps service's argument schemas.

const id = z.string().min(1).max(64)

export const WEB_APPS_SCHEMAS: SchemaMap<WebAppsServices> = {
  webApps: {
    list: z.tuple([]),
    saveTab: z.tuple([z.string().min(1).max(64)]),
    saveUrl: z.tuple([z.string().url().max(WEB_APP_LIMITS.url).refine((u) => /^https?:/i.test(u), 'Only websites'), z.string().trim().min(1).max(WEB_APP_LIMITS.name)]),
    rename: z.tuple([id, z.string().trim().min(1).max(WEB_APP_LIMITS.name)]),
    remove: z.tuple([id]),
    open: z.tuple([id]),
    suggestions: z.tuple([]),
  },
}
