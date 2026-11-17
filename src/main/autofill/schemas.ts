/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { AutofillServices } from '@shared/autofill'
import { PASSWORD_MAX, USERNAME_MAX } from '@shared/passwords'
import { rectSchema, type SchemaMap } from '../schemas/types'

// Argument schemas for the autofill service the overlay surfaces call.
const popupId = z.string().uuid()
const itemId = z.string().min(1).max(128)

export const AUTOFILL_SCHEMAS: SchemaMap<AutofillServices> = {
  autofill: {
    pick: z.tuple([popupId, itemId]),
    useGenerated: z.tuple([popupId]),
    dismiss: z.tuple([popupId]),
    surfaceShown: z.tuple([popupId, rectSchema]),
    respondOffer: z.tuple([
      popupId,
      z.enum(['save', 'update', 'never', 'dismiss']),
      z.object({ username: z.string().max(USERNAME_MAX), password: z.string().min(1).max(PASSWORD_MAX) }).strict().optional(),
    ]),
    dismissImportHint: z.tuple([]),
  },
}
