/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { GROUP_COLORS, GROUP_NAME_MAX } from '@shared/tabs'
import type { SplitServiceAdditions, TabServices, TabsServiceAdditions } from '@shared/services/tabs'
import { idSchema, rectSchema, tabIdSchema, tabIdsSchema, urlSchema, windowIdSchema, type AdditionSchemas, type SchemaMap } from './types'

// Argument schemas for the tab services: groups, and the methods added to the base tabs and split namespaces.
export const TAB_SCHEMAS: SchemaMap<TabServices> = {
  tabGroups: {
    create: z.tuple([tabIdsSchema, z.string().trim().max(GROUP_NAME_MAX).optional()]),
    update: z.tuple([
      idSchema,
      z.object({ name: z.string().trim().max(GROUP_NAME_MAX).optional(), color: z.enum(GROUP_COLORS).optional(), collapsed: z.boolean().optional() }).strict(),
    ]),
    ungroup: z.tuple([idSchema]),
    close: z.tuple([idSchema]),
    addTabs: z.tuple([idSchema, tabIdsSchema]),
    removeTabs: z.tuple([tabIdsSchema]),
    newTab: z.tuple([idSchema]),
    auto: z.tuple([tabIdsSchema.optional()]),
    undoAuto: z.tuple([idSchema]),
  },
  tabMedia: {
    control: z.tuple([tabIdSchema, z.enum(['play', 'pause', 'mute', 'unmute', 'dismiss'])]),
  },
  tabDrag: {
    start: z.tuple([tabIdSchema, rectSchema.nullable().optional()]),
    end: z.tuple([z.boolean()]),
    cancel: z.tuple([]),
    over: z.tuple([z.literal('pinned').nullable()]),
    zonesSeen: z.tuple([z.number().int().nonnegative()]),
    dropOnZone: z.tuple([z.number().int().nonnegative(), z.enum(['left', 'right']).nullable()]),
  },
}

export const TABS_SCHEMA_ADDITIONS: AdditionSchemas<TabsServiceAdditions> = {
  setSelection: z.tuple([z.array(tabIdSchema).max(2000)]),
  moveToNewWindow: z.tuple([tabIdsSchema]),
  moveToWindow: z.tuple([tabIdsSchema, windowIdSchema, z.number().int().min(0).max(10_000)]),
  thumbnail: z.tuple([tabIdSchema]),
  recent: z.tuple([]),
  reveal: z.tuple([tabIdSchema]),
  revealUrl: z.tuple([z.string().min(1).max(8192)]),
  switcherHover: z.tuple([z.number().int().min(0).max(7)]),
}

export const SPLIT_SCHEMA_ADDITIONS: AdditionSchemas<SplitServiceAdditions> = {
  openUrl: z.tuple([urlSchema]),
  setRatio: z.tuple([z.number().finite().min(0.2).max(0.8)]),
  reset: z.tuple([]),
  closeSide: z.tuple([z.enum(['left', 'right'])]),
  separate: z.tuple([]),
  choose: z.tuple([tabIdSchema]),
}
