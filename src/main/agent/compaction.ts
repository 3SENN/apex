/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaRawMessageStreamEvent,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { AgentEvent } from '@shared/ipc'

// CH-26: server-side compaction on API-key chats. Two kinds, each
// with its own beta (checked against the claude-api skill and the SDK types):
// - threshold ("auto"): `context_management.edits [compact_20260112]` under
//   `compact-2026-01-12`. The response is appended verbatim; the API drops
//   what came before the block on later requests, so the saved history stays
//   append-only.
// - on demand ("manual", SS-03): a request with the top-level
//   `compaction: { type: 'summarize' }` under `compact-2026-09-04`, never
//   combined with context_management. It returns the block alone; later
//   requests send it first, in place of the messages it summarizes. Atelier keeps
//   every message on disk and starts each request at the newest such block.

export const THRESHOLD_BETA = 'compact-2026-01-12'
export const ON_DEMAND_BETA = 'compact-2026-09-04'
/** The threshold the API uses when no trigger is set. */
export const DEFAULT_THRESHOLD_TOKENS = 150_000

/** Models with both kinds of compaction (the API's supported-model lists). */
const COMPACTION_MODELS = new Set([
  'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-5-5',
])

export function supportsCompaction(model: string): boolean {
  return COMPACTION_MODELS.has(model)
}

type Block = BetaContentBlock | { type: string }

/** An assistant message holding only a compaction block: an on-demand summary. */
export function isOnDemandSummary(message: BetaMessageParam): boolean {
  if (message.role !== 'assistant' || typeof message.content === 'string') return false
  return message.content.length === 1 && message.content[0]?.type === 'compaction'
}

/** Where the request's history starts: the newest on-demand summary, or the beginning. */
export function historyStart(messages: readonly BetaMessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isOnDemandSummary(message)) return i
  }
  return 0
}

/** The messages a request sends: from the newest on-demand summary on. */
export function requestMessages(messages: BetaMessageParam[]): BetaMessageParam[] {
  const start = historyStart(messages)
  return start === 0 ? messages : messages.slice(start)
}

/** Whether the history carries a signed on-demand block (threshold compaction can't run on such a request). */
export function carriesOnDemandBlock(messages: readonly BetaMessageParam[]): boolean {
  return messages.some(isOnDemandSummary)
}

export interface CompactionParts {
  betas: string[]
  context_management?: { edits: Array<{ type: 'compact_20260112' }> }
  compaction?: { type: 'summarize'; instructions?: string }
}

/**
 * What a request adds for compaction. `manual` asks for an on-demand
 * summary; otherwise a chat with compaction gets the threshold edit, unless
 * its history already starts from an on-demand block.
 */
export function compactionParts(input: { compaction: boolean; messages: readonly BetaMessageParam[]; manual?: boolean }): CompactionParts {
  if (input.manual) return { betas: [ON_DEMAND_BETA], compaction: { type: 'summarize', instructions: SUMMARY_INSTRUCTIONS } }
  const onDemand = carriesOnDemandBlock(input.messages)
  if (!input.compaction) return { betas: onDemand ? [ON_DEMAND_BETA] : [] }
  if (onDemand) return { betas: [ON_DEMAND_BETA] }
  return { betas: [THRESHOLD_BETA], context_management: { edits: [{ type: 'compact_20260112' }] } }
}

/** What an on-demand summary keeps. */
export const SUMMARY_INSTRUCTIONS = [
  'Summarize this conversation so it can continue from the summary alone.',
  'Keep what the user asked for and still wants, decisions made, facts found and where they came from (page titles and URLs), files made or attached and their names, tabs that are open and why, and anything left to do.',
  'Write the summary as text only. Do not call any tools.',
].join(' ')

/** The size of the context a compaction closed: the input of the sampling step before it, or the previous turn's. */
export function replacedTokens(usage: BetaUsage | null | undefined, previousInput: number | null): number | null {
  const iterations = usage?.iterations ?? null
  if (iterations) {
    const at = iterations.findIndex((entry) => entry.type === 'compaction')
    for (let i = at - 1; i >= 0; i--) {
      const entry = iterations[i]
      if (entry && entry.type === 'message') return entry.input_tokens + entry.cache_read_input_tokens + entry.cache_creation_input_tokens + entry.output_tokens
    }
  }
  return previousInput
}

/** Total input of a turn, for the next compaction's replacedTokens. */
export function turnInput(usage: BetaUsage): number {
  return usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}

/**
 * Follows one streamed response for threshold compaction: a compaction
 * block's start emits 'running'; the final message emits 'done' with the
 * summary and the closed context's size, or 'failed' when the block came
 * back without a summary.
 */
export class CompactionWatch {
  readonly #starts = new Map<number, string>()
  readonly #previousInput: number | null

  constructor(previousInput: number | null) {
    this.#previousInput = previousInput
  }

  onEvent(event: BetaRawMessageStreamEvent): AgentEvent | null {
    if (event.type !== 'content_block_start' || (event.content_block as Block).type !== 'compaction') return null
    const id = randomUUID()
    this.#starts.set(event.index, id)
    return { type: 'compaction', id, state: 'running', trigger: 'auto', thresholdTokens: DEFAULT_THRESHOLD_TOKENS }
  }

  finish(message: BetaMessage): AgentEvent[] {
    const out: AgentEvent[] = []
    message.content.forEach((block, index) => {
      if (block.type !== 'compaction') return
      const id = this.#starts.get(index) ?? randomUUID()
      const summary = block.content
      const replaced = replacedTokens(message.usage, this.#previousInput)
      out.push(
        summary
          ? { type: 'compaction', id, state: 'done', trigger: 'auto', summary, thresholdTokens: DEFAULT_THRESHOLD_TOKENS, ...(replaced !== null ? { replacedTokens: replaced } : {}) }
          : { type: 'compaction', id, state: 'failed', trigger: 'auto', thresholdTokens: DEFAULT_THRESHOLD_TOKENS },
      )
    })
    return out
  }
}

/** A manual compaction's outcome from its response: the block to append, or why there is none. */
export function manualOutcome(message: BetaMessage): { ok: true; summary: string } | { ok: false; reason: string } {
  const block = message.content.find((b): b is Extract<BetaContentBlock, { type: 'compaction' }> => b.type === 'compaction')
  if (message.stop_reason === 'compaction' && block?.content) return { ok: true, summary: block.content }
  if (message.stop_reason === 'max_tokens') return { ok: false, reason: 'The summary was cut off before it was finished. Try again.' }
  if (message.stop_reason === 'refusal') return { ok: false, reason: 'Claude declined to summarize this chat.' }
  return { ok: false, reason: 'No summary came back. The chat is unchanged; try again in a moment.' }
}

/** A failed request that a manual compaction can fix: the conversation no longer fits the context window. */
export function isContextTooLong(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /prompt is too long|context (window|length)|too many (input )?tokens|exceeds? the (model'?s )?(maximum )?context/i.test(message)
}
