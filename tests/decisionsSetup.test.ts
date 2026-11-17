/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

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
import { createSmokeClient } from '../src/main/smokeClient'
import { ConnectorStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'

// DC-15 and DC-16 (docs/decisions.md): the effort each message a person sends
// runs at, and the companion's own skills ranked at the first message. The
// decision model is a fake that reads its scripted answers with the real
// questions' cutoffs; no network, no model.

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

// ---- an AgentHost on the smoke stand-in (API key) ----

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
    emit: (event) => events.push(event),
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  })
  const idle = (id: string) => until(() => !host.isRunning(id))
  return { host, chats, idle, events }
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

// ---- DC-15: effort per message ----

describe('DC-15 effort per message: model off', () => {
  it('sends the request exactly as before: the chat’s effort, no effort messages, no beta, nothing saved', async () => {
    setDecider(RULES_ONLY)
    smokeRichChat.reset()
    const t = harness('api-key')
    const id = t.host.start('thanks!')
    await t.idle(id)
    const request = smokeRichChat.lastRequest
    expect(lastOutput()).toEqual({ effort: 'medium' })
    expect(effortMessages(sentMessages())).toEqual([])
    expect(request?.betas ?? []).not.toContain(PER_MESSAGE_EFFORT_BETA)
    expect(t.chats.load(id).effortMarks).toBeUndefined()
    expect(detailsOf(t.chats, id).every((d) => d.effort === undefined)).toBe(true)
  })

  it('leaves buildRequest’s output untouched without marks (the very same object)', () => {
    const caps: ChatCapabilities = {
      model: 'claude-opus-5-5',
      effort: 'high',
      browser: false,
      webTools: false,
      memory: false,
      connectorIds: [],
    }
    const input = {
      capabilities: caps,
      system: 'Atelier.',
      effort: 'high' as Effort,
      connectors: [],
      messages: [{ role: 'user' as const, content: 'hi' }],
    }
    const plain = buildRequest(input)
    expect(buildRequest({ ...input, effortMarks: [] })).toEqual(plain)
    expect(withEffortMarks(plain, input.messages, undefined)).toBe(plain)
    expect(withEffortMarks(plain, input.messages, [])).toBe(plain)
  })
})

describe('DC-15 effort per message: model on (API key)', () => {
  it('runs a trivial message at low, then sets the chat’s effort back, history append-only', async () => {
    let answer = level(0)
    const fake = fakeDecider({ effort: () => answer })
    setDecider(fake)
    smokeRichChat.reset()
    const t = harness('api-key')
    const id = t.host.start('thanks!')
    await t.idle(id)
    const first = sentMessages()
    expect(effortMessages(first)).toEqual([{ after: 0, effort: 'low' }])
    expect(lastOutput()).toEqual({ effort: 'medium' }) // the request's own effort never moves (the cache stays)
    expect(smokeRichChat.lastRequest?.betas).toContain(PER_MESSAGE_EFFORT_BETA)
    expect(t.chats.load(id).effortMarks).toEqual([{ at: 0, effort: 'low' }])
    expect(detailsOf(t.chats, id).map((d) => d.effort)).toEqual(['low'])

    answer = level(1) // ordinary: the chat's effort, which needs a mark to come back
    t.host.send(id, 'Now plan my week, please.')
    await until(() => t.chats.load(id).messages.length >= 4)
    await t.idle(id)
    const second = sentMessages()
    expect(second.slice(0, first.length)).toEqual(first) // nothing earlier changed
    const typed = second.findIndex((m, i) => i > 1 && m.role === 'user')
    expect(effortMessages(second)).toEqual([
      { after: 0, effort: 'low' },
      { after: typed, effort: 'medium' },
    ])
    expect(t.chats.load(id).effortMarks).toEqual([
      { at: 0, effort: 'low' },
      { at: 2, effort: 'medium' },
    ])
    expect(detailsOf(t.chats, id).map((d) => d.effort)).toEqual(['low', undefined])
    expect(fake.asked).toEqual(['effort', 'effort'])
  })

  it('goes one step above the chat’s effort for hard work, and sends the previous reply’s end along', async () => {
    const requests: DecisionRequest[] = []
    setDecider(fakeDecider({ effort: (r) => (requests.push(r), level(2)) }))
    smokeRichChat.reset()
    const t = harness('api-key')
    const id = t.host.start('Compare these ten laptops for me.')
    await t.idle(id)
    expect(effortMessages(sentMessages())).toEqual([{ after: 0, effort: 'high' }])
    t.host.send(id, 'yes, go ahead')
    await until(() => requests.length === 2)
    await t.idle(id)
    expect(typeof requests[0]?.state).toBe('string')
    expect(requests[1]?.state).toMatchObject({
      message: 'yes, go ahead',
      previous_reply_end: expect.any(String),
    })
    // A message away from the chat's effort always gets its own mark, so compaction or a per-reply reading of marks can't lose it.
    expect(t.chats.load(id).effortMarks).toEqual([
      { at: 0, effort: 'high' },
      { at: 2, effort: 'high' },
    ])
  })

  it('never asks in a private chat or for a model without per-message effort', async () => {
    const fake = fakeDecider({ effort: () => level(0) })
    setDecider(fake)
    smokeRichChat.reset()
    const t = harness('api-key')
    const priv = t.host.start('thanks!', { private: true })
    await t.idle(priv)
    expect(effortMessages(sentMessages())).toEqual([])
    const haiku = harness('api-key', { model: 'claude-haiku-5-5' })
    const id = haiku.host.start('thanks!')
    await haiku.idle(id)
    expect(effortMessages(sentMessages())).toEqual([])
    expect(fake.asked).toEqual([])
    expect(perMessageEffort('claude-haiku-5-5')).toBe(false)
    expect(perMessageEffort('claude-sonnet-5-5')).toBe(true)
  })

  it('keeps the chat’s effort when the model is slower than the time limit', async () => {
    vi.useFakeTimers()
    setDecider(
      fakeDecider({
        effort: () => new Promise<DecisionResult>(() => undefined),
      }),
    )
    const decided = decideEffort('thanks!', '', 'high', false)
    await vi.advanceTimersByTimeAsync(800)
    await expect(decided).resolves.toBe('high')
  })
})

describe('DC-15 effort marks', () => {
  const user = (text: string): BetaMessageParam => ({
    role: 'user',
    content: [{ type: 'text', text }],
  })
  const reply = (text: string): BetaMessageParam => ({
    role: 'assistant',
    content: [{ type: 'text', text }],
  })
  const summary: BetaMessageParam = {
    role: 'assistant',
    content: [{ type: 'compaction', content: 'Earlier: ...' }],
  } as unknown as BetaMessageParam

  it('marks a change only, and reads the effort in effect from the marks the request still sends', () => {
    const history = [user('a'), reply('A'), user('b')]
    expect(markEffort(history, undefined, 2, 'medium', 'medium')).toBeNull()
    const marks = markEffort(history, undefined, 2, 'low', 'medium')
    expect(marks).toEqual([{ at: 2, effort: 'low' }])
    expect(effortInEffect(history, marks ?? [], 'medium')).toBe('low')
    // An on-demand summary after the mark starts the request there: the mark no longer counts.
    expect(effortInEffect([...history, reply('B'), summary, user('c')], marks ?? [], 'medium')).toBe('medium')
  })

  it('puts each effort message right after its message, after the history was cut to the summary', () => {
    const history = [user('a'), reply('A'), summary, user('b'), reply('B'), user('c')]
    const marks: EffortMark[] = [
      { at: 0, effort: 'low' },
      { at: 3, effort: 'high' },
    ]
    const request = {
      model: 'claude-opus-5-5',
      max_tokens: 10,
      messages: history.slice(2),
    }
    const out = withEffortMarks(request, history, marks)
    expect(out.messages.map((m) => m.role)).toEqual(['assistant', 'user', 'system', 'assistant', 'user'])
    expect(out.messages[2]).toEqual({
      role: 'system',
      output_config: { effort: 'high' },
    })
    expect(out.betas).toEqual([PER_MESSAGE_EFFORT_BETA])
  })

  it('drops marks with the messages a cut removes, and reads saved marks carefully', () => {
    const marks: EffortMark[] = [
      { at: 0, effort: 'low' },
      { at: 4, effort: 'high' },
    ]
    expect(marksBefore(marks, 4)).toEqual([{ at: 0, effort: 'low' }])
    expect(marksBefore(marks, 0)).toBeUndefined()
    expect(effortMarksOf([{ at: 0, effort: 'low' }, { at: 0, effort: 'max' }, { at: 2, effort: 'huge' }, { at: 9, effort: 'low' }, 'x', { at: 3, effort: 'high' }], 5)).toEqual([
      { at: 0, effort: 'low' },
      { at: 3, effort: 'high' },
    ])
    expect(effortMarksOf('nope', 5)).toBeUndefined()
  })

  it('keeps marks in the chat file across a reload', () => {
    const chats = new ChatStore(mkdtempSync(join(root, 'store-')), 'pip')
    const id = '00000000-0000-4000-8000-000000000001'
    const caps: ChatCapabilities = {
      model: 'claude-opus-5-5',
      effort: 'medium',
      browser: false,
      webTools: false,
      memory: false,
      connectorIds: [],
      engine: 'api-key',
      clientTools: [],
      private: false,
    }
    chats.save(
      {
        id,
        capabilities: caps,
        system: 's',
        messages: [user('a'), reply('A')],
        log: [],
        details: {},
        feedback: {},
        effortMarks: [{ at: 0, effort: 'low' }],
      },
      {
        created: {
          id,
          title: 't',
          createdAt: 1,
          updatedAt: 1,
          lastActiveAt: 1,
          companionId: 'pip',
        } as never,
      },
    )
    expect(chats.load(id).effortMarks).toEqual([{ at: 0, effort: 'low' }])
  })

  it('finds the newest reply’s text', () => {
    expect(lastReplyText([user('a'), reply('First'), user('b'), { role: 'assistant', content: [{ type: 'text', text: 'Second' }] }])).toBe('Second')
    expect(lastReplyText([user('a')])).toBe('')
  })
})

// ---- DC-16: the companion's own skills ----

const SKILL_TOOLS = ['read_skill']
const skill = (name: string): { name: string; description: string } => ({
  name,
  description: `Helps with ${name}.`,
})
const prompt = (skills: Parameters<typeof systemPrompt>[0]['skills']): string =>
  systemPrompt({
    name: 'Pip',
    browser: false,
    routine: false,
    memory: false,
    clientTools: SKILL_TOOLS,
    skills,
  })

describe('DC-16 skills ranked at the first message', () => {
  const skills = ['travel', 'budget', 'recipes', 'email'].map(skill)

  it('off, private or unsure: the prompt text is byte-identical to today’s', async () => {
    const today = prompt(skills)
    setDecider(RULES_ONLY)
    expect(prompt(await rankedOwnSkills('Plan a trip to Porto', skills, false))).toBe(today)
    setDecider(fakeDecider({ skills: skillAnswers([]) }))
    expect(prompt(await rankedOwnSkills('Plan a trip to Porto', skills, false))).toBe(today)
    const fake = fakeDecider({ skills: skillAnswers(['travel']) })
    setDecider(fake)
    expect(prompt(await rankedOwnSkills('Plan a trip to Porto', skills, true))).toBe(today)
    expect(fake.asked).toEqual([])
  })

  it('lists sure fits first, marked, and sure misfits last', async () => {
    setDecider(fakeDecider({ skills: skillAnswers(['travel'], ['budget']) }))
    const ranked = await rankedOwnSkills('Plan a trip to Porto', skills, false)
    expect(ranked.map((s) => [s.name, s.fits])).toEqual([
      ['travel', true],
      ['email', null],
      ['recipes', null],
      ['budget', false],
    ])
    const text = prompt(ranked)
    expect(text).toContain('- /travel (fits this request): Helps with travel.\n- /email: Helps with email.\n- /recipes: Helps with recipes.\n- /budget: Helps with budget.')
  })

  it('lists the 40 best-ranked of a long list (asked 20 at a time)', async () => {
    const many = Array.from({ length: 45 }, (_, i) => skill(`s${String(i).padStart(2, '0')}`))
    const fake = fakeDecider({ skills: skillAnswers(['s44'], ['s00']) })
    setDecider(fake)
    const text = prompt(await rankedOwnSkills('anything', many, false))
    expect(text).toContain('- /s44 (fits this request)')
    expect(text).not.toContain('/s00:')
    expect(prompt(many)).not.toContain('/s44') // by name, s44 was past the 40
    expect(fake.asked).toEqual(['skills', 'skills', 'skills'])
  })

  it('lists them by name when the model is slower than 1.5 s', async () => {
    vi.useFakeTimers()
    setDecider(
      fakeDecider({
        skills: () => new Promise<DecisionResult>(() => undefined),
      }),
    )
    const ranked = rankedOwnSkills('Plan a trip', skills, false)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(prompt(await ranked)).toBe(prompt(skills))
  })

  it('ranks them in a new chat’s prompt, only when the chat has read_skill', async () => {
    if (!clientTool('read_skill')) {
      registerClientTool({
        name: 'read_skill',
        group: 'skills',
        description: 'Read a skill.',
        inputSchema: { type: 'object', properties: {} },
        parse: z.object({}),
        enabled: () => true,
        run: async () => ({ content: '', isError: false }),
      } as never)
    }
    const rows: SkillRow[] = skills.map((s, i) => ({ id: `k${i}`, ...s }))
    setDecider(RULES_ONLY)
    const off = harness('api-key', { skills: rows })
    const offId = off.host.start('Plan a trip to Porto')
    await off.idle(offId)
    const offSystem = off.chats.load(offId).system
    expect(offSystem).toContain('- /budget: Helps with budget.\n- /email')

    setDecider(fakeDecider({ skills: skillAnswers(['travel']) }))
    const on = harness('api-key', { skills: rows })
    const onId = on.host.start('Plan a trip to Porto')
    await on.idle(onId)
    const onSystem = on.chats.load(onId).system
    expect(onSystem).toContain('- /travel (fits this request): Helps with travel.\n- /budget')
    expect(onSystem.replace('- /travel (fits this request): Helps with travel.\n', '')).toBe(offSystem.replace('\n- /travel: Helps with travel.', ''))
  })
})
