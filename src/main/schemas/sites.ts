/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { SITE_PERMISSIONS, type SitePermission } from '@shared/sites'
import type { SiteServices } from '@shared/services/sites'
import { originSchema, tabIdSchema, type SchemaMap } from './types'

// Argument schemas for the sites services (per-site settings, site info, network).
const toggle = z.enum(['allow', 'block', 'default'])
const permission = z.enum(SITE_PERMISSIONS as [SitePermission, ...SitePermission[]])

export const siteSettingsPatchSchema = z
  .object({
    permissions: z.partialRecord(permission, z.enum(['allow', 'block', 'ask'])).optional(),
    devices: z
      .array(z.object({ kind: z.enum(['hid', 'usb', 'serial', 'bluetooth']), id: z.string().min(1).max(256), name: z.string().max(256) }).strict())
      .max(100)
      .optional(),
    adblock: toggle.optional(),
    popups: toggle.optional(),
    javascript: toggle.optional(),
    images: toggle.optional(),
    automaticDownloads: toggle.optional(),
    insecureContent: toggle.optional(),
    sound: toggle.optional(),
    forceDark: z.boolean().optional(),
    cookies: toggle.optional(),
    externalSchemes: z.array(z.string().regex(/^[a-z][a-z0-9+.-]{0,31}$/)).max(50).optional(),
  })
  .strict()

export const SITE_SCHEMAS: SchemaMap<SiteServices> = {
  sites: {
    get: z.tuple([originSchema]),
    set: z.tuple([originSchema, siteSettingsPatchSchema]),
    permission: z.tuple([originSchema, permission]),
    list: z.tuple([]),
    info: z.tuple([tabIdSchema]),
    clearSiteData: z.tuple([originSchema]),
    clearCache: z.tuple([originSchema.optional()]),
    setMuted: z.tuple([originSchema, z.boolean()]),
    forget: z.tuple([originSchema]),
    dataList: z.tuple([]),
    clearDomainData: z.tuple([z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i)]),
    screenSources: z.tuple([z.string().uuid()]),
    stopCapture: z.tuple([tabIdSchema, z.array(z.enum(['camera', 'microphone', 'screen'])).min(1).max(3).optional()]),
    openSystemSettings: z.tuple([z.enum(['camera', 'microphone', 'screen', 'location'])]),
    // ── permissions pass: site info schemas ──
    revokeOneTime: z.tuple([tabIdSchema, permission]),
    revokeDevice: z.tuple([tabIdSchema, z.object({ kind: z.enum(['hid', 'usb', 'serial', 'bluetooth']), id: z.string().min(1).max(256) }).strict()]),
    // ── permissions pass schemas ──
    answerQuiet: z.tuple([tabIdSchema, permission, z.boolean()]),
  },
  network: {
    isOnline: z.tuple([]),
    check: z.tuple([]),
  },
  pageErrors: {
    retry: z.tuple([tabIdSchema]),
    leave: z.tuple([tabIdSchema]),
    proceed: z.tuple([tabIdSchema]),
    allowAdblock: z.tuple([tabIdSchema]),
    details: z.tuple([tabIdSchema]),
  },
}
