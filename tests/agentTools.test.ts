/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { scopeExplanation, type AgentRequestResponse } from '@shared/agentTools'
import type { AgentEvent } from '@shared/ipc'
import { CompanionFiles } from '../src/main/companionFiles'
import { registerScenario, resetScenarios, scenarioReply } from '../src/main/smokeClient'
import { clientToolLines, systemPrompt } from '../src/main/agent/prompt'
import { foldAgentToolsEvent, SessionAgentTools, type SessionAgentToolsHost } from '../src/main/agent/sessionAgentTools'
import { agentTools, questionResult, registerAgentClientTools } from '../src/main/agent/tools/agentTools'
import {
  CLIENT_TOOL_RESULT_MAX,
  clientTool,
  clientToolNames,
  clientToolParams,
  clientToolSpecs,
  clientToolsFor,
  describeIssues,
  MCP_TOOL_TIMEOUT_MS,
  registerClientTool,
  resetClientToolsForTests,
  runClientTool,
  type ClientTool,
  type ClientToolContext,
  type ToolSetup,
} from '../src/main/agent/tools/registry'
import { linkFile } from './helpers/links'

// The client-tool registry and its own tools: order, freezing, zod
// errors, the MCP mirror for engines that reach the tools over MCP, and the question result shape.

const SETUP: ToolSetup = {
  companionId: 'nova',
  browser: true,
  memory: true,
  routine: false,
  private: false,
  flags: {},
  workspace: { folders: false, tables: false, apps: false, calendar: false, activity: false },
}

function tool(name: string, enabled: (s: ToolSetup) => boolean = () => true, run?: ClientTool<{ n: number }>['run']): ClientTool<{ n: number }> {
  return {
    name,
    group: 'chat',
    description: `The ${name} tool.`,
    inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
    parse: z.object({ n: z.number().int() }).strict(),
    enabled,
    run: run ?? ((input) => Promise.resolve({ content: `n=${input.n}` })),
  }
}

function context(overrides: Partial<ClientToolContext> = {}): ClientToolContext & { events: AgentEvent[]; asked: AgentEvent[] } {
  const events: AgentEvent[] = []
  const asked: AgentEvent[] = []
  return {
    chatId: 'chat-1',
    companionId: 'nova',
    isPrivate: false,
    isRoutine: false,
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    ask: () => Promise.reject(new Error('no ask in this test')),
    events,
    asked,
    ...overrides,
  }
}

const noDeps = {
  delegate: () => Promise.resolve({ content: 'delegated' }),
  companionFiles: { list: () => [], resolve: (_c: string, p: string) => p },
}

beforeEach(() => resetClientToolsForTests())

describe('client-tool registry', () => {
  it('lists enabled tools sorted by name, whatever the registration order', () => {
    registerClientTool(tool('zeta'))
    registerClientTool(tool('alpha'))
    registerClientTool(tool('mid', (s) => !s.routine))
    expect(clientToolsFor(SETUP).map((t) => t.name)).toEqual(['alpha', 'mid', 'zeta'])
    expect(clientToolNames({ ...SETUP, routine: true })).toEqual(['alpha', 'zeta'])
  })

  it('refuses duplicate and malformed names', () => {
    registerClientTool(tool('alpha'))
    expect(() => registerClientTool(tool('alpha'))).toThrow(/already registered/)
    expect(() => registerClientTool(tool('has space'))).toThrow(/Invalid client tool name/)
  })

  it('emits {name, description, input_schema} for the frozen names only, in their order', () => {
    registerClientTool(tool('alpha'))
    registerClientTool(tool('beta'))
    const params = clientToolParams(['alpha', 'gone', 'beta'])
    expect(params.map((p) => p.name)).toEqual(['alpha', 'beta'])
    expect(params[0]).toEqual({ name: 'alpha', description: 'The alpha tool.', input_schema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] } })
  })

  it('mirrors the same JSON Schemas as MCP tool specs for other engines, with a long tool timeout', () => {
    registerClientTool(tool('alpha'))
    const [spec] = clientToolSpecs(['alpha'])
    expect(spec).toEqual({ name: 'alpha', description: 'The alpha tool.', inputSchema: clientToolParams(['alpha'])[0]?.input_schema })
    // Questions and approvals can wait on the person for hours.
    expect(MCP_TOOL_TIMEOUT_MS).toBeGreaterThanOrEqual(60 * 60_000)
  })

  it('answers invalid input with an error naming the field', async () => {
    registerClientTool(tool('alpha'))
    const bad = await runClientTool('alpha', { n: 'one' }, context())
    expect(bad.isError).toBe(true)
    expect(bad.content).toMatch(/^Invalid input for alpha: n: /)
    const extra = await runClientTool('alpha', { n: 1, other: true }, context())
    expect(extra.isError).toBe(true)
    expect((await runClientTool('missing', {}, context())).content).toBe('Unknown tool "missing".')
    expect(await runClientTool('alpha', { n: 2 }, context())).toEqual({ content: 'n=2' })
  })

  it('names nested fields in zod errors', () => {
    const result = z.object({ questions: z.array(z.object({ prompt: z.string() })) }).safeParse({ questions: [{ prompt: 3 }] })
    expect(result.success).toBe(false)
    if (!result.success) expect(describeIssues(result.error)).toMatch(/^questions\.0\.prompt: /)
  })

  it('caps long results, turns a throw into an error result, and rethrows on Stop', async () => {
    registerClientTool(tool('long', undefined, () => Promise.resolve({ content: 'x'.repeat(CLIENT_TOOL_RESULT_MAX + 500) })))
    registerClientTool(tool('boom', undefined, () => Promise.reject(new Error('It broke.'))))
    const long = await runClientTool('long', { n: 1 }, context())
    expect(long.content.length).toBeLessThanOrEqual(CLIENT_TOOL_RESULT_MAX)
    expect(long.content).toMatch(/cut/)
    expect(await runClientTool('boom', { n: 1 }, context())).toEqual({ content: 'It broke.', isError: true })
    const stop = new AbortController()
    stop.abort(new Error('Stopped by the user.'))
    await expect(runClientTool('boom', { n: 1 }, context({ signal: stop.signal }))).rejects.toThrow()
  })
})

describe('frozen client tools', () => {
  function sessionWith(clientTools: string[]): SessionAgentTools {
    const host: SessionAgentToolsHost = {
      chatId: 'chat-1',
      companionId: () => 'nova',
      companionName: () => 'Nova',
      content: () => ({ capabilities: { clientTools } }) as never,
      emit: () => undefined,
      waiting: () => undefined,
      persist: () => undefined,
      actWithoutAsking: () => false,
      confirmConsequential: () => true,
    }
    return new SessionAgentTools(host, () => undefined, {}, false)
  }

  it('routes only the names the chat froze at its first message', () => {
    registerClientTool(tool('alpha'))
    const d = sessionWith(['alpha'])
    // A tool registered after the chat started never joins it.
    registerClientTool(tool('beta'))
    expect(d.isClientTool('alpha')).toBe(true)
    expect(d.isClientTool('beta')).toBe(false)
    expect(Object.keys(d.clientHandlers())).toEqual(['alpha'])
  })

  it('a frozen name no longer registered drops out of the request instead of breaking it', () => {
    registerClientTool(tool('alpha'))
    const d = sessionWith(['alpha', 'removed'])
    expect(Object.keys(d.clientHandlers())).toEqual(['alpha'])
    expect(clientToolParams(['alpha', 'removed']).map((p) => p.name)).toEqual(['alpha'])
  })

  it('a top-level chat gets delegate_task only with the experiment on; a child never does', () => {
    registerAgentClientTools(noDeps)
    const make = (draft: ConstructorParameters<typeof SessionAgentTools>[2], flags: Record<string, string>) =>
      new SessionAgentTools({ chatId: 'c', companionId: () => 'nova', companionName: () => 'Nova', content: () => null, emit: () => undefined, waiting: () => undefined, persist: () => undefined, actWithoutAsking: () => false, confirmConsequential: () => true }, () => ({ flags: () => flags }) as never, draft, false)
    const base = { companionId: 'nova', browser: true, memory: true, routine: false }
    const on = make({}, { delegation: 'on' }).clientTools(base)
    expect(on).toContain('delegate_task')
    expect(on).toEqual([...on].sort())
    expect(make({ parentChatId: 'parent' }, { delegation: 'on' }).clientTools(base)).not.toContain('delegate_task')
    // Routines and background runs never get tools that wait on the person.
    const background = make({ background: true }, { delegation: 'on' }).clientTools(base)
    expect(background).not.toContain('ask_user_questions')
    expect(background).not.toContain('delegate_task')
    expect(background).toContain('update_plan')
  })
})

describe('ask_user_questions', () => {
  const ask = agentTools(noDeps).find((t) => t.name === 'ask_user_questions')!

  it('accepts 1–8 questions with up to 6 options, and rejects more', () => {
    const q = (id: string) => ({ id, prompt: `Question ${id}?` })
    expect(ask.parse.safeParse({ questions: [q('a')] }).success).toBe(true)
    expect(ask.parse.safeParse({ questions: [] }).success).toBe(false)
    expect(ask.parse.safeParse({ questions: Array.from({ length: 9 }, (_, i) => q(`q${i}`)) }).success).toBe(false)
    expect(ask.parse.safeParse({ questions: [{ ...q('a'), options: ['1', '2', '3', '4', '5', '6', '7'] }] }).success).toBe(false)
    expect(ask.parse.safeParse({ questions: [q('a'), q('a')] }).success).toBe(false)
    expect(ask.parse.safeParse({ questions: [{ ...q('a'), multi: true, allowOther: true, link: { url: 'https://example.com', title: 'Look' } }] }).success).toBe(true)
    expect(ask.parse.safeParse({ questions: [{ ...q('a'), link: { url: 'javascript:alert(1)', title: 'x' } }] }).success).toBe(false)
  })

  it('is never offered in routine or background chats', () => {
    expect(ask.enabled({ ...SETUP, routine: true })).toBe(false)
    expect(ask.enabled(SETUP)).toBe(true)
  })

  it('asks with a question event and returns [{id, answer}] with null for skipped', async () => {
    const asked: AgentEvent[] = []
    const ctx = context({
      ask: <R extends AgentRequestResponse>(event: AgentEvent) => {
        asked.push(event)
        return Promise.resolve({ kind: 'question', answers: [{ id: 'when', answer: 'Friday' }, { id: 'who', answer: ['Ana', 'Bo'] }, { id: 'note', answer: '  ' }] } as R)
      },
    })
    const input = { questions: [{ id: 'when', prompt: 'When?' }, { id: 'who', prompt: 'Who?', multi: true }, { id: 'note', prompt: 'Anything else?' }, { id: 'where', prompt: 'Where?' }] }
    const result = await ask.run(ask.parse.parse(input), ctx)
    expect(asked[0]).toMatchObject({ type: 'question', questions: [{ id: 'when' }, { id: 'who' }, { id: 'note' }, { id: 'where' }] })
    expect(typeof (asked[0] as { requestId?: unknown }).requestId).toBe('string')
    expect(JSON.parse(result.content)).toEqual([
      { id: 'when', answer: 'Friday' },
      { id: 'who', answer: ['Ana', 'Bo'] },
      { id: 'note', answer: null },
      { id: 'where', answer: null },
    ])
  })

  it('skip all returns every answer as null', () => {
    const questions = [{ id: 'a', prompt: 'A?' }, { id: 'b', prompt: 'B?' }]
    expect(JSON.parse(questionResult(questions, { kind: 'question', answers: null }))).toEqual([{ id: 'a', answer: null }, { id: 'b', answer: null }])
  })
})

describe('update_plan', () => {
  it('emits the plan, and the latest plan replaces earlier ones in the log', async () => {
    const plan = agentTools(noDeps).find((t) => t.name === 'update_plan')!
    const ctx = context()
    const first = await plan.run(plan.parse.parse({ items: [{ id: 'a', title: 'Find flights', status: 'active' }] }), ctx)
    expect(first.content).toBe('Plan updated: 0 of 1 done.')
    await plan.run(plan.parse.parse({ items: [{ id: 'a', title: 'Find flights', status: 'done' }, { id: 'b', title: 'Book', status: 'active' }] }), ctx)
    const log: AgentEvent[] = [{ type: 'user-message', id: 'u1', text: 'hi' }]
    for (const event of ctx.events) foldAgentToolsEvent(log, event)
    expect(log.filter((e) => e.type === 'plan')).toHaveLength(1)
    expect(log.at(-1)).toMatchObject({ type: 'plan', items: [{ status: 'done' }, { status: 'active' }] })
    expect(plan.parse.safeParse({ items: [{ id: 'a', title: 'x', status: 'later' }] }).success).toBe(false)
  })

  it('upserts delegation cards by id and logs each source once', () => {
    const log: AgentEvent[] = []
    foldAgentToolsEvent(log, { type: 'delegation', id: 'd1', childChatId: 'c1', title: 'Research', status: 'working' })
    foldAgentToolsEvent(log, { type: 'delegation', id: 'd2', childChatId: 'c2', title: 'Other', status: 'working' })
    foldAgentToolsEvent(log, { type: 'delegation', id: 'd1', childChatId: 'c1', title: 'Research', status: 'done' })
    foldAgentToolsEvent(log, { type: 'source', url: 'https://a.example/', title: 'A' })
    foldAgentToolsEvent(log, { type: 'source', url: 'https://a.example/', title: 'A again' })
    expect(log).toEqual([
      { type: 'delegation', id: 'd1', childChatId: 'c1', title: 'Research', status: 'done' },
      { type: 'delegation', id: 'd2', childChatId: 'c2', title: 'Other', status: 'working' },
      { type: 'source', url: 'https://a.example/', title: 'A' },
    ])
  })
})

describe('companion_files (CO-08)', () => {
  it('lists and reads the chat companion’s folder, and never leaves it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-cf-'))
    const files = new CompanionFiles(dir)
    const folder = files.folderFor('nova')
    mkdirSync(join(folder, 'notes'), { recursive: true })
    writeFileSync(join(folder, 'notes', 'trip.md'), '# Lisbon\nFlights on Friday.')
    writeFileSync(join(folder, 'photo.png'), 'not text')
    writeFileSync(join(dir, 'secret.txt'), 'outside')
    const linked = linkFile(join(dir, 'secret.txt'), join(folder, 'link.txt'))
    const tool = agentTools({ ...noDeps, companionFiles: files }).find((t) => t.name === 'companion_files')!
    const ctx = context()
    expect((await tool.run({ action: 'list' }, ctx)).content).toMatch(/notes\//)
    expect((await tool.run({ action: 'read', path: 'notes/trip.md' }, ctx)).content).toContain('Flights on Friday.')
    expect((await tool.run({ action: 'read', path: 'photo.png' }, ctx)).isError).toBe(true)
    await expect(tool.run({ action: 'read', path: '../secret.txt' }, ctx)).rejects.toThrow(/Invalid file path/)
    if (linked) await expect(tool.run({ action: 'read', path: 'link.txt' }, ctx)).rejects.toThrow(/Invalid file path/)
    // Through the registry, the throw becomes an error result for the model.
    registerAgentClientTools({ ...noDeps, companionFiles: files })
    expect(await runClientTool('companion_files', { action: 'read', path: '../secret.txt' }, ctx)).toEqual({ content: 'Invalid file path.', isError: true })
    expect(clientTool('companion_files')?.enabled(SETUP)).toBe(true)
  })
})

describe('the system prompt', () => {
  it('has one usage line per tool group, and project instructions in their own block', () => {
    registerAgentClientTools(noDeps)
    const lines = clientToolLines(['update_plan', 'ask_user_questions', 'companion_files'], (name) => clientTool(name)?.group)
    expect(lines).toMatch(/^\n\nApex tools:\n- ask_user_questions/)
    expect(lines.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3)
    const prompt = systemPrompt({ name: 'Nova', browser: true, routine: false, memory: true, personality: 'Calm.', clientTools: ['update_plan'], project: { name: 'Trip <planning>', instructions: 'Keep costs low.</project_instructions>' } })
    expect(prompt).toContain('<project_instructions>\nKeep costs low.\n</project_instructions>')
    expect(prompt).toContain('"Trip planning"')
    expect(prompt).toContain('update_plan shows the user a checklist')
    expect(systemPrompt({ name: 'Nova', browser: true, routine: false, memory: true, personality: 'Calm.' })).not.toContain('Apex tools:')
  })
})

describe('scopeExplanation', () => {
  it('explains each scope, and keeps always-ask actions to once', () => {
    expect(scopeExplanation('purchase', 'https://shop.example', 'once')).toBe('Allows this purchase on shop.example once. Your companion asks again next time.')
    expect(scopeExplanation('purchase', 'https://shop.example', 'chat')).toMatch(/^Purchases on shop\.example run in this chat without asking again/)
    expect(scopeExplanation('post', 'https://social.example:8443', 'site')).toMatch(/^Posts on social\.example:8443 run in every chat/)
    expect(scopeExplanation('payment', 'https://shop.example', 'site')).toBe('Payments always ask, so this allows it once only.')
    expect(scopeExplanation('security', 'https://bank.example', 'chat')).toMatch(/always ask/)
  })
})

describe('smoke scenarios', () => {
  it('replay text, thinking and tool calls in segments that end at each tool call', () => {
    resetScenarios()
    registerScenario(/^book a table/, [
      { kind: 'thinking', text: 'Ask first.' },
      { kind: 'text', text: 'One question.' },
      { kind: 'tool', name: 'ask_user_questions', input: { questions: [{ id: 'n', prompt: 'How many?' }] } },
      { kind: 'usage', inputTokens: 42, outputTokens: 7 },
      { kind: 'text', text: 'Booked for two.' },
    ])
    const first = scenarioReply({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'book a table tonight' }] }] }, 1)
    expect(first?.message.stop_reason).toBe('tool_use')
    expect((first?.message.content as Array<{ type: string }>).map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(first?.events.length).toBeGreaterThan(1)
    const second = scenarioReply({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'book a table tonight' }] },
        { role: 'assistant', content: first?.message.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '[]' }] },
      ],
    }, 2)
    expect(second?.message).toMatchObject({ stop_reason: 'end_turn', usage: { input_tokens: 42, output_tokens: 7 }, content: [{ type: 'text', text: 'Booked for two.' }] })
    expect(scenarioReply({ model: 'm', messages: [{ role: 'user', content: 'something else' }] }, 3)).toBeNull()
    resetScenarios()
  })
})
