/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTO_APPROVAL_MS } from '@shared/agentTools'
import type { AgentEvent } from '@shared/ipc'
import { interruptions, outcomeOf, RequestBroker, RequestStoppedError, unresolved, type WaitingKind } from '../src/main/agent/requests'
import { SessionAgentTools, type AgentToolsRuntime, type SessionAgentToolsHost } from '../src/main/agent/sessionAgentTools'
import { SiteRulesStore } from '../src/main/agent/sitePolicy'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The request protocol: ask, answer, stop, the countdown, and closing
// requests a restart cut off so the saved history stays valid.

function broker() {
  const log: AgentEvent[] = []
  const waits: Array<WaitingKind | null> = []
  return { log, waits, broker: new RequestBroker({ emit: (e) => log.push(e), waiting: (k) => waits.push(k) }) }
}

const question = (requestId: string): Extract<AgentEvent, { type: 'question' }> => ({ type: 'question', requestId, questions: [{ id: 'q', prompt: 'Which?' }] })

afterEach(() => {
  vi.useRealTimers()
})

describe('RequestBroker', () => {
  it('logs the request, marks the chat as waiting, and resolves through respond', async () => {
    const { log, waits, broker: b } = broker()
    const answer = b.ask(question('r1'), new AbortController().signal)
    expect(log).toEqual([question('r1')])
    expect(waits.at(-1)).toBe('input')
    expect(b.respond('r1', { kind: 'question', answers: [{ id: 'q', answer: 'A' }] })).toBe(true)
    await expect(answer).resolves.toEqual({ kind: 'question', answers: [{ id: 'q', answer: 'A' }] })
    expect(log.at(-1)).toEqual({ type: 'request-resolved', requestId: 'r1', outcome: 'answered' })
    expect(waits.at(-1)).toBeNull()
  })

  it('ignores unknown, already-answered and mismatched answers', async () => {
    const { broker: b } = broker()
    const answer = b.ask(question('r1'), new AbortController().signal)
    expect(b.respond('nope', { kind: 'question', answers: null })).toBe(false)
    expect(b.respond('r1', { kind: 'approval', allowed: true, scope: 'once' })).toBe(false)
    expect(b.respond('r1', { kind: 'question', answers: null })).toBe(true)
    expect(b.respond('r1', { kind: 'question', answers: null })).toBe(false)
    await expect(answer).resolves.toEqual({ kind: 'question', answers: null })
  })

  it('Stop resolves every open request as stopped', async () => {
    const { log, broker: b } = broker()
    const stop = new AbortController()
    const one = b.ask(question('r1'), stop.signal)
    const two = b.ask({ type: 'site-access', requestId: 'r2', origin: 'https://a.example', action: 'click' }, stop.signal)
    stop.abort()
    await expect(one).rejects.toBeInstanceOf(RequestStoppedError)
    await expect(two).rejects.toBeInstanceOf(RequestStoppedError)
    expect(log.filter((e) => e.type === 'request-resolved')).toEqual([
      { type: 'request-resolved', requestId: 'r1', outcome: 'stopped' },
      { type: 'request-resolved', requestId: 'r2', outcome: 'stopped' },
    ])
    expect(b.size).toBe(0)
    // An aborted signal refuses a new request outright.
    await expect(b.ask(question('r3'), stop.signal)).rejects.toBeInstanceOf(RequestStoppedError)
  })

  it('reports the strongest wait: an approval over a question over a countdown', () => {
    const { waits, broker: b } = broker()
    const signal = new AbortController().signal
    void b.ask({ type: 'auto-approval', approvalId: 'a1', description: 'x', origin: 'https://a.example', rule: 'site', runsAt: 0 }, signal).catch(() => undefined)
    expect(waits.at(-1)).toBe('countdown')
    void b.ask(question('q1'), signal).catch(() => undefined)
    expect(waits.at(-1)).toBe('input')
    void b.ask({ type: 'approval', approvalId: 'p1', description: 'Buy', origin: 'https://a.example' }, signal).catch(() => undefined)
    expect(waits.at(-1)).toBe('approval')
    b.stopAll()
    expect(waits.at(-1)).toBeNull()
  })

  it('maps each answer to its logged outcome', () => {
    expect(outcomeOf({ kind: 'approval', allowed: true, scope: 'chat' })).toBe('allowed')
    expect(outcomeOf({ kind: 'approval', allowed: false, scope: 'once' })).toBe('denied')
    expect(outcomeOf({ kind: 'auto-approval', action: 'stop' })).toBe('denied')
    expect(outcomeOf({ kind: 'auto-approval', action: 'run-now' })).toBe('ran')
    expect(outcomeOf({ kind: 'site-access', choice: 'block' })).toBe('denied')
    expect(outcomeOf({ kind: 'site-access', choice: 'chat' })).toBe('allowed')
    expect(outcomeOf({ kind: 'question', answers: [{ id: 'a', answer: [] }, { id: 'b', answer: '' }] })).toBe('skipped')
    expect(outcomeOf({ kind: 'question', answers: [{ id: 'a', answer: ['x'] }] })).toBe('answered')
    expect(outcomeOf({ kind: 'proposal', action: 'saved', savedId: 'r' })).toBe('saved')
  })
})

describe('after a restart', () => {
  it('closes live requests as interrupted, keeps proposals open, and marks working delegations', () => {
    const log: AgentEvent[] = [
      { type: 'approval', approvalId: 'p1', description: 'Buy', origin: 'https://shop.example' },
      question('q1'),
      question('q2'),
      { type: 'request-resolved', requestId: 'q2', outcome: 'answered' },
      { type: 'routine-proposal', requestId: 'rp1', draft: {} as never },
      { type: 'delegation', id: 'd1', childChatId: 'c1', title: 'A', status: 'working' },
      { type: 'delegation', id: 'd2', childChatId: 'c2', title: 'B', status: 'working' },
      { type: 'delegation', id: 'd3', childChatId: 'c3', title: 'C', status: 'done' },
    ]
    expect(unresolved(log).map((e) => e.type)).toEqual(['approval', 'question', 'routine-proposal'])
    expect(interruptions(log, (child) => child === 'c2')).toEqual([
      { type: 'approval-resolved', approvalId: 'p1', allowed: false },
      { type: 'request-resolved', requestId: 'p1', outcome: 'interrupted' },
      { type: 'request-resolved', requestId: 'q1', outcome: 'interrupted' },
      { type: 'delegation', id: 'd1', childChatId: 'c1', title: 'A', status: 'interrupted' },
    ])
  })

  it('a saved chat appends the interruptions once and saves', () => {
    const log: AgentEvent[] = [question('q1')]
    let saves = 0
    const host: SessionAgentToolsHost = {
      chatId: 'chat-1',
      companionId: () => 'nova',
      companionName: () => 'Nova',
      content: () => ({ log, capabilities: {}, grants: [] }) as never,
      emit: () => undefined,
      waiting: () => undefined,
      persist: () => {
        saves++
      },
      actWithoutAsking: () => false,
      confirmConsequential: () => true,
    }
    const d = new SessionAgentTools(host, () => undefined, {}, false)
    d.closeInterrupted()
    d.closeInterrupted()
    expect(log.at(-1)).toEqual({ type: 'request-resolved', requestId: 'q1', outcome: 'interrupted' })
    expect(log).toHaveLength(2)
    expect(saves).toBe(1)
  })
})

describe('the auto-approval countdown (CH-42)', () => {
  function session(rule: 'site' | 'chat') {
    const log: AgentEvent[] = []
    const sites = new SiteRulesStore(join(mkdtempSync(join(tmpdir(), 'atelier-cd-')), 'rules.json'), { defaultAccess: () => 'allow' })
    if (rule === 'site') sites.allowAction('https://shop.example', 'purchase')
    const grants = rule === 'chat' ? [{ origin: 'https://shop.example', action: 'purchase' as const, at: 1 }] : []
    const host: SessionAgentToolsHost = {
      chatId: 'chat-1',
      companionId: () => 'nova',
      companionName: () => 'Nova',
      content: () => ({ log, capabilities: {}, grants }) as never,
      emit: (e) => log.push(e),
      waiting: () => undefined,
      persist: () => undefined,
      actWithoutAsking: () => false,
      confirmConsequential: () => true,
    }
    const runtime = { mode: () => 'standard', sites, recordUsage: () => undefined, flags: () => ({}), project: () => null, isRunning: () => false } as unknown as AgentToolsRuntime
    const d = new SessionAgentTools(host, () => runtime, {}, false)
    const request = { member: 'left_click', guard: { reason: 'buy this', action: 'purchase' as const, alwaysAsk: false }, url: 'https://shop.example/cart', label: 'Click Buy' }
    const countdown = () => log.find((e): e is Extract<AgentEvent, { type: 'auto-approval' }> => e.type === 'auto-approval')
    return { d, log, request, countdown }
  }

  it('runs by itself after 8 seconds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const { d, log, request, countdown } = session('site')
    let done = false
    const run = d.approve(request, new AbortController().signal).then(() => {
      done = true
    })
    expect(countdown()).toMatchObject({ rule: 'site', origin: 'https://shop.example', runsAt: 1_000_000 + AUTO_APPROVAL_MS })
    await vi.advanceTimersByTimeAsync(AUTO_APPROVAL_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await run
    expect(done).toBe(true)
    expect(log.at(-1)).toEqual({ type: 'request-resolved', requestId: countdown()?.approvalId, outcome: 'ran' })
  })

  it('run-now proceeds at once', async () => {
    vi.useFakeTimers()
    const { d, request, countdown } = session('chat')
    const run = d.approve(request, new AbortController().signal)
    expect(countdown()?.rule).toBe('chat')
    d.respond(countdown()!.approvalId, { kind: 'auto-approval', action: 'run-now' })
    await expect(run).resolves.toBeUndefined()
  })

  it('stop denies it with "You stopped this action."', async () => {
    vi.useFakeTimers()
    const { d, log, request, countdown } = session('site')
    const run = d.approve(request, new AbortController().signal)
    d.respond(countdown()!.approvalId, { kind: 'auto-approval', action: 'stop' })
    await expect(run).rejects.toThrow('You stopped this action.')
    expect(log.at(-1)).toMatchObject({ type: 'request-resolved', outcome: 'denied' })
    // Nothing runs later, either.
    await vi.advanceTimersByTimeAsync(AUTO_APPROVAL_MS * 2)
    expect(log.filter((e) => e.type === 'request-resolved')).toHaveLength(1)
  })
})
