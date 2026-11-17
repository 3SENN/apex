/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { ATTACHMENT_FILE_BASE64_MAX, ATTACHMENT_LIMITS, type AttachmentsServices } from '@shared/attachments'
import type { ChatContextServices } from '@shared/chatContext'
import { IMAGE_ATTACHMENT_BASE64_MAX } from '@shared/chats'
import type { SchemaMap } from '../schemas/types'

// Argument schemas for Services.attachments, chatContext and chatFiles
//. main/services.ts spreads them; a missing method fails a unit test.

/** A chat id is also a draft's attachment key. */
const draftKey = z.string().regex(/^[0-9a-f-]{36}$/)
const attachmentId = z.string().uuid()
const tabId = z.string().min(1).max(64)
const url = z.string().min(1).max(8192)
const title = z.string().max(1024)
const recordId = z.string().min(1).max(128)
/** A path inside the chat's virtual files; the store confines it further. */
const chatFilePath = z.string().max(1024).refine((p) => !p.includes('\0') && !p.split('/').includes('..'))

export const attachmentSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), name: z.string().min(1).max(255), base64: z.string().max(ATTACHMENT_FILE_BASE64_MAX).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict(),
  z.object({ type: z.literal('paste'), text: z.string().min(1).max(ATTACHMENT_LIMITS.textBytes) }).strict(),
  z.object({ type: z.literal('tab'), tabId }).strict(),
  z.object({
    type: z.literal('selection'),
    text: z.string().min(1).max(200_000),
    url,
    title,
    links: z.array(z.object({ text: z.string().max(1024), url }).strict()).max(200).optional(),
  }).strict(),
  z.object({ type: z.literal('page-url'), tabId, url }).strict(),
  z.object({ type: z.literal('chat'), chatId: draftKey }).strict(),
  z.object({ type: z.literal('skill'), skillId: recordId }).strict(),
  z.object({ type: z.literal('meeting'), meetingId: recordId }).strict(),
  z.object({ type: z.literal('connector-record'), connectorId: recordId, uri: z.string().min(1).max(4096), title }).strict(),
  z.object({
    type: z.literal('inline'),
    attachment: z.object({
      kind: z.literal('image'),
      mediaType: z.enum(['image/jpeg', 'image/png']),
      data: z.string().min(1).max(IMAGE_ATTACHMENT_BASE64_MAX).regex(/^[A-Za-z0-9+/]*={0,2}$/),
      label: z.string().max(200).optional(),
      masked: z.boolean().optional(),
    }).strict(),
  }).strict(),
])

export const INTAKE_SCHEMAS: SchemaMap<AttachmentsServices & ChatContextServices> = {
  attachments: {
    add: z.tuple([draftKey, attachmentSourceSchema]),
    pick: z.tuple([draftKey]),
    retry: z.tuple([draftKey, attachmentId]),
    remove: z.tuple([draftKey, attachmentId]),
    list: z.tuple([draftKey]),
    updateText: z.tuple([draftKey, attachmentId, z.string().min(1).max(ATTACHMENT_LIMITS.textBytes)]),
    readText: z.tuple([draftKey, attachmentId]),
  },
  chatContext: {
    list: z.tuple([draftKey]),
    remove: z.tuple([draftKey, tabId]),
    focus: z.tuple([draftKey, tabId]),
    close: z.tuple([draftKey, tabId]),
  },
  chatFiles: {
    list: z.tuple([draftKey, chatFilePath]),
    read: z.tuple([draftKey, chatFilePath.min(1)]),
    reveal: z.tuple([draftKey, chatFilePath.min(1)]),
    count: z.tuple([draftKey]),
  },
}
