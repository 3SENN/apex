/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { MEDIA_ARTWORK_MAX, MEDIA_COMMANDS, MEDIA_RATE_MAX, MEDIA_RATE_MIN, MEDIA_SESSION_ACTIONS, MEDIA_TEXT_MAX, usableArtwork, type PageMediaReport } from '@shared/media'
import { tabIdSchema } from '../schemas/types'

// The media hub's zod schemas (MD-01): what a page helper may report on
// PAGE_MEDIA.report, and the `media` service's arguments.

const text = z.string().max(MEDIA_TEXT_MAX)

export const pageMediaReportSchema: z.ZodType<PageMediaReport> = z
  .object({
    playing: z.boolean(),
    video: z.boolean(),
    sound: z.boolean(),
    // Pages may set other speeds; anything is reported clamped to the offered range.
    rate: z.number().finite().min(0).max(16).transform((r) => Math.min(MEDIA_RATE_MAX, Math.max(MEDIA_RATE_MIN, r))),
    pip: z.boolean(),
    canPip: z.boolean(),
    resumable: z.boolean(),
    title: text,
    artist: text,
    album: text,
    artwork: z.string().max(MEDIA_ARTWORK_MAX).refine(usableArtwork).nullable(),
    actions: z.array(z.enum(MEDIA_SESSION_ACTIONS)).max(MEDIA_SESSION_ACTIONS.length),
  })
  .strict() as unknown as z.ZodType<PageMediaReport>

/** A report, or null when the frame's media is gone (its page hid). */
export const pageMediaMessageSchema = pageMediaReportSchema.nullable()

const rate = z.number().finite().min(MEDIA_RATE_MIN).max(MEDIA_RATE_MAX)

export const MEDIA_SCHEMAS = {
  media: {
    state: z.tuple([]),
    control: z.tuple([tabIdSchema, z.enum(MEDIA_COMMANDS)]),
    setRate: z.tuple([tabIdSchema, rate]),
    pictureInPicture: z.tuple([tabIdSchema]),
    focus: z.tuple([tabIdSchema]),
  },
}
