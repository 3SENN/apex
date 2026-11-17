/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { MeetingCaptureServices } from '@shared/meetingCapture'
import { tabIdSchema, urlSchema, type SchemaMap } from '../../schemas/types'

// Argument schemas for the meeting capture service.
export const MEETING_CAPTURE_SCHEMAS: SchemaMap<MeetingCaptureServices> = {
  meetingCapture: {
    status: z.tuple([]),
    start: z.tuple([
      z.object({ kind: z.enum(['meeting', 'recording']), tabId: tabIdSchema.optional(), url: urlSchema.optional(), title: z.string().max(200).optional() }).strict(),
    ]),
    stop: z.tuple([]),
    pause: z.tuple([]),
    resume: z.tuple([]),
  },
}
