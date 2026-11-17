/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Service schemas for skill folders and full routines. They cover the whole
// `skills` and `routines` namespaces, the original methods included
// (widened: filters, steps, the full schedules); main/services.ts uses them
// as those namespaces.
import { z } from 'zod'
import { NOTIFY_IF_MAX, type RoutinesMethods } from '@shared/routines'
import type { Services } from '@shared/services'
import { SKILL_FILE_MAX_BYTES, type SkillsMethods } from '@shared/skills'
import { base64Schema, chatIdSchema, companionIdSchema, idSchema, limitSchema, offsetSchema, ownerSchema, relPathSchema, textSchema, timeSchema } from '../serviceKit'
import type { AdditionSchemas } from '../schemas/types'
import { anyScheduleSchema, routineScheduleSchema } from './scheduleSchema'

const timeZone = z.string().min(1).max(64).nullable()

export const routineSchedule = routineScheduleSchema

export const skillStep = z.object({ id: idSchema, title: textSchema(200), instructions: textSchema(20_000) }).strict()

export const skillDraft = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  description: textSchema(500),
  instructions: textSchema(50_000),
  steps: z.array(skillStep).max(50).optional(),
  owner: ownerSchema.optional(),
}).strict()

const destination = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new-chat') }).strict(),
  z.object({ kind: z.literal('append'), chatId: chatIdSchema }).strict(),
])

export const routineDraft = z.object({
  name: z.string().trim().min(1).max(80),
  prompt: textSchema(10_000),
  skillId: idSchema.optional(),
  schedule: routineSchedule,
  companionId: companionIdSchema.optional(),
  destination: destination.optional(),
  timeZone: timeZone.optional(),
  notifyIf: z.string().max(NOTIFY_IF_MAX).optional(),
}).strict()

const skillFilter = z.object({
  query: z.string().max(200).optional(),
  source: z.enum(['yours', 'companions', 'builtin']).optional(),
  owner: ownerSchema.optional(),
  updatedSince: timeSchema.optional(),
  sort: z.enum(['recent-use', 'recent-update', 'name']).optional(),
}).strict()

const routineFilter = z.object({
  status: z.enum(['active', 'paused', 'past']).optional(),
  companionId: companionIdSchema.optional(),
  kind: z.enum(['daily', 'interval', 'cron', 'once']).optional(),
  query: z.string().max(200).optional(),
  sort: z.enum(['name', 'next-run']).optional(),
}).strict()

/** What `routines.save` takes: a draft (the older `owner` and hourly schedule still accepted), plus id, enabled and the revision it was read at. */
export const routineSave = z.object({
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(80),
  prompt: textSchema(10_000),
  skillId: idSchema.optional(),
  schedule: anyScheduleSchema,
  companionId: companionIdSchema.optional(),
  owner: ownerSchema.optional(),
  destination: destination.optional(),
  timeZone: timeZone.optional(),
  notifyIf: z.string().max(NOTIFY_IF_MAX).optional(),
  enabled: z.boolean(),
  revision: z.number().int().min(0).max(1_000_000_000).optional(),
}).strict()

type A0Skills = Omit<Services['skills'], keyof SkillsMethods>
type A0Routines = Omit<Services['routines'], keyof RoutinesMethods>

/** The whole `skills` namespace. */
export const SKILLS_SCHEMAS: AdditionSchemas<SkillsMethods & A0Skills> = {
  list: z.tuple([skillFilter.optional()]),
  save: z.tuple([skillDraft.extend({ id: idSchema.optional() }).strict()]),
  remove: z.tuple([idSchema]),
  exportFile: z.tuple([idSchema]),
  importFile: z.tuple([ownerSchema.optional()]),
  get: z.tuple([idSchema]),
  duplicate: z.tuple([idSchema, ownerSchema.optional()]),
  files: z.tuple([idSchema]),
  readFile: z.tuple([idSchema, relPathSchema.min(1)]),
  writeFile: z.tuple([idSchema, relPathSchema.min(1), textSchema(SKILL_FILE_MAX_BYTES)]),
  addFile: z.tuple([idSchema, z.string().min(1).max(255), base64Schema(SKILL_FILE_MAX_BYTES)]),
  removeFile: z.tuple([idSchema, relPathSchema.min(1)]),
  reveal: z.tuple([idSchema]),
  draftFromChat: z.tuple([chatIdSchema]),
  run: z.tuple([idSchema, companionIdSchema.optional()]),
}

/** The whole `routines` namespace. */
export const ROUTINES_SCHEMAS: AdditionSchemas<RoutinesMethods & A0Routines> = {
  list: z.tuple([routineFilter.optional()]),
  save: z.tuple([routineSave]),
  remove: z.tuple([idSchema]),
  runNow: z.tuple([idSchema]),
  get: z.tuple([idSchema]),
  setEnabled: z.tuple([idSchema, z.boolean()]),
  runs: z.tuple([z.object({ routineId: idSchema.optional(), offset: offsetSchema.optional(), limit: limitSchema.optional(), unreadOnly: z.boolean().optional() }).strict()]),
  markRunsRead: z.tuple([idSchema.optional()]),
  previewSchedule: z.tuple([anyScheduleSchema, timeZone, z.number().int().min(1).max(50).optional()]),
  validateCron: z.tuple([z.string().max(120)]),
  suggestions: z.tuple([]),
  dismissSuggestion: z.tuple([idSchema]),
}
