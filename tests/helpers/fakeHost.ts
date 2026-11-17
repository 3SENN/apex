/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A stand-in for AgentHost's main-side API, for unit tests: it records
// every call and answers from scripted replies, so no test ever runs a
// model. Each test scripts `complete` and `runBackground` and reads back
// what was started and appended.
import { randomUUID } from 'node:crypto'
import type { ChatStatus } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { AgentHostApi, BackgroundRunInput, CompleteInput, StartChatOptions } from '../../src/main/agent/hostApi'

export interface FakeBackgroundResult {
  ok: boolean
  status: ChatStatus
  /** Events appended to the run's chat as if the model produced them. */
  events?: AgentEvent[]
}

export class FakeHost implements AgentHostApi {
  readonly backgroundRuns: Array<BackgroundRunInput & { chatId: string }> = []
  readonly completions: CompleteInput[] = []
  readonly startedChats: Array<{ chatId: string; text: string; options: StartChatOptions | undefined }> = []
  /** Every appended event, by chat id, in order. */
  readonly events = new Map<string, AgentEvent[]>()

  /** Replies `complete` returns in order; the last one repeats. */
  completeReplies: string[] = ['']
  /** What `runBackground` resolves with; the default finishes fine. */
  backgroundResult: FakeBackgroundResult = { ok: true, status: 'finished' }
  /** Make the next calls reject with this error, to test failure paths. */
  failWith: Error | null = null

  async runBackground(input: BackgroundRunInput): Promise<{ ok: boolean; chatId: string | null; status: ChatStatus }> {
    if (this.failWith) throw this.failWith
    const chatId = input.appendTo ?? randomUUID()
    this.backgroundRuns.push({ ...input, chatId })
    for (const event of this.backgroundResult.events ?? []) this.appendEvent(chatId, event)
    return { ok: this.backgroundResult.ok, chatId, status: this.backgroundResult.status }
  }

  async complete(input: CompleteInput): Promise<string> {
    if (this.failWith) throw this.failWith
    this.completions.push(input)
    const index = Math.min(this.completions.length - 1, this.completeReplies.length - 1)
    return this.completeReplies[index] ?? ''
  }

  startChat(text: string, options?: StartChatOptions): string {
    if (this.failWith) throw this.failWith
    const chatId = randomUUID()
    this.startedChats.push({ chatId, text, options })
    return chatId
  }

  appendEvent(chatId: string, event: AgentEvent): void {
    const list = this.events.get(chatId) ?? []
    list.push(event)
    this.events.set(chatId, list)
  }

  /** The events appended to one chat. */
  log(chatId: string): AgentEvent[] {
    return this.events.get(chatId) ?? []
  }
}
