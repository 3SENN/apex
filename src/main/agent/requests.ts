/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The request protocol: every decision the agent waits
// on, on either engine. A request event goes into the chat's log, the chat
// shows that it waits on you, and `agent.respond(chatId, requestId, …)`
// resolves it. Stop resolves it as `stopped`; after a restart an unanswered
// request is closed as `interrupted`. Every outcome is logged as
// `request-resolved`, so the cards and the saved history agree.
import type { AgentRequestResponse, RequestOutcome } from '@shared/agentTools'
import type { AgentEvent } from '@shared/ipc'

/** A request the broker can wait on: the approval prompt, or any member with a requestId, or the countdown. */
export type RequestEvent =
  | Extract<AgentEvent, { type: 'approval' }>
  | Extract<AgentEvent, { type: 'auto-approval' }>
  | Exclude<Extract<AgentEvent, { requestId: string }>, { type: 'request-resolved' }>

type RequestType = RequestEvent['type']

/** What the chat shows while a request waits: an approval to give, an answer to type, or a countdown that runs by itself. */
export type WaitingKind = 'approval' | 'input' | 'countdown'

const EXPECTS: Record<RequestType, AgentRequestResponse['kind']> = {
  approval: 'approval',
  'auto-approval': 'auto-approval',
  'site-access': 'site-access',
  'table-write': 'table-write',
  question: 'question',
  'routine-proposal': 'proposal',
  'skill-draft': 'proposal',
  'app-built': 'proposal',
}

const WAITING: Record<RequestType, WaitingKind> = {
  approval: 'approval',
  'auto-approval': 'countdown',
  'site-access': 'approval',
  'table-write': 'approval',
  question: 'input',
  'routine-proposal': 'input',
  'skill-draft': 'input',
  'app-built': 'input',
}

/** Requests that only make sense while a run waits on them; after a restart they are closed as interrupted. */
const LIVE_ONLY: ReadonlySet<RequestType> = new Set<RequestType>(['approval', 'auto-approval', 'site-access', 'table-write', 'question'])

export function requestIdOf(event: AgentEvent): string | null {
  if (event.type === 'request-resolved') return null
  if (event.type === 'approval' || event.type === 'auto-approval') return event.approvalId
  return 'requestId' in event && typeof event.requestId === 'string' ? event.requestId : null
}

export function isRequestEvent(event: AgentEvent): event is RequestEvent {
  return event.type !== 'request-resolved' && requestIdOf(event) !== null
}

/** The logged outcome of an answer. */
export function outcomeOf(response: AgentRequestResponse): RequestOutcome {
  switch (response.kind) {
    case 'approval':
    case 'table-write':
      return response.allowed ? 'allowed' : 'denied'
    case 'auto-approval':
      return response.action === 'stop' ? 'denied' : 'ran'
    case 'site-access':
      return response.choice === 'block' ? 'denied' : 'allowed'
    case 'question': {
      const answered = response.answers?.some((a) => a.answer !== null && (Array.isArray(a.answer) ? a.answer.length > 0 : a.answer.trim() !== '')) ?? false
      return answered ? 'answered' : 'skipped'
    }
    case 'proposal':
      return response.action
  }
}

/** Whether an answer fits the request it names. */
export function answers(event: RequestEvent, response: AgentRequestResponse): boolean {
  return EXPECTS[event.type] === response.kind
}

/** Requests in a log that never got an outcome, oldest first. */
export function unresolved(log: readonly AgentEvent[]): RequestEvent[] {
  const resolved = new Set<string>()
  for (const event of log) {
    if (event.type === 'request-resolved') resolved.add(event.requestId)
    else if (event.type === 'approval-resolved') resolved.add(event.approvalId)
  }
  return log.filter((e): e is RequestEvent => isRequestEvent(e) && !resolved.has(requestIdOf(e) ?? ''))
}

/**
 * What to append to a chat loaded after a restart: each request that waited
 * on a run is closed as interrupted (an approval also gets its approval-resolved event),
 * and a delegation still working is marked interrupted unless its child runs.
 * Proposals stay open: you can still save them.
 */
export function interruptions(log: readonly AgentEvent[], childRunning: (childChatId: string) => boolean = () => false): AgentEvent[] {
  const out: AgentEvent[] = []
  for (const event of unresolved(log)) {
    if (!LIVE_ONLY.has(event.type)) continue
    const requestId = requestIdOf(event) ?? ''
    if (event.type === 'approval') out.push({ type: 'approval-resolved', approvalId: requestId, allowed: false })
    out.push({ type: 'request-resolved', requestId, outcome: 'interrupted' })
  }
  const latest = new Map<string, Extract<AgentEvent, { type: 'delegation' }>>()
  for (const event of log) if (event.type === 'delegation') latest.set(event.id, event)
  for (const d of latest.values()) {
    if (d.status === 'working' && !childRunning(d.childChatId)) out.push({ ...d, status: 'interrupted' })
  }
  return out
}

export class RequestStoppedError extends Error {
  constructor() {
    super('Stopped by the user.')
    this.name = 'RequestStoppedError'
  }
}

export interface BrokerHooks {
  /** Appends to the chat's log and sends it to the surfaces. */
  emit(event: AgentEvent): void
  /** The strongest kind of wait still open (approval over input over countdown), or null when nothing waits. */
  waiting(kind: WaitingKind | null): void
}

interface Pending {
  event: RequestEvent
  finish(outcome: RequestOutcome, response: AgentRequestResponse | null): void
}

export interface AskOptions<R extends AgentRequestResponse> {
  /** Resolves by itself after this long (the countdown), with `onTimeout`. */
  timeoutMs?: number
  onTimeout?: R
  /** Extra events logged with the outcome (the approval-resolved event). */
  resolved?(outcome: RequestOutcome, response: AgentRequestResponse | null): AgentEvent[]
}

/** One chat's open requests. */
export class RequestBroker {
  readonly #hooks: BrokerHooks
  readonly #pending = new Map<string, Pending>()

  constructor(hooks: BrokerHooks) {
    this.#hooks = hooks
  }

  get size(): number {
    return this.#pending.size
  }

  has(requestId: string): boolean {
    return this.#pending.has(requestId)
  }

  /** Logs the request and waits for its answer. Rejects with RequestStoppedError when the signal fires. */
  ask<R extends AgentRequestResponse>(event: RequestEvent, signal: AbortSignal, options: AskOptions<R> = {}): Promise<R> {
    const requestId = requestIdOf(event)
    if (!requestId) return Promise.reject(new Error('A request needs an id.'))
    if (signal.aborted) return Promise.reject(new RequestStoppedError())
    if (this.#pending.has(requestId)) return Promise.reject(new Error('That request is already waiting.'))
    this.#hooks.emit(event)
    return new Promise<R>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null
      const onAbort = (): void => pending.finish('stopped', null)
      const pending: Pending = {
        event,
        finish: (outcome, response) => {
          if (this.#pending.get(requestId) !== pending) return
          this.#pending.delete(requestId)
          if (timer) clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          for (const extra of options.resolved?.(outcome, response) ?? []) this.#hooks.emit(extra)
          this.#hooks.emit({ type: 'request-resolved', requestId, outcome })
          this.#hooks.waiting(this.#strongest())
          if (response) resolve(response as R)
          else reject(new RequestStoppedError())
        },
      }
      this.#pending.set(requestId, pending)
      signal.addEventListener('abort', onAbort, { once: true })
      if (options.timeoutMs !== undefined && options.onTimeout) {
        const fallback = options.onTimeout
        timer = setTimeout(() => pending.finish('ran', fallback), options.timeoutMs)
      }
      this.#hooks.waiting(this.#strongest())
    })
  }

  /** Answers a waiting request. Unknown, already-answered or mismatched answers are ignored (false). */
  respond(requestId: string, response: AgentRequestResponse): boolean {
    const pending = this.#pending.get(requestId)
    if (!pending || !answers(pending.event, response)) return false
    pending.finish(outcomeOf(response), response)
    return true
  }

  /** Stop: every open request resolves as stopped. */
  stopAll(): void {
    for (const pending of [...this.#pending.values()]) pending.finish('stopped', null)
  }

  #strongest(): WaitingKind | null {
    const kinds = new Set([...this.#pending.values()].map((p) => WAITING[p.event.type]))
    if (kinds.has('approval')) return 'approval'
    if (kinds.has('input')) return 'input'
    if (kinds.has('countdown')) return 'countdown'
    return null
  }
}
