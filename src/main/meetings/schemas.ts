/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { MEETING_LABEL_MAX, MEETING_TITLE_MAX, type MeetingsServices } from '@shared/meetings'
import { COMPANION_ID } from '../companions'
import type { SchemaMap } from '../schemas/types'

// Argument schemas for the meetings library service.
const meetingId = z.string().uuid()

export const MEETINGS_SCHEMAS: SchemaMap<MeetingsServices> = {
  meetings: {
    list: z.tuple([z.object({ query: z.string().max(500).optional(), kind: z.enum(['meeting', 'recording']).optional() }).strict().optional()]),
    get: z.tuple([meetingId]),
    rename: z.tuple([meetingId, z.string().trim().min(1).max(MEETING_TITLE_MAX)]),
    renameLabel: z.tuple([meetingId, z.enum(['mic', 'system']), z.string().trim().min(1).max(MEETING_LABEL_MAX)]),
    summarize: z.tuple([meetingId]),
    retranscribe: z.tuple([meetingId]),
    exportFile: z.tuple([meetingId, z.enum(['markdown', 'audio'])]),
    remove: z.tuple([meetingId]),
    storage: z.tuple([]),
    discuss: z.tuple([meetingId, z.string().regex(COMPANION_ID).optional()]),
  },
}
