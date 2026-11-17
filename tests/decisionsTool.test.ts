/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

import type { DecisionRequest, DecisionResult } from '../src/shared/decisions'
import type { ClientToolContext, ToolSetup } from '../src/main/agent/tools/registry'
import { DecisionError } from '../src/main/decisions/client'
import { RULES_ONLY, setDecider, type Decider } from '../src/main/decisions/service'
import { LABEL_ITEMS_MAX, labelItemsTool, readAnswer, registerLabelItems } from '../src/main/decisions/tool'
import { clientTool } from '../src/main/agent/tools/registry'
import { clientToolLines } from '../src/main/agent/prompt'

// label_items (DC-13, docs/decisions.md › Your companion): the companion's
// way to hand many small judgment calls to the decision model.

const SETUP: ToolSetup = {
  companionId: 'pip',
  browser: true,
  memory: true,
  routine: false,
  private: false,
  flags: {},
  workspace: {
    folders: false,
    tables: false,
    apps: false,
    calendar: false,
    activity: false,
  },
}

function context(extra: Partial<ClientToolContext> = {}): ClientToolContext {
  return {
    chatId: 'c1',
    companionId: 'pip',
    isPrivate: false,
    isRoutine: false,
    signal: new AbortController().signal,
    emit: () => undefined,
    ask: () => Promise.reject(new Error('no')),
    ...extra,
  }
}

/** A decider whose model answers each request with `answer(request)`. */
function fakeDecider(answer: (request: DecisionRequest) => Promise<DecisionResult> | DecisionResult, active = true): Decider & { requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = []
  return {
    requests,
    decide: async (call) => call.rule,
    active: (use) => active && use === 'labeling',
    ready: () => active,
    paused: () => false,
    ask: () => Promise.reject(new Error('not used')),
    model: async (_caller, request) => {
      requests.push(request)
      return answer(request)
    },
  }
}

const result = (answers: DecisionResult['answers']): DecisionResult => ({
  answers,
  model: 'clef-flash',
  source: 'model',
  ms: 400,
  inputTokens: 100,
})

const QUESTIONS = {
  topic: {
    type: 'choice' as const,
    instructions: 'What is it about?',
    criteria: { work: 'Work', personal: null },
  },
  urgent: { type: 'noul' as const, instructions: 'Does it need action today?' },
}

afterEach(() => setDecider(null))

describe('label_items', () => {
  it('is offered only while a decision model is on for labeling, and never in a private chat', () => {
    setDecider(RULES_ONLY)
    expect(labelItemsTool.enabled(SETUP)).toBe(false)
    setDecider(fakeDecider(() => result({})))
    expect(labelItemsTool.enabled(SETUP)).toBe(true)
    expect(labelItemsTool.enabled({ ...SETUP, private: true })).toBe(false)
    setDecider(fakeDecider(() => result({}), false))
    expect(labelItemsTool.enabled(SETUP)).toBe(false)
  })

  it('reads sure answers as verdicts and the rest as unsure with what the model leaned towards', () => {
    expect(readAnswer(QUESTIONS.urgent, { type: 'noul', noul: 0.91 })).toEqual({
      answer: 'yes',
      p: 0.91,
    })
    expect(readAnswer(QUESTIONS.urgent, { type: 'noul', noul: 0.5 })).toEqual({
      answer: 'unsure',
      p: 0.5,
    })
    expect(
      readAnswer(QUESTIONS.topic, {
        type: 'choice',
        choice: 'work',
        confidence: 0.9,
        probabilities: { work: 0.95, personal: 0.05 },
      }),
    ).toEqual({ answer: 'work', p: 0.95 })
    expect(
      readAnswer(QUESTIONS.topic, {
        type: 'choice',
        choice: 'work',
        confidence: 0.2,
        probabilities: { work: 0.6, personal: 0.4 },
      }),
    ).toEqual({ answer: 'unsure', p: 0.6, leaning: 'work' })
    const scale = {
      type: 'score' as const,
      instructions: 'How urgent?',
      criteria: ['not', 'somewhat', 'very'],
    }
    expect(
      readAnswer(scale, {
        type: 'score',
        score: 1.9,
        confidence: 0.8,
        probabilities: { 0: 0.02, 1: 0.08, 2: 0.9 },
      }),
    ).toEqual({ answer: 'very', p: 0.9 })
    expect(
      readAnswer(scale, {
        type: 'score',
        score: 1,
        confidence: 0.3,
        probabilities: { 0: 0.3, 1: 0.4, 2: 0.3 },
      }),
    ).toEqual({ answer: 'unsure', p: 0.4, leaning: 'somewhat' })
    expect(readAnswer(QUESTIONS.urgent, undefined)).toEqual({
      answer: 'unsure',
      p: 0,
    })
  })

  it('asks once per item with the shared context, and returns every item in order', async () => {
    const d = fakeDecider((request) => {
      const item = (request.state as { item: string }).item
      return result({
        topic: {
          type: 'choice',
          choice: item.includes('boss') ? 'work' : 'personal',
          confidence: 0.9,
          probabilities: item.includes('boss') ? { work: 0.97, personal: 0.03 } : { work: 0.1, personal: 0.9 },
        },
        urgent: { type: 'noul', noul: item.includes('today') ? 0.88 : 0.5 },
      })
    })
    setDecider(d)
    const out = await labelItemsTool.run(
      {
        items: [{ text: 'From my boss: the slides are due today' }, { id: 'mum', text: 'From mum: lovely Sunday' }],
        questions: QUESTIONS,
        context: 'Emails in an inbox',
      },
      context(),
    )
    expect(out.isError).toBeUndefined()
    const body = JSON.parse(out.content) as {
      model: string
      items: Array<{ id: string; answers: Record<string, { answer: string }> }>
      note: string
    }
    expect(body.model).toBe('clef-flash')
    expect(body.items.map((i) => [i.id, i.answers.topic!.answer, i.answers.urgent!.answer])).toEqual([
      ['1', 'work', 'yes'],
      ['mum', 'personal', 'unsure'],
    ])
    expect(body.note).toMatch(/1 item\(s\) have an “unsure” answer/)
    expect(d.requests).toHaveLength(2)
    expect(d.requests[0]).toMatchObject({
      state: {
        context: 'Emails in an inbox',
        item: 'From my boss: the slides are due today',
      },
      questions: QUESTIONS,
    })
  })

  it('stops sending after a rate limit and says which items to judge itself', async () => {
    let calls = 0
    const d = fakeDecider(() => {
      calls++
      if (calls === 2) throw new DecisionError('rate-limited', '429')
      return result({ urgent: { type: 'noul', noul: 0.1 } })
    })
    setDecider(d)
    const items = Array.from({ length: 12 }, (_, i) => ({ text: `item ${i}` }))
    const out = await labelItemsTool.run({ items, questions: { urgent: QUESTIONS.urgent } }, context())
    const body = JSON.parse(out.content) as {
      items: Array<{ answers?: unknown; error?: string }>
      note: string
    }
    expect(body.items).toHaveLength(12)
    expect(d.requests.length).toBeLessThan(12)
    expect(body.items.filter((i) => i.error === 'the provider’s rate limit was reached').length).toBeGreaterThanOrEqual(12 - d.requests.length)
    expect(body.note).toMatch(/were not answered/)
  })

  it('reports plainly when nothing was answered, when the model is off, and in a private chat', async () => {
    setDecider(fakeDecider(() => Promise.reject(new DecisionError('unauthorized', '401'))))
    await expect(
      labelItemsTool.run(
        {
          items: [{ text: 'a' }, { text: 'b' }],
          questions: { urgent: QUESTIONS.urgent },
        },
        context(),
      ),
    ).resolves.toMatchObject({
      isError: true,
      content: expect.stringMatching(/refused the key/),
    })
    setDecider(fakeDecider(() => result({}), false))
    await expect(labelItemsTool.run({ items: [{ text: 'a' }], questions: { urgent: QUESTIONS.urgent } }, context())).resolves.toMatchObject({
      isError: true,
      content: expect.stringMatching(/off or not set up/),
    })
    const d = fakeDecider(() => result({}))
    setDecider(d)
    await expect(labelItemsTool.run({ items: [{ text: 'a' }], questions: { urgent: QUESTIONS.urgent } }, context({ isPrivate: true }))).resolves.toMatchObject({ isError: true })
    expect(d.requests).toHaveLength(0)
  })

  it('stops with the chat', async () => {
    const stop = new AbortController()
    setDecider(
      fakeDecider(async () => {
        stop.abort()
        return result({ urgent: { type: 'noul', noul: 0.9 } })
      }),
    )
    await expect(
      labelItemsTool.run(
        {
          items: [{ text: 'a' }, { text: 'b' }],
          questions: { urgent: QUESTIONS.urgent },
        },
        context({ signal: stop.signal }),
      ),
    ).rejects.toThrow()
  })

  it('has a line in the system prompt on when to use it', () => {
    registerLabelItems()
    expect(clientToolLines(['label_items'], (name) => clientTool(name)?.group)).toMatch(/- label_items answers the same .* judge the ones it marks "unsure" yourself\./)
  })

  it('validates its input', () => {
    const items = [{ text: 'a' }]
    expect(labelItemsTool.parse.safeParse({ items, questions: QUESTIONS }).success).toBe(true)
    expect(
      labelItemsTool.parse.safeParse({
        items: Array.from({ length: LABEL_ITEMS_MAX + 1 }, () => ({
          text: 'a',
        })),
        questions: QUESTIONS,
      }).success,
    ).toBe(false)
    expect(labelItemsTool.parse.safeParse({ items, questions: {} }).success).toBe(false)
    expect(
      labelItemsTool.parse.safeParse({
        items,
        questions: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`q${i}`, QUESTIONS.urgent])),
      }).success,
    ).toBe(false)
    expect(
      labelItemsTool.parse.safeParse({
        items,
        questions: {
          topic: {
            type: 'choice',
            instructions: 'x',
            criteria: { only: null },
          },
        },
      }).success,
    ).toBe(false)
    expect(
      labelItemsTool.parse.safeParse({
        items: [{ text: '' }],
        questions: QUESTIONS,
      }).success,
    ).toBe(false)
  })
})
