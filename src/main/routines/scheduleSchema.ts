/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The zod shape of a routine schedule, in a module with no Atelier
// imports so companions.ts (companion files) and the service schemas can
// both use it without an import cycle through serviceKit.
import { z } from 'zod'

const days = z.array(z.number().int().min(0).max(6)).max(7)

/** The four schedule kinds. Bounds here only stop junk; the store explains the real limits (30 minutes to a day, a future time). */
export const routineScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: z.string().regex(/^\d{2}:\d{2}$/), days }).strict(),
  z.object({
    kind: z.literal('interval'),
    minutes: z.number().int().min(5).max(10_080),
    between: z.object({ start: z.number().int().min(0).max(1439), end: z.number().int().min(0).max(1440) }).strict().optional(),
    days: days.optional(),
  }).strict(),
  z.object({ kind: z.literal('cron'), expr: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal('once'), at: z.number().int().min(0).max(8_640_000_000_000_000) }).strict(),
])

/** The old hourly interval, still accepted from older callers and companion files. */
export const legacyScheduleSchema = z.object({ kind: z.literal('interval'), hours: z.number().min(1).max(168) }).strict()

/** Either shape; the store migrates the legacy one to minutes. */
export const anyScheduleSchema = z.union([routineScheduleSchema, legacyScheduleSchema])
