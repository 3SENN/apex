/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { TRANSLATE_BATCH_ITEMS, TRANSLATE_SAMPLE_MAX, TRANSLATE_TEXT_MAX, type TranslateServices } from '@shared/translate'

// Schemas for page translation (TR-07): Services.translate's arguments, which
// main/services.ts spreads, and what the page preload sends on PAGE.translate*.

const tabId = z.string().min(1).max(128)
const tag = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/)

export const TRANSLATE_SCHEMAS: { translate: { [M in keyof TranslateServices['translate']]: z.ZodType<unknown[]> } } = {
  translate: {
    translate: z.tuple([tabId, tag.optional()]),
    restore: z.tuple([tabId]),
    setAlways: z.tuple([tabId, z.boolean()]),
    setNeverSite: z.tuple([tabId, z.boolean()]),
    setNeverLanguage: z.tuple([tabId, z.boolean()]),
    openLanguageDownloads: z.tuple([]),
  },
}

const hintValue = z.string().max(200).nullable()

export const pageHintsSchema = z
  .object({ declared: hintValue, contentLanguage: hintValue, ogLocale: hintValue, optOut: z.boolean(), sample: z.string().max(TRANSLATE_SAMPLE_MAX) })
  .strict()

const session = z.string().min(1).max(64)

export const pageBatchSchema = z
  .object({ session, texts: z.array(z.string().max(TRANSLATE_TEXT_MAX)).min(1).max(TRANSLATE_BATCH_ITEMS) })
  .strict()

const count = z.number().int().min(0).max(10_000_000)
const ERROR_CODES = ['not-installed', 'unsupported', 'unavailable', 'companion-unavailable', 'unknown-language', 'failed'] as const

export const pageReportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('progress'), session, done: count, total: count }).strict(),
  z.object({ kind: z.literal('done'), session, done: count, total: count }).strict(),
  z.object({ kind: z.literal('failed'), session, error: z.enum(ERROR_CODES) }).strict(),
  z.object({ kind: z.literal('restored') }).strict(),
])
