/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Delegation (CH-43's sub-tasks, `delegate_task`): a chat hands a
// self-contained task to a child chat with the same companion, model and
// effort, hidden from chat lists, and waits for its final reply. At most
// three children run per parent, and children never delegate further.
// Stopping the parent stops its children. The parent's log keeps one
// `delegation` card per child, upserted by id as its status changes.
import { randomUUID } from 'node:crypto'
import { DELEGATION_LIMITS, type DelegationStatus } from '@shared/agentTools'
import type { ClientToolContext, ClientToolResult } from './tools/registry'

export interface ChildOutcome {
  status: Extract<DelegationStatus, 'done' | 'needs-input' | 'needs-attention' | 'stopped'>
  /** The child's final reply. */
  text: string
  error: string | null
}

export interface ChildRun {
  childChatId: string
  done: Promise<ChildOutcome>
}

export interface DelegationHost {
  /** Starts the child chat with the instructions as its first message. `onStatus` reports waits while it runs. */
  startChild(parentChatId: string, task: { title: string; instructions: string }, onStatus: (status: DelegationStatus) => void): ChildRun
  stop(chatId: string): void
}

/** The parent's tool result for a finished child. */
export function delegationResult(title: string, outcome: ChildOutcome): ClientToolResult {
  const text = outcome.text.length > DELEGATION_LIMITS.resultChars
    ? `${outcome.text.slice(0, DELEGATION_LIMITS.resultChars)}\n… (the rest of the helper's reply was cut)`
    : outcome.text
  switch (outcome.status) {
    case 'done':
      return { content: text || `The sub-task "${title}" finished without a written reply.` }
    case 'needs-input':
      return { content: `The sub-task "${title}" stopped to ask the user something. Its last reply:\n${text}` }
    case 'needs-attention':
      return { content: `The sub-task "${title}" could not finish: ${outcome.error ?? 'it ran into a problem'}.${text ? `\nIts last reply:\n${text}` : ''}`, isError: true }
    case 'stopped':
      return { content: `The sub-task "${title}" was stopped before it finished.`, isError: true }
  }
}

export class Delegations {
  readonly #host: DelegationHost
  /** Parent chat id to the children running for it. */
  readonly #running = new Map<string, Set<string>>()

  constructor(host: DelegationHost) {
    this.#host = host
  }

  running(parentChatId: string): number {
    return this.#running.get(parentChatId)?.size ?? 0
  }

  /** delegate_task: starts a child, keeps the parent's card current, and waits for the child's reply. */
  async run(task: { title: string; instructions: string }, ctx: ClientToolContext): Promise<ClientToolResult> {
    if (this.running(ctx.chatId) >= DELEGATION_LIMITS.children) {
      return { content: `${DELEGATION_LIMITS.children} sub-tasks are already running in this chat. Wait for one to finish, then delegate again.`, isError: true }
    }
    const id = randomUUID()
    let childChatId = ''
    const card = (status: DelegationStatus): void => {
      if (childChatId) ctx.emit({ type: 'delegation', id, childChatId, title: task.title, status })
    }
    const run = this.#host.startChild(ctx.chatId, task, (status) => card(status))
    childChatId = run.childChatId
    const children = this.#running.get(ctx.chatId) ?? new Set<string>()
    children.add(childChatId)
    this.#running.set(ctx.chatId, children)
    card('working')
    // Stopping the parent stops the child.
    const onAbort = (): void => this.#host.stop(childChatId)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const outcome = await run.done
      card(outcome.status)
      return delegationResult(task.title, outcome)
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
      children.delete(childChatId)
      if (children.size === 0) this.#running.delete(ctx.chatId)
    }
  }

  /** Stops every child of a parent (the parent was stopped or discarded). */
  stopChildren(parentChatId: string): void {
    for (const child of this.#running.get(parentChatId) ?? []) this.#host.stop(child)
  }
}
