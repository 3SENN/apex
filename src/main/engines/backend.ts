/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { ChatErrorCode } from '@shared/chatErrors'
import type { MessageDetails } from '@shared/chats'
import type { EngineId } from '@shared/engine'
import type { LibraryFileRef } from '@shared/files'
import type { AgentEvent, Effort } from '@shared/ipc'
import type { UserBlock } from '../agent/attachments'
import type { ResultBlock } from '../agent/browserTool'
import type { ChatCapabilities, EngineSession } from '../chats'
import type { LibraryFiles } from '../files/types'
import type { PreparedAttachment } from '../intake/types'
import type { ResolvedConnector } from '../stores'

/** A PDF as a document block, for an engine that takes PDFs as documents, as the API key does. */
export type DocumentBlock = { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string }; title?: string }
/** One block of a message for another engine: text and images (UserBlock), or a PDF document. */
export type TurnBlock = UserBlock | DocumentBlock

/** The most model steps one run takes before it stops for Continue, on every engine (CH-14). */
export const MAX_STEPS = 60

// The seam between a chat and whatever runs its model turns. The API-key
// engine is the conversation loop in agent/session.ts; a build can add
// engines that run the model elsewhere (src/main/engines/extras.ts), each a
// backend. A session hands a backend one message at a time and gets back
// what the chat needs to finish the run, so queueing, stop, approvals,
// persistence and tab ownership stay the same on every engine.

export interface TurnTools {
  /** Runs a browser member or 'memory' for this chat, through the chat's own guard and approvals. */
  execute(name: string, input: unknown, signal: AbortSignal): Promise<ResultBlock[] | string>
}

export interface BackendTurn {
  chatId: string
  companionId: string
  capabilities: ChatCapabilities
  /** The chat's fixed system prompt. */
  system: string
  /** Earlier messages, oldest first (not including this one). */
  history: readonly BetaMessageParam[]
  /** This message: browser context first when the chat controls tabs, then attachments (screenshots and meetings), then your text. */
  blocks: ReadonlyArray<TurnBlock>
  /** The engine's own conversation to continue, if it has one. */
  session: EngineSession | null
  signal: AbortSignal
  emit(event: AgentEvent): void
  /** Records or replaces one model turn's details. */
  details(details: MessageDetails): void
  /** The engine started or moved its conversation; the chat saves it. */
  setSession(session: EngineSession | null): void
  tools: TurnTools
  /** The chat's enabled connectors (remote MCP servers), with their tokens. */
  connectors: readonly ResolvedConnector[]
  /** DC-15: this message's effort when a quick decision moved it from the chat's; absent: the chat's. */
  effort?: Effort
  /** Library › Files, for files the reply makes; undefined while the files feature isn't up. */
  library?(): LibraryFiles | undefined
  /** The reply made a file and it is in Library › Files now: the chat shows its card. */
  produced?(file: LibraryFileRef): void
}

/** What a backend needs to turn a message's attachments into its own blocks. */
export interface AttachmentBlockContext {
  chatId: string
  /** The chat has Files and documents on (fixed at its first message). */
  documents: boolean
  skill(skillId: string): { name: string; instructions: string } | null
}

export interface BackendResult {
  /** The reply's final text, for the "asks a question" check. */
  text: string
  /** The run stopped short and waits for you (step cap, cut off). */
  paused: boolean
  /** Shown as the chat's error; null on success. */
  error: string | null
  // CH-14, SS-03
  /** It stopped at the engine's step cap: the chat shows the step-limit card with Continue instead of an error. */
  stepLimit?: boolean
  steps?: number
  /** The error's type, for its card; guessed from the message when absent. */
  errorCode?: import('@shared/chatErrors').ChatErrorCode
  /** The raw failure for the card's Details (an API error's JSON); never shown as the reply. */
  errorDetails?: string
  /** What the card fills its words with (versions, model). */
  errorFacts?: import('@shared/chatErrors').ChatErrorFacts
  /** Overload: when the card tries again by itself. */
  retryAfterMs?: number
}

export interface AgentBackend {
  readonly engine: EngineId
  /** Answers one message. Rejects with the abort reason when the signal fires. */
  run(turn: BackendTurn): Promise<BackendResult>
  /** The chat's history was cut: drop its live process; the next message starts afresh. */
  reset(chatId: string): void
  /** The chat was deleted. */
  discard(chatId: string): void
  /**
   * Compact now (SS-03, CH-26). Condenses the chat's conversation in the
   * engine's own copy, showing the compaction card through `turn.emit`.
   * `turn.blocks` and `turn.tools` are not used. Rejects when there is
   * nothing to condense yet.
   */
  compact?(turn: BackendTurn): Promise<BackendResult>
  /** A message's attachments as this engine's blocks, placed before the typed text. Absent: the API key's blocks, sent inline. */
  attachmentBlocks?(prepared: readonly PreparedAttachment[], ctx: AttachmentBlockContext): TurnBlock[]
  /** The error code for a failure the backend threw instead of returning (its card); 'other' when unknown. */
  errorCode?(message: string): ChatErrorCode
  /** The chat was duplicated: the copy carries on from the same place. */
  duplicated?(fromChatId: string, toChatId: string): void
  /** The chat was deleted for good: whatever the engine kept for it goes. */
  removed?(chatId: string): void
}

/** Earlier messages as text, for an engine that has to start without its own copy of the chat. */
export function transcriptOf(history: readonly BetaMessageParam[], max = 40_000): string | null {
  const lines: string[] = []
  for (const message of history) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : (message.content ?? [])
    const texts = blocks.flatMap((block) => (block.type === 'text' && !block.text.startsWith('<browser_context>') ? [block.text.trim()] : [])).filter(Boolean)
    if (texts.length === 0) continue
    lines.push(`${message.role === 'user' ? 'User' : 'Assistant'}: ${texts.join('\n')}`)
  }
  if (lines.length === 0) return null
  let body = lines.join('\n\n')
  // Keep the most recent part when it is long.
  if (body.length > max) body = `…\n${body.slice(body.length - max)}`
  return `<earlier_conversation>\nThis chat continues an earlier conversation, shown here oldest first. Use it as context; the user's new message follows.\n\n${body}\n</earlier_conversation>`
}
