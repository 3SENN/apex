/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatSummary } from '@shared/chats'
import type { AgentEvent, AgentStatus } from '@shared/ipc'
import type { ChatPreview } from '@shared/services/chat'

// The chat preview, for the hover cards on chat rows and chat tabs: the
// kind of chat, your latest request and where it came from, a reply snippet,
// progress, and what waits on you.

const SNIPPET_MAX = 160
const REQUEST_MAX = 160
const PENDING_SHOWN = 3

export interface PreviewInput {
  summary: ChatSummary
  log: readonly AgentEvent[]
  status: AgentStatus
  /** Hand-offs waiting on you (the agent's challenge tabs), by label. */
  handoffs?: readonly string[]
  nextRunAt?: number | null
}

/** Markdown down to plain words, for a one-line snippet. */
export function plainSnippet(text: string, max = SNIPPET_MAX): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

export function chatPreview(input: PreviewInput): ChatPreview {
  const { summary, log, status } = input
  let lastRequest: ChatPreview['lastRequest'] = null
  let reply = ''
  let lastUserAt = -1
  for (let i = log.length - 1; i >= 0; i--) {
    const event = log[i]
    if (event?.type === 'user-message') {
      lastUserAt = i
      lastRequest = { text: plainSnippet(event.text, REQUEST_MAX), source: event.source ?? (summary.routineId && i === firstUserIndex(log) ? 'routine' : 'you') }
      break
    }
  }
  // The newest reply text after that request (the latest text turn).
  for (let i = log.length - 1; i > lastUserAt; i--) {
    const event = log[i]
    if (event?.type === 'text-delta' && event.text.trim()) {
      reply = event.text
      break
    }
  }

  const pending: ChatPreview['pending'] = []
  const resolved = new Set(log.flatMap((e) => (e.type === 'approval-resolved' ? [e.approvalId] : [])))
  for (const event of log) {
    if (event.type === 'approval' && !resolved.has(event.approvalId) && status === 'awaiting-approval') pending.push({ kind: 'approval', label: event.description })
  }
  for (const label of input.handoffs ?? []) pending.push({ kind: 'handoff', label })
  if (summary.needsInput && status === 'idle' && reply && /\?\s*$/.test(plainSnippet(reply, 10_000))) {
    pending.push({ kind: 'question', label: lastQuestion(reply) })
  }

  let progress: ChatPreview['progress'] = 'idle'
  if (status === 'awaiting-approval' || pending.length > 0) progress = 'needs-you'
  else if (status === 'running') progress = 'working'
  else if (summary.status === 'error') progress = 'error'
  else if (summary.needsInput) progress = 'needs-you'
  else if (summary.status === 'finished') progress = 'done'

  return {
    kind: summary.parentChatId ? 'agent-task' : summary.routineId ? 'routine-run' : 'chat',
    lastRequest,
    replySnippet: reply ? plainSnippet(reply) || null : null,
    progress,
    pending: pending.slice(0, PENDING_SHOWN),
    pendingCount: pending.length,
    nextRunAt: input.nextRunAt ?? null,
  }
}

function firstUserIndex(log: readonly AgentEvent[]): number {
  return log.findIndex((e) => e.type === 'user-message')
}

/** The reply's closing question, as one line. */
export function lastQuestion(text: string): string {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean)
  return plainSnippet(lines.at(-1) ?? '', SNIPPET_MAX)
}
