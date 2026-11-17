/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { QueuedMessage } from '@shared/chats'
import { activityKey } from '@shared/agentControl'
import type { MessageKey, MessageVars } from '@shared/i18n/core'
import type { AgentStatus, ToolKind } from '@shared/ipc'
import type { AgentLog, LogItem } from '../../agentLog'
import { stepKind, type ToolItem } from './work'

// CH-20: what the chat is doing, in plain words, for the header's status and
// the line above the composer. Tool events carry a kind; steps from
// older logs are read from their labels. CH-15 and CH-19's small rules live
// here too: queue badges and step timings.

export interface ActivityStatus {
  key: MessageKey
  vars?: MessageVars
  tone: 'working' | 'needs-input' | 'paused'
}

/** A step's kind: the event's own, or read from the label for older logs. */
export function toolKindOf(item: ToolItem): ToolKind {
  if (item.step?.kind) return item.step.kind
  if (item.step?.connector) return 'connector'
  const label = item.label
  switch (stepKind(label)) {
    case 'page':
      return /^Find\b/.test(label) ? 'find' : /^Open\b/.test(label) ? 'navigate' : 'read-page'
    case 'search':
      return 'web-search'
    case 'memory':
      return 'memory'
    case 'tabs':
      return 'tabs'
    case 'act':
      if (/^(Type|Fill)\b/.test(label)) return 'type'
      if (/^(Take a screenshot|Zoom)\b/.test(label)) return 'screenshot'
      if (/^(Go back|Go forward|Reload)\b/.test(label)) return 'navigate'
      return 'click'
    default:
      return 'other'
  }
}

/** The items since your latest message: the run the status talks about. */
function currentRun(items: readonly LogItem[]): readonly LogItem[] {
  for (let i = items.length - 1; i >= 0; i--) if (items[i]?.kind === 'user') return items.slice(i + 1)
  return items
}

export interface StatusInput {
  log: AgentLog
  name: string
  paused?: boolean
  /** Hand-offs (a check to solve, a tab you took over) waiting in the tray. */
  handoffs?: number
}

/** The plain-word status, or null while the chat is idle. */
export function activityStatus({ log, name, paused = false, handoffs = 0 }: StatusInput): ActivityStatus | null {
  const status: AgentStatus = log.status
  if (status === 'idle') return null
  if (log.interrupting) return { key: 'chat.status.interrupting', tone: 'working' }
  if (status === 'awaiting-approval') {
    const run = currentRun(log.items)
    const question = run.some((i) => i.kind === 'question' && i.outcome === null)
    return { key: question ? 'chat.status.question' : 'chat.status.approval', tone: 'needs-input' }
  }
  if (handoffs > 0) return { key: 'chat.status.handoff', tone: 'needs-input' }
  if (paused) return { key: 'chat.status.paused', tone: 'paused' }
  const run = currentRun(log.items)
  for (let i = run.length - 1; i >= 0; i--) {
    const item = run[i]
    if (!item) continue
    if (item.kind === 'tool') {
      if (item.state !== 'running') break
      const kind = toolKindOf(item)
      const key = activityKey(kind)
      if (key === 'atWork.activity.connector') return { key, vars: { name: item.step?.connector?.name ?? name }, tone: 'working' }
      if (key === 'atWork.activity.working') return { key: 'chat.status.working', vars: { name }, tone: 'working' }
      return { key, tone: 'working' }
    }
    if (item.kind === 'assistant') {
      if (item.text.trim()) return { key: 'chat.status.writing', tone: 'working' }
      if (item.thinking.trim()) return { key: 'chat.status.thinking', tone: 'working' }
      break
    }
  }
  return { key: 'chat.status.working', vars: { name }, tone: 'working' }
}

// ---- CH-15: the queue ----

export type QueueBadge = 'failed' | 'offline' | 'routine' | 'voice' | 'selection'

/** The marks a queued message carries, most important first. */
export function queueBadges(item: QueuedMessage): QueueBadge[] {
  const out: QueueBadge[] = []
  if (item.failed) out.push('failed')
  if (item.offline) out.push('offline')
  if (item.source) out.push(item.source)
  return out
}

/** Whether a message open in the editor left the queue meanwhile (it went out, or was removed elsewhere). */
export function leftQueue(queued: readonly QueuedMessage[], editingId: string | null): boolean {
  return editingId !== null && !queued.some((q) => q.id === editingId)
}

/** The queue holds at a failed message until it is retried or removed. */
export function queueHeld(queued: readonly QueuedMessage[]): boolean {
  return queued.some((q) => q.failed)
}

// ---- CH-19: step timings ----

/** How long a step ran, or has run so far; null without a start time. */
export function stepElapsed(item: ToolItem, now: number): number | null {
  const start = item.step?.startedAt
  if (start === undefined) return null
  const end = item.state === 'running' ? now : (item.step?.endedAt ?? null)
  return end === null ? null : Math.max(0, end - start)
}

/** The step running now in a fold: the newest one still running. */
export function currentStep(steps: readonly ToolItem[]): ToolItem | null {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]?.state === 'running') return steps[i] ?? null
  return null
}

/** The connectors a fold used, once each, in order. */
export function foldConnectors(steps: readonly ToolItem[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, { id: string; name: string }>()
  for (const s of steps) {
    const c = s.step?.connector
    if (c && !seen.has(c.id)) seen.set(c.id, c)
  }
  return [...seen.values()]
}
