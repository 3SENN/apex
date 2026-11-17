/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { ATTACHMENT_LIMITS } from '@shared/attachments'
import { IMAGE_ATTACHMENT_BASE64_MAX, type MessageAttachmentInput } from '@shared/chats'

// The one IPC schema for a message's attachments on agent.start, agent.send
// and chats.editAndResend: a screenshot (JPEG or PNG base64 up to 5 MB), a
// meeting by id, or a reference to an AttachmentStore entry, at most
// ATTACHMENT_LIMITS.perMessage (20). The composer still caps its own
// screenshots at MESSAGE_ATTACHMENTS_MAX.

const base64 = /^[A-Za-z0-9+/]+={0,2}$/

export const messageAttachmentSchema: z.ZodType<MessageAttachmentInput> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('image'),
      mediaType: z.enum(['image/jpeg', 'image/png']),
      data: z.string().min(4).max(IMAGE_ATTACHMENT_BASE64_MAX).regex(base64),
      label: z.string().max(200).optional(),
      masked: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('meeting'), meetingId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('ref'), id: z.string().uuid() }).strict(),
])

export const messageAttachmentsSchema = z.array(messageAttachmentSchema).max(ATTACHMENT_LIMITS.perMessage)
