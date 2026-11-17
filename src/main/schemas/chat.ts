/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { ChatServices, ChatsServiceAdditions } from '@shared/services/chat'
import { chatIdSchema, tabIdSchema, urlSchema, type AdditionSchemas, type SchemaMap } from './types'

// Argument schemas for the agent services: the agent's control, and the methods added to the base chats namespace.
const queuedId = z.string().uuid()

export const CHAT_SCHEMAS: SchemaMap<ChatServices> = {
  agent: {
    takeOver: z.tuple([tabIdSchema]),
    handBack: z.tuple([tabIdSchema]),
    pause: z.tuple([chatIdSchema]),
    resume: z.tuple([chatIdSchema]),
    challengeDone: z.tuple([tabIdSchema]),
    skipPage: z.tuple([tabIdSchema]),
    controlStates: z.tuple([]),
    moveNotice: z.tuple([tabIdSchema, z.object({ x: z.number().finite().min(0).max(20_000), y: z.number().finite().min(0).max(20_000) }).strict().nullable()]),
    nudge: z.tuple([tabIdSchema]),
    stopTab: z.tuple([tabIdSchema]),
    reveal: z.tuple([tabIdSchema, z.enum(['page', 'beside'])]),
  },
}

export const CHATS_SCHEMA_ADDITIONS: AdditionSchemas<ChatsServiceAdditions> = {
  preview: z.tuple([chatIdSchema]),
  continue: z.tuple([chatIdSchema]),
  interrupt: z.tuple([chatIdSchema, z.string().trim().min(1).max(20_000)]),
  sendNow: z.tuple([chatIdSchema, queuedId]),
  retryQueued: z.tuple([chatIdSchema, queuedId]),
  setActWithoutAsking: z.tuple([chatIdSchema, z.boolean()]),
  setMuted: z.tuple([chatIdSchema, z.boolean()]),
  tabsUsed: z.tuple([chatIdSchema]),
  closeTabsUsed: z.tuple([chatIdSchema, z.array(tabIdSchema).max(500).optional()]),
  older: z.tuple([chatIdSchema, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), z.number().int().min(1).max(500)]),
  draft: z.tuple([chatIdSchema]),
  setDraft: z.tuple([chatIdSchema, z.string().max(20_000)]),
  askAbout: z.tuple([urlSchema]),
  quote: z.tuple([z.object({ text: z.string().max(5000), url: urlSchema, links: z.array(urlSchema).max(20) }).strict()]),
  retrySave: z.tuple([chatIdSchema]),
}
