/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { DELEGATION_LIMITS, type DelegationStatus } from '@shared/agentTools'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { ChatAgentEvent } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import { CompanionFiles } from '../src/main/companionFiles'
import { delegationResult, Delegations, type ChildOutcome, type DelegationHost } from '../src/main/agent/delegation'
import { AgentHost } from '../src/main/agent/host'
import { interruptions } from '../src/main/agent/requests'
import { SiteRulesStore } from '../src/main/agent/sitePolicy'
import { registerAgentClientTools } from '../src/main/agent/tools/agentTools'
import { resetClientToolsForTests, type ClientToolContext } from '../src/main/agent/tools/registry'
import { ChatStore, filterChats } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import { ConnectorStore, SkillStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'

// Delegation (CH-43, delegate_task): limits, the parent's card, the result
// cap, the stop cascade, restart and Continue. The host tests run against a
// scripted stand-in for the Messages API; no request leaves the machine.

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function fakeDelegationHost() {
  const started: Array<{ parent: string; childChatId: string; onStatus(s: DelegationStatus): void; done: { promise: Promise<ChildOutcome>; resolve(o: ChildOutcome): void } }> = []
  const stopped: string[] = []
  const host: DelegationHost = {
    startChild: (parent, _task, onStatus) => {
      const done = deferred<ChildOutcome>()
      const childChatId = `child-${started.length + 1}`
      started.push({ parent, childChatId, onStatus, done })
      return { childChatId, done: done.promise }
    },
    stop: (id) => stopped.push(id),
  }
  return { host, started, stopped }
}

function ctx(chatId = 'parent', signal = new AbortController().signal): ClientToolContext & { events: AgentEvent[] } {
  const events: AgentEvent[] = []
  return { chatId, companionId: 'nova', isPrivate: false, isRoutine: false, signal, emit: (e) => events.push(e), ask: () => Promise.reject(new Error('no')), events }
}

const task = { title: 'Compare hotels', instructions: 'Find three hotels in Lisbon under €150.' }

describe('Delegations', () => {
  it('runs at most three children per parent', async () => {
    const f = fakeDelegationHost()
    const d = new Delegations(f.host)
    const runs = [d.run(task, ctx()), d.run(task, ctx()), d.run(task, ctx())]
    expect(d.running('parent')).toBe(3)
    const fourth = await d.run(task, ctx())
    expect(fourth.isError).toBe(true)
    expect(fourth.content).toMatch(/3 sub-tasks are already running/)
    // Another parent has its own allowance.
    void d.run(task, ctx('other'))
    expect(d.running('other')).toBe(1)
    for (const s of f.started) s.done.resolve({ status: 'done', text: 'ok', error: null })
    await Promise.all(runs)
    expect(d.running('parent')).toBe(0)
  })

  it('keeps the parent card current, upserted by one id', async () => {
    const f = fakeDelegationHost()
    const d = new Delegations(f.host)
    const c = ctx()
    const run = d.run(task, c)
    f.started[0]?.onStatus('needs-input')
    f.started[0]?.onStatus('working')
    f.started[0]?.done.resolve({ status: 'done', text: 'Hotel A, B and C.', error: null })
    expect(await run).toEqual({ content: 'Hotel A, B and C.' })
    const cards = c.events.filter((e): e is Extract<AgentEvent, { type: 'delegation' }> => e.type === 'delegation')
    expect(cards.map((e) => e.status)).toEqual(['working', 'needs-input', 'working', 'done'])
    expect(new Set(cards.map((e) => e.id)).size).toBe(1)
    expect(cards[0]).toMatchObject({ childChatId: 'child-1', title: 'Compare hotels' })
  })

  it('stopping the parent stops its children', async () => {
    const f = fakeDelegationHost()
    const d = new Delegations(f.host)
    const stop = new AbortController()
    const run = d.run(task, ctx('parent', stop.signal))
    stop.abort()
    expect(f.stopped).toEqual(['child-1'])
    f.started[0]?.done.resolve({ status: 'stopped', text: '', error: null })
    expect((await run).isError).toBe(true)
    void d.run(task, ctx())
    d.stopChildren('parent')
    expect(f.stopped).toEqual(['child-1', 'child-2'])
  })

  it('caps the child’s reply at 20k characters and words each ending', () => {
    const long = delegationResult('T', { status: 'done', text: 'x'.repeat(DELEGATION_LIMITS.resultChars + 10), error: null })
    expect(long.content.startsWith('x'.repeat(DELEGATION_LIMITS.resultChars))).toBe(true)
    expect(long.content).toMatch(/was cut/)
    expect(delegationResult('T', { status: 'needs-input', text: 'Which dates?', error: null }).content).toMatch(/stopped to ask the user/)
    expect(delegationResult('T', { status: 'needs-attention', text: '', error: 'No network' })).toMatchObject({ isError: true, content: expect.stringContaining('No network') })
    expect(delegationResult('T', { status: 'stopped', text: '', error: null }).isError).toBe(true)
  })

  it('after a restart, a working card whose child no longer runs reads interrupted', () => {
    const log: AgentEvent[] = [{ type: 'delegation', id: 'd1', childChatId: 'c1', title: 'A', status: 'working' }]
    expect(interruptions(log, () => false)).toEqual([{ type: 'delegation', id: 'd1', childChatId: 'c1', title: 'A', status: 'interrupted' }])
    expect(interruptions(log, () => true)).toEqual([])
  })
})

// ── On the host ──

interface Request {
  model: string
  messages: Array<{ role: string; content: unknown }>
  tools: Array<{ name?: string; type?: string }>
}
interface Turn {
  text?: string
  tools?: Array<{ name: string; input: unknown }>
  gate?: Promise<void>
}

function harness(script: (request: Request, n: number) => Turn) {
  const dir = mkdtempSync(join(tmpdir(), 'apex-deleg-'))
  const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious.', look: DEFAULT_LOOK }]
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const events: ChatAgentEvent[] = []
  const requests: Request[] = []
  const client = {
    beta: {
      messages: {
        stream: (request: Request, { signal }: { signal: AbortSignal }) => {
          requests.push(structuredClone(request))
          const turn = script(request, requests.length)
          const content: unknown[] = []
          if (turn.text) content.push({ type: 'text', text: turn.text, citations: null })
          for (const [i, tool] of (turn.tools ?? []).entries()) content.push({ type: 'tool_use', id: `toolu_${requests.length}_${i}`, name: tool.name, input: tool.input })
          const message = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: request.model, content, stop_reason: turn.tools?.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: null } }
          return {
            async *[Symbol.asyncIterator]() {
              if (turn.gate) {
                await new Promise<void>((resolve, reject) => {
                  if (signal.aborted) reject(new Error('aborted'))
                  signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
                  void turn.gate?.then(resolve)
                })
              }
              if (turn.text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } }
            },
            finalMessage: async () => message,
          }
        },
      },
    },
  }
  const tabs = { find: () => undefined, active: () => null, activeId: () => null, rail: () => null, activate: () => undefined, all: () => [], info: () => null, setAgentControlled: () => undefined, setNeedsInput: () => undefined }
  const host = new AgentHost({
    settings: { get: () => ({ model: 'claude-sonnet-5-5', effort: 'medium', webTools: false, memory: false, confirmConsequentialActions: true }), view: () => ({ hasApiKey: true }), apiKey: () => 'test-key' },
    tabs: tabs as unknown as TabManager,
    bridge: {} as never,
    memory: { execute: () => Promise.resolve('ok') },
    connectors: new ConnectorStore(dir),
    skills: new SkillStore(dir),
    chats,
    companions: new CompanionStore(dir, { presets: () => presets }),
    presets: { personality: () => 'Curious.' },
    client: () => client as never,
    emit: (event: ChatAgentEvent) => events.push(event),
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  } as never)
  const delegations = new Delegations(host.delegationHost())
  host.installAgentTools({
    mode: () => 'standard',
    sites: new SiteRulesStore(join(dir, 'rules.json'), { defaultAccess: () => 'allow' }),
    recordUsage: () => undefined,
    delegations,
    flags: () => ({ delegation: 'on' }),
    project: () => null,
    isRunning: (id) => host.isRunning(id),
  })
  registerAgentClientTools({ delegate: (input, c) => delegations.run(input, c), companionFiles: new CompanionFiles(dir) })
  const eventsOf = (chatId: string): AgentEvent[] => events.filter((e) => e.chatId === chatId).map((e) => e.event)
  return { host, chats, requests, eventsOf }
}

async function until(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const isChild = (r: Request): boolean => JSON.stringify(r.messages[0]).includes('This chat is a sub-task')
const lastUserText = (r: Request | undefined): string => JSON.stringify(r?.messages.at(-1)?.content ?? '')

beforeEach(() => resetClientToolsForTests())

describe('delegate_task on the host', () => {
  it('runs a hidden child with the same companion and model, and hands its reply back to the parent', async () => {
    const h = harness((r) => {
      if (isChild(r)) return { text: 'Hotel A, B and C.' }
      if (lastUserText(r).includes('tool_result')) return { text: 'Here are three hotels.' }
      return { tools: [{ name: 'delegate_task', input: task }] }
    })
    const parent = h.host.create({})
    h.host.send(parent.id, 'Plan Lisbon.')
    await until(() => h.requests.length === 3 && !h.host.isRunning(parent.id), 'parent done')
    const card = h.eventsOf(parent.id).filter((e): e is Extract<AgentEvent, { type: 'delegation' }> => e.type === 'delegation')
    expect(card.at(-1)?.status).toBe('done')
    const child = h.chats.summary(card[0]!.childChatId)
    expect(child).toMatchObject({ parentChatId: parent.id, companionId: h.chats.summary(parent.id)?.companionId, delegationStatus: 'done' })
    // Hidden from chat lists unless asked for.
    expect(filterChats(h.chats.list(), {}, () => '').some((c) => c.id === child?.id)).toBe(false)
    const childRequest = h.requests.find(isChild)
    expect(childRequest?.model).toBe(h.requests[0]?.model)
    // Depth 1: the child never gets delegate_task.
    expect(childRequest?.tools.map((t) => t.name)).not.toContain('delegate_task')
    expect(h.requests[0]?.tools.map((t) => t.name)).toContain('delegate_task')
    expect(lastUserText(h.requests[2])).toContain('Hotel A, B and C.')
  })

  it('stopping the parent stops the child, and Continue resumes the child where it stopped', async () => {
    let release: () => void = () => undefined
    const hold = new Promise<void>((r) => {
      release = r
    })
    let childCalls = 0
    const h = harness((r) => {
      if (isChild(r)) {
        childCalls++
        return childCalls === 1 ? { text: 'partial', gate: hold } : { text: 'Finished the comparison.' }
      }
      if (lastUserText(r).includes('tool_result')) return { text: 'Stopped.' }
      return { tools: [{ name: 'delegate_task', input: task }] }
    })
    const parent = h.host.create({})
    h.host.send(parent.id, 'Plan Lisbon.')
    await until(() => childCalls === 1, 'child started')
    const childId = h.eventsOf(parent.id).find((e): e is Extract<AgentEvent, { type: 'delegation' }> => e.type === 'delegation')!.childChatId
    h.host.stop(parent.id)
    await until(() => !h.host.isRunning(parent.id) && !h.host.isRunning(childId), 'both stopped')
    release()
    await until(() => h.chats.summary(childId)?.delegationStatus === 'stopped', 'child stopped status')
    const cards = h.eventsOf(parent.id).filter((e): e is Extract<AgentEvent, { type: 'delegation' }> => e.type === 'delegation')
    expect(cards.at(-1)?.status).toBe('stopped')

    h.host.continueChat(childId)
    await until(() => childCalls === 2 && !h.host.isRunning(childId), 'child continued')
    const resumed = h.requests.filter(isChild).at(-1)
    expect(lastUserText(resumed)).toContain('Continue where you stopped.')
    await until(() => h.chats.summary(childId)?.delegationStatus === 'done', 'child done')
    expect(h.eventsOf(parent.id).filter((e) => e.type === 'delegation').at(-1)).toMatchObject({ status: 'done', childChatId: childId })
  })
})
