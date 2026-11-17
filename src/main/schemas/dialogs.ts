/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { DialogServices } from '@shared/dialogs'
import { idSchema, tabIdSchema, urlSchema, type SchemaMap } from './types'

// Argument schemas for the dialog services: the chrome's confirm and alert,
// its toasts, the task manager and view source. Strings are capped so a
// compromised renderer can't hand main a huge dialog.

const label = z.string().min(1).max(200)
const text = z.string().max(10_000)

export const dialogSpecSchema = z
  .object({
    title: z.string().min(1).max(500),
    description: text.optional(),
    icon: z.enum(['info', 'warning', 'danger', 'lock']).optional(),
    callout: text.optional(),
    inputs: z
      .array(z.object({ id: z.string().min(1).max(64), label, type: z.enum(['text', 'password']), value: text.optional() }).strict())
      .max(8)
      .optional(),
    checkbox: z.object({ label, checked: z.boolean() }).strict().optional(),
    buttons: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            label,
            style: z.enum(['primary', 'secondary', 'outline', 'ghost', 'destructive', 'link']),
            align: z.enum(['start', 'end']).optional(),
            escape: z.boolean().optional(),
            enter: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
    dedupeKey: z.string().max(256).optional(),
  })
  .strict()

export const dialogResultArgSchema = z
  .object({
    button: z.string().max(64).nullable(),
    inputs: z.record(z.string().max(64), text),
    checked: z.boolean(),
  })
  .strict()

export const toastWireSchema = z
  .object({
    id: z.string().min(1).max(128).optional(),
    kind: z.enum(['info', 'success', 'error']),
    text: z.string().min(1).max(500),
    detail: z.string().max(2000).optional(),
    action: z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(60) }).strict().optional(),
    undo: z.boolean().optional(),
    durationMs: z.number().int().min(0).max(120_000).optional(),
    tabId: tabIdSchema.optional(),
  })
  .strict()

export const toastOutcomeArgSchema = z.enum(['undo', 'action', 'timeout', 'closed', 'replaced', 'tab-switch'])

export const DIALOG_SCHEMAS: SchemaMap<DialogServices> = {
  dialogs: {
    show: z.tuple([dialogSpecSchema, tabIdSchema.optional()]),
    answer: z.tuple([idSchema, dialogResultArgSchema]),
  },
  toasts: {
    show: z.tuple([toastWireSchema]),
    dismiss: z.tuple([idSchema]),
    outcome: z.tuple([idSchema, toastOutcomeArgSchema]),
  },
  taskManager: {
    list: z.tuple([]),
    end: z.tuple([idSchema]),
  },
  viewSource: {
    load: z.tuple([urlSchema]),
  },
}
