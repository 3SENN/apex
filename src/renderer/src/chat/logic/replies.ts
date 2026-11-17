/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatFeedback, MessageDetails, TurnUsage } from '@shared/chats'
import type { LogItem } from '../../agentLog'
import type { Effort } from '@shared/ipc'

// Groups a chat's log into what the view draws: your messages, and replies.
// A reply is everything the companion did after one message of yours (text
// turns, tool steps, approvals, notices) and gets one footer.

export type UserItem = Extract<LogItem, { kind: 'user' }>
export type AssistantItem = Extract<LogItem, { kind: 'assistant' }>

export type ChatBlock =
  | { kind: 'user'; item: UserItem; latest: boolean }
  | {
      kind: 'reply'
      key: string
      items: LogItem[]
      /** Text and thinking turns, in order. */
      turnIds: string[]
      /** The turn ratings and retry attach to: the last one that wrote text, else the last turn. */
      anchorTurnId: string | null
      /** The message this replies to; null for output before any message (old logs). */
      userId: string | null
      /** The reply's text as Markdown, turns separated by a blank line. */
      markdown: string
      last: boolean
    }

export function chatBlocks(items: readonly LogItem[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  let reply: Extract<ChatBlock, { kind: 'reply' }> | null = null
  let lastUser = -1
  for (const item of items) {
    if (item.kind === 'user') {
      reply = null
      lastUser = blocks.length
      blocks.push({ kind: 'user', item, latest: false })
      continue
    }
    if (!reply) {
      const before = blocks[blocks.length - 1]
      reply = { kind: 'reply', key: `reply:${item.kind}:${item.id}`, items: [], turnIds: [], anchorTurnId: null, userId: before?.kind === 'user' ? before.item.id : null, markdown: '', last: false }
      blocks.push(reply)
    }
    reply.items.push(item)
    if (item.kind === 'assistant') {
      reply.turnIds.push(item.id)
      if (item.text.trim()) {
        reply.anchorTurnId = item.id
        reply.markdown = reply.markdown ? `${reply.markdown}\n\n${item.text.trim()}` : item.text.trim()
      } else if (!reply.markdown) {
        reply.anchorTurnId = item.id
      }
    }
  }
  const latest = blocks[lastUser]
  if (latest?.kind === 'user') latest.latest = true
  const tail = blocks[blocks.length - 1]
  if (tail?.kind === 'reply') tail.last = true
  return blocks
}

/** The newest message you sent, for ↑ in an empty composer. */
export function latestUserMessage(items: readonly LogItem[]): UserItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind === 'user') return item
  }
  return null
}

/** True when cutting at this message would discard replies or later messages. */
export function cutDiscards(items: readonly LogItem[], userId: string): boolean {
  const index = items.findIndex((item) => item.kind === 'user' && item.id === userId)
  return index !== -1 && index < items.length - 1
}

export interface ReplyDetails {
  /** When the last turn finished. */
  at: number
  model: string
  /** Every model that answered, when a fallback changed it partway. */
  models: string[]
  usage: TurnUsage
  memoryPaths: string[]
  /** Turns without saved details (chats from before Apex kept them). */
  missing: number
  /** DC-15: the effort the reply ran at, when a quick decision picked it for this message. */
  effort?: Effort
}

/** Sums the details of a reply's turns; null when none were saved. */
export function replyDetails(turnIds: readonly string[], details: Readonly<Record<string, MessageDetails>>): ReplyDetails | null {
  const found = turnIds.flatMap((id) => (details[id] ? [details[id]] : []))
  const last = found[found.length - 1]
  if (!last) return null
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const d of found) {
    usage.inputTokens += d.usage.inputTokens
    usage.outputTokens += d.usage.outputTokens
    usage.cacheReadTokens += d.usage.cacheReadTokens
    usage.cacheWriteTokens += d.usage.cacheWriteTokens
  }
  return {
    at: Math.max(...found.map((d) => d.at)),
    model: last.model,
    models: [...new Set(found.map((d) => d.model))],
    usage,
    memoryPaths: [...new Set(found.flatMap((d) => d.memoryPaths))],
    missing: turnIds.length - found.length,
    ...(last.effort ? { effort: last.effort } : {}),
  }
}

/** The rating shown on a reply: the one stored on its anchor turn, else on any of its turns. */
export function replyFeedback(turnIds: readonly string[], anchor: string | null, feedback: Readonly<Record<string, ChatFeedback>>): ChatFeedback | null {
  if (anchor && feedback[anchor]) return feedback[anchor]
  for (const id of turnIds) if (feedback[id]) return feedback[id]
  return null
}
