/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import type { EngineId } from '@shared/engine'
import { EngineUnavailableError, QUICK_DEFAULT_MODEL, createQuickModel, extractJson, quickJsonSchema, type QuickClient, type QuickCreateParams, type QuickEngine, type QuickModelDeps } from '../src/main/agent/quick'

/** A scripted Messages client: answers each call with the next reply and records the request. */
function scripted(replies: string[]) {
  const requests: QuickCreateParams[] = []
  const client: QuickClient = {
    messages: {
      create: async (params) => {
        requests.push(params)
        const text = replies.shift() ?? ''
        return { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
      },
    },
  }
  return { client, requests }
}

function deps(over: Partial<QuickModelDeps> = {}): QuickModelDeps {
  return { engine: () => 'api-key', apiKey: () => 'sk-test', client: () => scripted([]).client, others: {}, ...over }
}

/** Another engine (engines/extras.ts) as a fake: answers each call with the next reply and records it. */
function otherEngine(replies: string[], ready = true): QuickEngine & { calls: Array<{ prompt: string; model: string; jsonSchema: Record<string, unknown> | null }> } {
  const calls: Array<{ prompt: string; model: string; jsonSchema: Record<string, unknown> | null }> = []
  return {
    calls,
    ready: async () => (ready ? { ok: true } : { ok: false, reason: 'The other engine is signed out.' }),
    call: async (r, model, jsonSchema) => {
      calls.push({ prompt: r.prompt, model, jsonSchema })
      return replies.shift() ?? ''
    },
  }
}

/** A build's engine id the public build doesn't know; QuickModel takes any id its deps name. */
const OTHER = 'other-engine' as EngineId

describe('QuickModel', () => {
  it('uses the API key with Haiku by default, without streaming', async () => {
    const s = scripted(['Hello there.'])
    const quick = createQuickModel(deps({ client: () => s.client }))
    expect(await quick.text({ system: 'Be brief.', prompt: 'Say hi' })).toBe('Hello there.')
    expect(s.requests[0]).toMatchObject({ model: QUICK_DEFAULT_MODEL, system: 'Be brief.', messages: [{ role: 'user', content: 'Say hi' }] })
    expect(QUICK_DEFAULT_MODEL).toBe('claude-haiku-5-5')
  })

  it('throws EngineUnavailableError when no engine is ready', async () => {
    const quick = createQuickModel(deps({ apiKey: () => null, others: { [OTHER]: otherEngine([], false) } }))
    await expect(quick.text({ system: 's', prompt: 'p' })).rejects.toBeInstanceOf(EngineUnavailableError)
    expect(await quick.ready()).toEqual({ ok: false, engine: null, reason: 'No Anthropic API key is saved.' })
  })

  it('runs another engine when it is chosen, with the model and schema it asks for', async () => {
    const other = otherEngine(['From the other engine.'])
    const quick = createQuickModel(deps({ engine: () => OTHER, apiKey: () => null, others: { [OTHER]: other } }))
    expect(await quick.text({ system: 'sys', prompt: 'the prompt' })).toBe('From the other engine.')
    expect(other.calls[0]).toEqual({ prompt: 'the prompt', model: QUICK_DEFAULT_MODEL, jsonSchema: null })
    expect(await quick.ready()).toEqual({ ok: true, engine: OTHER })
  })

  it('falls back to the key when the chosen engine is not ready', async () => {
    const s = scripted(['via key'])
    const quick = createQuickModel(deps({ engine: () => OTHER, client: () => s.client, others: { [OTHER]: otherEngine([], false) } }))
    expect(await quick.text({ system: 's', prompt: 'p' })).toBe('via key')
  })

  it('parses and validates JSON, retrying once with the problem', async () => {
    const schema = z.object({ title: z.string(), items: z.array(z.string()) }).strict()
    const s = scripted(['{"title": 3}', 'Sure:\n```json\n{"title":"Plan","items":["a"]}\n```'])
    const quick = createQuickModel(deps({ client: () => s.client }))
    expect(await quick.json({ system: 'Summarize.', prompt: 'notes', schema })).toEqual({ title: 'Plan', items: ['a'] })
    expect(s.requests).toHaveLength(2)
    expect(s.requests[1]?.messages[0]?.content).toContain('could not be used')
  })

  it('gives up after the retry', async () => {
    const s = scripted(['no json here', 'still none'])
    const quick = createQuickModel(deps({ client: () => s.client }))
    await expect(quick.json({ system: 's', prompt: 'p', schema: z.object({ a: z.number() }) })).rejects.toThrow(/expected shape/)
  })
})

describe('quick helpers', () => {
  it('extracts JSON from fenced or wrapped replies', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('Here you go: {"a":[1,2]} done')).toEqual({ a: [1, 2] })
    expect(() => extractJson('nothing')).toThrow()
  })
})

describe('QuickModel effort and structured output', () => {
  const schema = z.object({ title: z.string(), items: z.array(z.string()) })

  it('sends effort and a json_schema format with the key, and still checks the reply with zod', async () => {
    const seen: QuickCreateParams[] = []
    const client: QuickClient = {
      messages: {
        create: async (params) => {
          seen.push(params)
          return { content: [{ type: 'text', text: '{"title":"Plan","items":["a"]}' }], stop_reason: 'end_turn' }
        },
      },
    }
    const quick = createQuickModel(deps({ client: () => client }))
    expect(await quick.json({ system: 's', prompt: 'p', schema, effort: 'low', kind: 'onboarding' })).toEqual({ title: 'Plan', items: ['a'] })
    expect(seen[0]?.output_config?.effort).toBe('low')
    expect(seen[0]?.output_config?.format).toMatchObject({ type: 'json_schema', schema: { type: 'object', additionalProperties: false } })
    // A plain text call sends no output_config at all.
    await quick.text({ system: 's', prompt: 'p' })
    expect(seen[1]).not.toHaveProperty('output_config')
  })

  it('retries once without output_config when the API rejects it (400)', async () => {
    const seen: QuickCreateParams[] = []
    const client: QuickClient = {
      messages: {
        create: async (params) => {
          seen.push(params)
          if (params.output_config) throw new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'effort unsupported' } }, 'effort unsupported', new Headers())
          return { content: [{ type: 'text', text: 'plain' }], stop_reason: 'end_turn' }
        },
      },
    }
    const quick = createQuickModel(deps({ client: () => client }))
    expect(await quick.text({ system: 's', prompt: 'p', effort: 'high' })).toBe('plain')
    expect(seen).toHaveLength(2)
    expect(seen[1]).not.toHaveProperty('output_config')
  })

  it('leaves the schema to the prompt when zod cannot express it as JSON Schema', () => {
    expect(quickJsonSchema(z.string().transform((s) => s.length))).toBeNull()
    expect(quickJsonSchema(schema)).toMatchObject({ type: 'object' })
  })

})

describe('QuickModel for apps (docs/apps.md › Atelier as the AI engine)', () => {
  it('runs a conversation with the caller’s tools until the model answers', async () => {
    const requests: unknown[] = []
    const replies = [
      { content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'ghosts' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'You have one story about ghosts.' }], stop_reason: 'end_turn' },
    ]
    const client: QuickClient = { messages: { create: async (params) => (requests.push(JSON.parse(JSON.stringify(params))), replies.shift() as never) } }
    const quick = createQuickModel(deps({ client: () => client }))
    const calls: unknown[] = []
    const out = await quick.toolLoop({
      system: 's',
      history: [{ role: 'user', content: 'Any ghost stories?' }],
      tools: [{ name: 'lookup', description: 'Finds stories.', input_schema: { type: 'object' } }],
      onTool: async (name, input) => (calls.push([name, input]), { ok: true, text: '["Ghosts"]' }),
    })
    expect(out.text).toBe('You have one story about ghosts.')
    expect(calls).toEqual([['lookup', { q: 'ghosts' }]])
    expect(out.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect((requests[1] as { messages: Array<{ content: unknown }> }).messages[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'tu_1', content: '["Ghosts"]' }])
  })

  it('runs the tools on another engine too, one call per round in JSON, with the same history', async () => {
    const other = otherEngine([JSON.stringify({ action: 'tool', tool: 'lookup', input: { q: 'ghosts' } }), JSON.stringify({ action: 'reply', text: 'You have one story about ghosts.' })])
    const quick = createQuickModel(deps({ engine: () => OTHER, apiKey: () => null, others: { [OTHER]: other } }))
    const calls: unknown[] = []
    const out = await quick.toolLoop({
      system: 's',
      history: [{ role: 'user', content: 'Any ghost stories?' }],
      tools: [{ name: 'lookup', description: 'Finds stories.', input_schema: { type: 'object' } }],
      onTool: async (name, input) => (calls.push([name, input]), { ok: true, text: '["Ghosts"]' }),
    })
    expect(out.text).toBe('You have one story about ghosts.')
    expect(calls).toEqual([['lookup', { q: 'ghosts' }]])
    expect(out.history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(out.history[1]?.content).toMatchObject([{ type: 'tool_use', name: 'lookup', input: { q: 'ghosts' } }])
    expect(other.calls[1]?.prompt).toContain('The tool returned: ["Ghosts"]')
    expect(other.calls[0]?.jsonSchema).toMatchObject({ type: 'object', required: ['action'] })
  })

  it('stops after the round cap', async () => {
    const looping: QuickClient = { messages: { create: async () => ({ content: [{ type: 'tool_use', id: 'x', name: 'again', input: {} }], stop_reason: 'tool_use' }) } }
    const quick = createQuickModel(deps({ client: () => looping }))
    const out = await quick.toolLoop({ system: 's', history: [{ role: 'user', content: 'go' }], tools: [{ name: 'again', description: 'd', input_schema: { type: 'object' } }], rounds: 3, onTool: async () => ({ ok: true, text: 'ok' }) })
    expect(out.text).toMatch(/stopped after 3 tool rounds/)
  })

  it('streams with the key, and answers in one piece without a stream', async () => {
    const streaming: QuickClient = {
      messages: {
        create: async () => ({ content: [{ type: 'text', text: 'whole' }], stop_reason: 'end_turn' }),
        async *stream() {
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } }
          yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } }
          yield { type: 'message_delta', usage: { output_tokens: 2 } }
        },
      },
    }
    const pieces: string[] = []
    expect(await createQuickModel(deps({ client: () => streaming })).stream({ system: 's', prompt: 'p' }, (t) => pieces.push(t))).toBe('Hello')
    expect(pieces).toEqual(['Hel', 'lo'])
    const plain: string[] = []
    expect(await createQuickModel(deps({ client: () => scripted(['in one piece']).client })).stream({ system: 's', prompt: 'p' }, (t) => plain.push(t))).toBe('in one piece')
    expect(plain).toEqual(['in one piece'])
  })
})
