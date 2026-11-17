/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Service schemas for the agent's request
// protocol, approval mode and prompt viewer, saved site rules, the usage
// ledger, and discarding private chats. main/services.ts spreads them.
import { z } from 'zod'
import { APPROVAL_MODES, APPROVAL_SCOPES, SITE_ACCESS, type AgentToolsServices, type AgentToolsMethods, type PrivateChatsMethods } from '@shared/agentTools'
import { USAGE_GROUPS, type UsageServices } from '@shared/usage'
import { chatIdSchema, companionIdSchema, idSchema, originSchema, rangeSchema, textSchema } from '../serviceKit'
import type { AdditionSchemas, SchemaMap } from '../schemas/types'

const answer = z.union([textSchema(20_000), z.array(textSchema(2_000)).max(6), z.null()])

export const agentRequestResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), allowed: z.boolean(), scope: z.enum(APPROVAL_SCOPES) }).strict(),
  z.object({ kind: z.literal('auto-approval'), action: z.enum(['stop', 'run-now']) }).strict(),
  z.object({ kind: z.literal('site-access'), choice: z.enum(['once', 'chat', 'site', 'block']) }).strict(),
  z.object({ kind: z.literal('table-write'), allowed: z.boolean(), scope: z.enum(['once', 'chat']) }).strict(),
  z.object({ kind: z.literal('question'), answers: z.array(z.object({ id: idSchema, answer }).strict()).max(8).nullable() }).strict(),
  z.object({ kind: z.literal('proposal'), action: z.enum(['saved', 'dismissed']), savedId: idSchema.optional() }).strict(),
])

/** Methods added to `agent`; merged into the base agent schemas. */
export const AGENT_TOOLS_METHOD_SCHEMAS: AdditionSchemas<AgentToolsMethods> = {
  respond: z.tuple([chatIdSchema, idSchema, agentRequestResponse]),
  approvalMode: z.tuple([]),
  setApprovalMode: z.tuple([z.enum(APPROVAL_MODES)]),
  systemPrompt: z.tuple([z.union([z.object({ chatId: chatIdSchema }).strict(), z.object({ companionId: companionIdSchema }).strict()])]),
}

/** Methods this module adds to `chats`. */
export const PRIVATE_CHATS_SCHEMAS: AdditionSchemas<PrivateChatsMethods> = {
  discard: z.tuple([chatIdSchema]),
}

export const AGENT_TOOLS_SCHEMAS: SchemaMap<AgentToolsServices & UsageServices> = {
  agentSites: {
    overview: z.tuple([]),
    setSite: z.tuple([originSchema, z.enum(SITE_ACCESS)]),
    removeSite: z.tuple([originSchema]),
    revokeChat: z.tuple([chatIdSchema]),
  },
  usage: {
    report: z.tuple([rangeSchema, z.enum(USAGE_GROUPS)]),
    chat: z.tuple([chatIdSchema]),
  },
}
