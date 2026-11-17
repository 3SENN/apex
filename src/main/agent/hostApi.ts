/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The engine-neutral host API other features use from main: background
// runs (routines, tidy, imports), one-shot completions (drafts, help,
// notes), chats started with an extra context block, and appending events
// to a chat's log. AgentHost implements it;
// tests use tests/helpers/fakeHost.ts, which implements the same interface.
import type { ChatStatus, ChatSummary, NewChatOptions } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { UsageKind } from '@shared/usage'

export type { UsageKind } from '@shared/usage'

export interface BackgroundRunInput {
  companionId: string
  prompt: string
  kind: UsageKind
  title?: string
  routineRun?: ChatSummary['routineRun']
  /** Append the run to this chat instead of starting a new one (a routine's `append` destination). */
  appendTo?: string
  /** The routine this run belongs to, so chat lists show it as a routine run. */
  routineId?: string
  capabilities?: Partial<{ webTools: boolean; memory: boolean; connectors: boolean }>
}

export interface CompleteInput {
  companionId?: string
  system: string
  prompt: string
  maxTokens?: number
  kind: UsageKind
}

export type StartChatOptions = NewChatOptions & {
  /** Goes into the first user message as its own block, so the prompt prefix stays cached. */
  context?: string
  open?: 'page' | 'panel' | 'none'
  /** A Creator chat (docs/apps.md › Creator mode): the builder tools are on from its first message. */
  creator?: boolean
}

export interface AgentHostApi {
  /** A background chat without browser control; resolves when it ends. */
  runBackground(input: BackgroundRunInput): Promise<{ ok: boolean; chatId: string | null; status: ChatStatus }>
  /** One model call outside any chat, recorded in the usage ledger under `kind`. */
  complete(input: CompleteInput): Promise<string>
  /** Starts a chat with its first message; returns the chat id. */
  startChat(text: string, options?: StartChatOptions): string
  appendEvent(chatId: string, event: AgentEvent): void
}
