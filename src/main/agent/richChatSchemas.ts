/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { ChatsCompactionMethods } from '@shared/chats'
import type { AdditionSchemas } from '../schemas/types'
import { messageAttachmentsSchema } from './messageAttachments'

// Argument schemas for the agent IPC additions: the widened message
// attachments on agent.start, agent.send and chats.editAndResend, the extra
// `chats` methods, and UI.agentApproveConnector.

const chatId = z.string().regex(/^[0-9a-f-]{36}$/)
const uuid = z.string().uuid()

/** The inline attachment kinds plus a reference to an AttachmentStore entry: one schema, defined in ./messageAttachments. */
export { messageAttachmentSchema, messageAttachmentsSchema } from './messageAttachments'

/** The extra `chats` methods; merged into the base chats schemas. */
export const CHATS_COMPACTION_SCHEMAS: AdditionSchemas<ChatsCompactionMethods> = {
  /** SS-03 and CH-26: compact now (a top-level `compaction: { type: 'summarize' }`). */
  compact: z.tuple([chatId]),
  /** CH-41: a new chat with the original message and attachments, plus the connectors now on. */
  continueInNewChat: z.tuple([chatId, z.object({ connectorIds: z.array(z.string().min(1).max(128)).max(50).optional() }).strict().optional()]),
}

/** chats.editAndResend with the attachments argument (CH-09). */
export const editAndResendArgs = z.tuple([chatId, uuid, z.string().trim().min(1).max(20_000), messageAttachmentsSchema.optional()])

/** UI.agentApproveConnector: (chatId, approvalId, response). An edited input is validated again in main against the tool's schema. */
export const approveConnectorArgs = z.tuple([
  chatId,
  uuid,
  z.discriminatedUnion('allowed', [
    // The edited input is the tool's own JSON; cap it by its serialized size.
    z.object({ allowed: z.literal(true), input: z.unknown().refine((v) => JSON.stringify(v ?? null).length <= 200_000, 'Input is too large.') }).strict(),
    z.object({ allowed: z.literal(false), message: z.string().max(500).optional() }).strict(),
  ]),
])
