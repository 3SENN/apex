/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The service schemas for memory jobs, Tidy memory,
// activity memory and the timeline. main/services.ts spreads them, and
// merges MEMORY_JOBS_SCHEMAS into the `memory` namespace.
import { z } from 'zod'
import { ACTIVITY_ITEM_KINDS, type MemoryFeatureServices, type MemoryJobsMethods } from '@shared/activity'
import { SENSITIVE_CATEGORIES } from '@shared/exclusions'
import { chatIdSchema, companionIdSchema, idSchema, limitSchema, offsetSchema, ownerSchema, rangeSchema, textSchema, timeSchema } from '../serviceKit'
import type { AdditionSchemas, SchemaMap } from '../schemas/types'

const hour = z.number().int().min(0).max(23)
const days = z.array(z.number().int().min(0).max(6)).max(7)
const host = z.string().min(1).max(253)

const activityPatch = z.object({
  enabled: z.boolean().optional(),
  schedule: z.object({ on: z.boolean(), days, startHour: hour, endHour: z.number().int().min(0).max(24) }).strict().optional(),
  override: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('on-until'), until: timeSchema }).strict(),
    z.object({ kind: z.literal('off-until'), until: timeSchema }).strict(),
  ]).optional(),
  pausedUntil: timeSchema.nullable().optional(),
  retention: z.object({
    screenshotsDays: z.number().int().min(1).max(365),
    capturesDays: z.number().int().min(1).max(3650),
    notesDays: z.number().int().min(1).max(3650).nullable(),
  }).strict().optional(),
  excluded: z.object({ categories: z.array(z.enum(SENSITIVE_CATEGORIES)).max(SENSITIVE_CATEGORIES.length), sites: z.array(host).max(1000) }).strict().optional(),
  proactive: z.object({ routines: z.boolean(), insights: z.boolean() }).strict().optional(),
}).strict()

/** The methods these schemas add to `memory`. */
export const MEMORY_JOBS_SCHEMAS: AdditionSchemas<MemoryJobsMethods> = {
  estimateBuild: z.tuple([ownerSchema]),
  startJob: z.tuple([z.enum(['build', 'reorganize']), ownerSchema, z.object({ chatIds: z.array(idSchema).max(10_000).optional() }).strict().optional()]),
  cancelJob: z.tuple([idSchema]),
  retryJob: z.tuple([idSchema]),
  jobs: z.tuple([]),
  removeAll: z.tuple([ownerSchema]),
}

export const MEMORY_UPKEEP_SCHEMAS: SchemaMap<MemoryFeatureServices> = {
  memoryUpkeep: {
    settings: z.tuple([]),
    update: z.tuple([z.object({ enabled: z.boolean().optional(), afterHour: hour.optional() }).strict()]),
    passes: z.tuple([limitSchema.optional()]),
    runNow: z.tuple([companionIdSchema.optional()]),
    schedule: z.tuple([]),
  },
  activity: {
    status: z.tuple([]),
    settings: z.tuple([]),
    update: z.tuple([activityPatch]),
    pause: z.tuple([z.union([timeSchema, z.literal('today')])]),
    resume: z.tuple([]),
    override: z.tuple([z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('on-until'), until: timeSchema }).strict(),
      z.object({ kind: z.literal('off-until-tomorrow') }).strict(),
      z.object({ kind: z.literal('none') }).strict(),
    ])]),
    items: z.tuple([z.object({
      from: timeSchema.optional(),
      to: timeSchema.optional(),
      query: textSchema(500).optional(),
      kind: z.enum(ACTIVITY_ITEM_KINDS).optional(),
      offset: offsetSchema.optional(),
      limit: limitSchema.optional(),
    }).strict()]),
    remove: z.tuple([z.array(idSchema).min(1).max(10_000)]),
    clear: z.tuple([z.enum(['today', 'week', 'all'])]),
    chatIncluded: z.tuple([chatIdSchema]),
    includeInChat: z.tuple([chatIdSchema, z.boolean()]),
  },
  timeline: {
    days: z.tuple([rangeSchema]),
    sessions: z.tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
    sites: z.tuple([z.object({ from: timeSchema, to: timeSchema, sort: z.enum(['time', 'visits', 'recent']).optional(), query: textSchema(500).optional() }).strict()]),
    insights: z.tuple([rangeSchema]),
    dismissInsight: z.tuple([idSchema]),
  },
}
