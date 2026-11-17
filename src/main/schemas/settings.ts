/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { EXTENSION_IMPORT_MAX, IMPORT_TYPES } from '@shared/browserImport'
import { EXTENSION_ID } from '@shared/extensions'
import type { SettingsServices } from '@shared/services/settings'
import { chatIdSchema, stepSchema, type SchemaMap } from './types'

// Argument schemas for the settings services (interface zoom, storage, reset,
// import, the default browser, notifications access, the Dock icon, About).

const DOCK_ICON_DATA_URL_MAX = 3 * 1024 * 1024
// Browser ids are Atelier's own; profile ids are folder names ('Profile 1') or Firefox's relative paths.
const browserId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)
const profileId = z.string().min(1).max(256).regex(/^[A-Za-z0-9 ._\-/]+$/).refine((p) => !p.split('/').includes('..'), 'Not a profile.')

export const SETTINGS_SCHEMAS: SchemaMap<SettingsServices> = {
  uiZoom: {
    step: z.tuple([stepSchema]),
    reset: z.tuple([]),
  },
  storage: {
    categories: z.tuple([]),
    clear: z.tuple([z.string().regex(/^[a-z0-9-]{1,64}$/)]),
    chats: z.tuple([]),
    removeImages: z.tuple([z.object({ chatIds: z.array(chatIdSchema).max(500).optional(), olderThanDays: z.number().int().min(0).max(3650) }).strict()]),
    clearBrowsingData: z.tuple([z.object({ range: z.enum(['hour', 'day', 'week', 'month', 'all']), history: z.boolean(), siteData: z.boolean(), cache: z.boolean() }).strict()]),
    openClearDialog: z.tuple([]),
  },
  reset: {
    run: z.tuple([z.object({ secrets: z.boolean(), dryRun: z.boolean() }).strict()]),
    steps: z.tuple([]),
  },
  browserImport: {
    browsers: z.tuple([]),
    run: z.tuple([z.object({ browserId, profileId, types: z.array(z.enum(IMPORT_TYPES)).min(1).max(IMPORT_TYPES.length) }).strict()]),
    openAccessSettings: z.tuple([]),
    extensions: z.tuple([browserId, profileId]),
    installExtensions: z.tuple([z.object({ browserId, profileId, ids: z.array(z.string().regex(EXTENSION_ID)).min(1).max(EXTENSION_IMPORT_MAX) }).strict()]),
    addRecommended: z.tuple([z.string().regex(EXTENSION_ID)]),
  },
  defaultBrowser: {
    status: z.tuple([]),
    register: z.tuple([]),
  },
  notificationAccess: {
    status: z.tuple([]),
    openSystemSettings: z.tuple([]),
    test: z.tuple([]),
  },
  dockChoice: {
    apply: z.tuple([z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(DOCK_ICON_DATA_URL_MAX).startsWith('data:image/png;base64,')]),
  },
  about: {
    info: z.tuple([]),
  },
}
