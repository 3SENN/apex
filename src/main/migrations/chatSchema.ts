/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { CHAT_FORMAT_VERSION } from '@shared/migrations'

// The check of a chat file after its steps ran, before anything is written
// (SS-09). It pins what the chat surfaces and the agent session rely on and
// lets everything else through, so fields later features add, and log events
// this build doesn't draw, never fail a chat.

const contentBlock = z.looseObject({ type: z.string().min(1) })

const message = z.looseObject({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlock)]),
})

const capabilities = z.looseObject({
  model: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  browser: z.boolean(),
  webTools: z.boolean(),
  memory: z.boolean(),
  connectorIds: z.array(z.string()),
  memoryScope: z.literal('companion').optional(),
  // An EngineId; a chat may name an engine this build doesn't offer (it then says so when it runs).
  engine: z.string().min(1).max(64),
  documents: z.boolean(),
  compaction: z.boolean(),
  containerId: z.string().nullable(),
  localTools: z.array(z.looseObject({})),
  toolPolicies: z.record(z.string(), z.unknown()),
  clientTools: z.array(z.string()),
  private: z.boolean(),
})

export const chatSchema = z.looseObject({
  formatVersion: z.literal(CHAT_FORMAT_VERSION),
  id: z.string().min(1),
  capabilities,
  system: z.string(),
  messages: z.array(message),
  log: z.array(z.looseObject({ type: z.string().min(1) })),
  details: z.record(z.string(), z.looseObject({})),
  feedback: z.record(z.string(), z.looseObject({})),
  grants: z.array(z.looseObject({ origin: z.string(), action: z.string(), at: z.number() })),
  // The summary copy: the v2 flags and v5 fields are always filled by the steps.
  actWithoutAsking: z.boolean(),
  muted: z.boolean(),
  private: z.boolean(),
})

export type ValidChat = z.infer<typeof chatSchema>

/** The first problem zod found, as a short line for the log and the report. */
export function schemaProblem(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return 'invalid chat file'
  const path = issue.path.length > 0 ? issue.path.join('.') : 'file'
  return `${path}: ${issue.message}`.slice(0, 300)
}
