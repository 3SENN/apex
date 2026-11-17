/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The platform feature's service schemas: apps, tables, flags, the
// Calendar and Reminders helper, and site suggestions.
import { z } from 'zod'
import type { PlatformServices } from '@shared/siteSuggestions'
import { TABLE_COLUMN_TYPES } from '@shared/tables'
import { chatIdSchema, companionIdSchema, idSchema, limitSchema, offsetSchema, ownerSchema, rangeSchema, tabIdSchema, textSchema, timeSchema } from '../serviceKit'
import type { SchemaMap } from '../schemas/types'

const calendarKind = z.enum(['events', 'reminders'])
const columns = z.array(z.object({ name: z.string().trim().min(1).max(64), type: z.enum(TABLE_COLUMN_TYPES) }).strict()).min(1).max(200)
const host = z.string().min(1).max(253)

export const PLATFORM_SCHEMAS: SchemaMap<PlatformServices> = {
  apps: {
    list: z.tuple([ownerSchema.optional()]),
    get: z.tuple([idSchema]),
    save: z.tuple([z.object({ id: idSchema.optional(), name: z.string().trim().min(1).max(80), description: textSchema(2_000), owner: ownerSchema.optional() }).strict()]),
    saveDraft: z.tuple([idSchema, idSchema]),
    remove: z.tuple([idSchema]),
    restoreVersion: z.tuple([idSchema, idSchema]),
    open: z.tuple([idSchema, idSchema.optional()]),
    startBuild: z.tuple([z.string().trim().min(1).max(10_000), companionIdSchema.optional()]),
    exportHtml: z.tuple([idSchema]),
    preview: z.tuple([idSchema, z.string().regex(/^[A-Za-z0-9-]{1,64}$/)]),
  },
  tables: {
    list: z.tuple([ownerSchema.optional()]),
    get: z.tuple([idSchema]),
    pickCsv: z.tuple([ownerSchema.optional()]),
    confirmImport: z.tuple([z.string().uuid(), z.object({ name: z.string().trim().min(1).max(80), columns, hasHeader: z.boolean().optional() }).strict()]),
    previewColumns: z.tuple([z.string().uuid(), z.boolean()]),
    rows: z.tuple([idSchema, z.object({ offset: offsetSchema, limit: limitSchema, sort: z.string().max(64).optional(), desc: z.boolean().optional() }).strict()]),
    rename: z.tuple([idSchema, z.string().trim().min(1).max(80)]),
    remove: z.tuple([idSchema]),
    exportCsv: z.tuple([idSchema]),
  },
  flags: {
    list: z.tuple([]),
    set: z.tuple([z.string().regex(/^[a-z0-9-]{1,64}$/), z.string().max(64)]),
    relaunch: z.tuple([]),
  },
  calendar: {
    status: z.tuple([]),
    requestAccess: z.tuple([calendarKind]),
    setEnabled: z.tuple([calendarKind, z.boolean()]),
    upcoming: z.tuple([rangeSchema]),
    reminders: z.tuple([]),
    openPrivacySettings: z.tuple([calendarKind]),
  },
  siteSuggestions: {
    current: z.tuple([tabIdSchema]),
    settings: z.tuple([]),
    update: z.tuple([z.object({ enabled: z.boolean().optional(), offSites: z.array(host).max(1000).optional(), snoozedUntil: timeSchema.nullable().optional() }).strict()]),
    dismiss: z.tuple([tabIdSchema, z.union([z.enum(['once', 'site', 'everywhere']), z.object({ snoozeUntil: timeSchema }).strict()])]),
    draft: z.tuple([tabIdSchema, idSchema, z.union([z.object({ chatId: chatIdSchema }).strict(), z.literal('new')])]),
    openInApp: z.tuple([tabIdSchema]),
    appLink: z.tuple([tabIdSchema]),
  },
}
