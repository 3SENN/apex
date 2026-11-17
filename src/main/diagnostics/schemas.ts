/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import {
  LOG_LEVELS,
  LOG_MESSAGE_MAX,
  REPORT_DESCRIPTION_MAX,
  REPORT_IMAGE_MAX_BYTES,
  REPORT_MAX_FILES,
  REPORT_MAX_IMAGES,
  type DiagnosticsServices,
} from '@shared/diagnostics'

// Argument schemas for Services.diagnostics. main/services.ts spreads them.

const level = z.enum(LOG_LEVELS as [string, ...string[]])
const chatId = z.string().regex(/^[0-9a-f-]{36}$/)
const tabId = z.string().min(1).max(64)
// 5 MB of image bytes is about 7 million base64 characters, plus the data: prefix.
const imageDataUrl = z
  .string()
  .max(Math.ceil((REPORT_IMAGE_MAX_BYTES * 4) / 3) + 64)
  .regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/)

export const logQuerySchema = z
  .object({
    levels: z.array(level).max(LOG_LEVELS.length).optional(),
    sources: z.array(z.string().min(1).max(64)).max(50).optional(),
    text: z.string().max(500).optional(),
    before: z.number().finite().min(0).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict()

export const reportDraftSchema = z
  .object({
    description: z.string().max(REPORT_DESCRIPTION_MAX),
    images: z.array(z.object({ name: z.string().min(1).max(255), dataUrl: imageDataUrl }).strict()).max(REPORT_MAX_IMAGES),
    fileTokens: z.array(z.string().uuid()).max(REPORT_MAX_FILES),
    includeChatId: chatId.nullable(),
    includeScreenshotTabId: tabId.nullable(),
    includeCrashDumps: z.boolean(),
  })
  .strict()

export const DIAGNOSTICS_SCHEMAS: { diagnostics: { [M in keyof DiagnosticsServices['diagnostics']]: z.ZodType<unknown[]> } } = {
  diagnostics: {
    logs: z.tuple([logQuerySchema]),
    tail: z.tuple([z.boolean()]),
    clearLogs: z.tuple([]),
    revealLogs: z.tuple([]),
    systemInfo: z.tuple([]),
    pickFiles: z.tuple([]),
    estimate: z.tuple([reportDraftSchema]),
    saveReport: z.tuple([reportDraftSchema, z.object({ email: z.boolean() }).strict()]),
    sendFeedback: z.tuple([]),
    crashState: z.tuple([]),
    dismissCrash: z.tuple([]),
    log: z.tuple([level, z.string().max(LOG_MESSAGE_MAX)]),
    revealReport: z.tuple([]),
    emailReport: z.tuple([]),
  },
}
