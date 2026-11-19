/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ChatAgentEvent, MessageDetails } from '@shared/chats'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { DecisionAnswer, DecisionRequest, DecisionResult, DecisionUse } from '@shared/decisions'
import type { EngineId } from '@shared/engine'
import type { Effort } from '@shared/ipc'
import { AgentHost } from '../src/main/agent/host'
import { systemPrompt } from '../src/main/agent/prompt'
import { buildRequest } from '../src/main/agent/session'
import { smokeRichChat } from '../src/main/agent/smokeClientRichChat'
import { registerClientTool, clientTool } from '../src/main/agent/tools/registry'
import { PER_MESSAGE_EFFORT_BETA, decideEffort, effortInEffect, lastReplyText, markEffort, marksBefore, perMessageEffort, rankedOwnSkills, withEffortMarks } from '../src/main/agent/turnDecisions'
import { ChatStore, effortMarksOf, type ChatCapabilities, type EffortMark } from '../src/main/chats'
import { CompanionStore } from '../src/main/companions'
import { RULES_ONLY, setDecider, type Decider } from '../src/main/decisions/service'
import type { AgentBackend, BackendResult, BackendTurn } from '../src/main/engines/backend'
import { ClaudeCodeBackend } from '../src/engines/claude-code/main/claudeCode'
import type { ClaudeProcess, ProcessExit, SpawnSpec } from '../src/engines/claude-code/main/process'
import { effortLine, type BridgeEvent, type LineBlock } from '../src/engines/claude-code/main/streamJson'
import { createSmokeClient } from '../src/main/smokeClient'
import { ConnectorStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'

// DC-15 (docs/decisions.md) on Claude Code: the effort each message runs at,
// handed to the backend and set in the CLI with apply_flag_settings. The
// engine-neutral part is tests/decisionsSetup.test.ts.

const root = mkdtempSync(join(tmpdir(), 'atelier-dc-setup-'))

// ---- a decider whose model answers per use ----

type Answer = (request: DecisionRequest) => DecisionResult | Promise<DecisionResult>

function fakeDecider(answers: Partial<Record<DecisionUse, Answer>>): Decider & { asked: DecisionUse[] } {
  const asked: DecisionUse[] = []
  return {
    asked,
    decide: async (call) => {
      const answer = answers[call.use]
      if (call.private || !answer) return call.rule
      asked.push(call.use)
      const rule = await call.rule
      return call.read(await answer(call.request()), rule) ?? rule
    },
    active: (use) => use in answers,
    ready: () => true,
    paused: () => false,
    ask: () => Promise.reject(new Error('not used')),
    model: () => Promise.reject(new Error('not used')),
  }
}

const result = (answers: Record<string, DecisionAnswer>): DecisionResult => ({
  answers,
  model: 'clef-flash',
  source: 'model',
  ms: 90,
  inputTokens: 40,
})
const level = (n: number, p = 0.9): DecisionResult =>
  result({
    effort: {
      type: 'score',
      score: n,
      confidence: p,
      probabilities: {
        0: n === 0 ? p : (1 - p) / 2,
        1: n === 1 ? p : (1 - p) / 2,
        2: n === 2 ? p : (1 - p) / 2,
      },
    },
  })
/** Skill questions answered by name: yes for `fit`, no for `misfit`, unsure otherwise. */
const skillAnswers =
  (fit: string[], misfit: string[] = []): Answer =>
  (request) =>
    result(
      Object.fromEntries(
        Object.entries(request.questions).map(([key, q]) => {
          const name = /“\/([^”]+)”/.exec(q.instructions)?.[1] ?? ''
          return [
            key,
            {
              type: 'noul' as const,
              noul: fit.includes(name) ? 0.95 : misfit.includes(name) ? 0.05 : 0.5,
            },
          ]
        }),
      ),
    )

afterEach(() => {
  setDecider(null)
  vi.useRealTimers()
})

// ---- an AgentHost on the smoke stand-in (API key) or a fake Claude Code backend ----

const presets: CompanionPreset[] = [
  {
    id: 'nova',
    name: 'Nova',
    tagline: '',
    personality: 'Curious.',
    look: DEFAULT_LOOK,
  },
]
type SkillRow = { id: string; name: string; description: string }

function harness(engine: EngineId, options: { skills?: SkillRow[]; model?: string } = {}) {
  const dir = mkdtempSync(join(root, `host-${engine}-`))
  const chats = new ChatStore(dir, 'pip')
  const events: ChatAgentEvent[] = []
  const smoke = createSmokeClient()
  const turns: BackendTurn[] = []
  const backend: AgentBackend = {
    engine: 'claude-code',
    run: async (turn): Promise<BackendResult> => {
      turns.push(turn)
      turn.details({
        turnId: `cc-${turns.length}`,
        at: 1,
        model: turn.capabilities.model,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        stopReason: 'end_turn',
        memoryPaths: [],
        engine: 'claude-code',
      })
      return { text: 'Done on Claude Code.', paused: false, error: null }
    },
    reset: () => undefined,
    discard: () => undefined,
  }
  const tabs = {
    find: () => undefined,
    active: () => null,
    activeId: () => null,
    rail: () => null,
    activate: () => undefined,
    all: () => [],
    info: () => ({ title: '', url: '' }),
    contentBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    setAgentControlled: () => undefined,
    setNeedsInput: () => undefined,
  } as unknown as TabManager
  const own = options.skills ?? []
  const host = new AgentHost({
    settings: {
      get: () => ({
        model: options.model ?? 'claude-opus-5-5',
        effort: 'medium',
        webTools: false,
        memory: false,
        confirmConsequentialActions: true,
        engine,
        documents: false,
      }),
      view: () => ({ hasApiKey: engine === 'api-key' }),
      apiKey: () => (engine === 'api-key' ? 'sk-test' : null),
    },
    tabs,
    bridge: {} as never,
    memory: { execute: async () => 'ok' },
    connectors: new ConnectorStore(dir),
    skills: {
      resolve: () => undefined,
      markUsed: () => undefined,
      ownedBy: () =>
        own.map((s) => ({
          ...s,
          instructions: 'Do it.',
          updatedAt: 0,
          owner: 'pip',
          lastUsedAt: null,
        })),
    } as never,
    chats,
    companions: new CompanionStore(dir, { presets: () => presets }),
    presets: { personality: () => undefined },
    client: smoke.client,
    backends: { 'claude-code': backend },
    emit: (event) => events.push(event),
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  })
  const idle = (id: string) => until(() => !host.isRunning(id))
  return { host, chats, turns, idle, events }
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('Timed out')
}

type Sent = {
  role: string
  content?: unknown
  output_config?: { effort?: Effort } | null
}
const lastOutput = (): unknown => (smokeRichChat.lastRequest as { output_config?: unknown } | null)?.output_config
const sentMessages = (): Sent[] => (smokeRichChat.lastRequest?.messages ?? []) as unknown as Sent[]
const effortMessages = (messages: readonly Sent[]): Array<{ after: number; effort: Effort | undefined }> => messages.flatMap((m, i) => (m.role === 'system' ? [{ after: i - 1, effort: m.output_config?.effort ?? undefined }] : []))
const detailsOf = (chats: ChatStore, id: string): MessageDetails[] => Object.values(chats.load(id).details)

describe('DC-15 effort per message: Claude Code', () => {
  it('hands the turn its effort and records it in the turn’s details', async () => {
    setDecider(fakeDecider({ effort: () => level(0) }))
    const t = harness('claude-code')
    const id = t.host.start('thanks!')
    await t.idle(id)
    expect(t.turns[0]?.effort).toBe('low')
    expect(t.chats.load(id).details['cc-1']?.effort).toBe('low')
  })

  it('off: the turn carries no effort of its own', async () => {
    setDecider(RULES_ONLY)
    const t = harness('claude-code')
    const id = t.host.start('thanks!')
    await t.idle(id)
    expect(t.turns[0] && 'effort' in t.turns[0]).toBe(false)
    expect(t.chats.load(id).details['cc-1']?.effort).toBeUndefined()
  })
})

// The bridge: apply_flag_settings before the message, the chat's effort set back after, a refusal stops it.
class FakeProcess extends EventEmitter<{
  event: [BridgeEvent]
  exit: [ProcessExit]
}> {
  readonly lines: string[] = []
  readonly exited = new Promise<ProcessExit>(() => undefined)
  constructor(readonly spec: SpawnSpec) {
    super()
  }
  get alive(): boolean {
    return true
  }
  get pid(): number {
    return 4242
  }
  send(blocks: readonly LineBlock[]): boolean {
    this.lines.push(`send:${blocks.map((b) => ('text' in b ? b.text : b.type)).join('')}`)
    return true
  }
  command(text: string): boolean {
    this.lines.push(`command:${text}`)
    return true
  }
  interrupt(): boolean {
    return true
  }
  setEffort(id: string, effort: Effort): boolean {
    this.lines.push(`effort:${effort}:${id}`)
    return true
  }
  stop(): Promise<ProcessExit> {
    return Promise.resolve({
      code: 0,
      signal: null,
      stderr: '',
      expected: true,
    })
  }
  push(...events: BridgeEvent[]): void {
    for (const event of events) this.emit('event', event)
  }
}

describe('DC-15 effort per message: the Claude Code bridge', () => {
  const done: BridgeEvent = {
    kind: 'result',
    ok: true,
    subtype: 'success',
    text: 'ok',
    sessionId: null,
    costUsd: null,
    usage: null,
    numTurns: 1,
    errors: [],
  }

  function bridge() {
    const procs: FakeProcess[] = []
    const backend = new ClaudeCodeBackend({
      cli: async () => ({ path: '/fake/bin/claude', source: 'override' }),
      env: async () => ({ HOME: root }),
      folder: (id) => join(root, 'companions', id),
      configDir: join(root, 'mcp'),
      endpoint: async (chatId) => ({
        url: `http://127.0.0.1:9/mcp/chat/${chatId}`,
        token: 't',
      }),
      onNote: () => undefined,
      spawn: (spec) => {
        const proc = new FakeProcess(spec)
        procs.push(proc)
        return proc as unknown as ClaudeProcess
      },
    })
    const turn = (text: string, effort?: Effort): BackendTurn => ({
      chatId: 'chat-1',
      companionId: 'pip',
      capabilities: {
        model: 'claude-opus-5-5',
        effort: 'high',
        browser: false,
        webTools: false,
        memory: false,
        connectorIds: [],
        engine: 'claude-code',
      },
      system: 'You are Pip.',
      history: [],
      blocks: [{ type: 'text', text }],
      session: null,
      signal: new AbortController().signal,
      emit: () => undefined,
      details: () => undefined,
      setSession: () => undefined,
      tools: { execute: async () => 'ok' },
      connectors: [],
      ...(effort ? { effort } : {}),
    })
    const run = async (text: string, effort?: Effort): Promise<FakeProcess> => {
      const running = backend.run(turn(text, effort))
      await until(() => procs.length === 1 && procs[0]!.lines.some((l) => l === `send:${text}`))
      procs[0]!.push(done)
      await running
      return procs[0]!
    }
    return { backend, run }
  }

  it('sets the effort before the message, and the chat’s back on the next one', async () => {
    const { backend, run } = bridge()
    await run('thanks!', 'low')
    await run('plan my week')
    const proc = await run('and next week')
    expect(proc.lines.map((l) => l.replace(/:[0-9a-f-]{36}$/, ''))).toEqual(['effort:low', 'send:thanks!', 'effort:high', 'send:plan my week', 'send:and next week'])
    expect(proc.spec.args[proc.spec.args.indexOf('--effort') + 1]).toBe('high') // launched at the chat's effort
    await backend.dispose()
  })

  it('stops asking a CLI that refuses the change', async () => {
    const { backend, run } = bridge()
    const proc = await run('thanks!', 'low')
    const id = proc.lines[0]!.split(':').slice(2).join(':')
    proc.push({
      kind: 'control-response',
      requestId: id,
      ok: false,
      error: 'apply_flag_settings is not supported',
    })
    await run('ok', 'low')
    await run('fine')
    expect(proc.lines.filter((l) => l.startsWith('effort:'))).toHaveLength(1)
    await backend.dispose()
  })

  it('writes apply_flag_settings with the effort level', () => {
    expect(JSON.parse(effortLine('r1', 'low'))).toEqual({
      type: 'control_request',
      request_id: 'r1',
      request: {
        subtype: 'apply_flag_settings',
        settings: { effortLevel: 'low' },
      },
    })
  })
})
