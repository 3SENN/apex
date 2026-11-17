/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { z } from 'zod'
import type { EngineId } from '@shared/engine'
import type { Effort } from '@shared/ipc'
import type { UsageKind } from '@shared/usage'
import { recordUsage } from './usageSink'

// QuickModel: one short, tool-free model call for small jobs such as
// meeting summaries, rewriting dictated text and labels. It runs on the
// person's own engine: their API key (a non-streaming messages.create, Haiku
// by default) or another engine the build adds (QuickEngine, from
// engines/extras.ts). Never both, never a network call in tests or smoke: the
// smoke run passes the offline smoke client.
//
// This is the one door for model calls outside chats. Chats go through
// agent/session.ts; everything else (meeting notes, dictation, quick ask,
// import summaries, skill drafts, first-week starters) comes here, so every
// engine gets the same effort, structured output and usage rows.

export const QUICK_DEFAULT_MODEL = 'claude-haiku-5-5'
const DEFAULT_MAX_TOKENS = 4096

/** No engine can run a quick call right now (no key, or the chosen engine isn't set up). */
export class EngineUnavailableError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'EngineUnavailableError'
    this.reason = reason
  }
}

export interface QuickRequest {
  system: string
  prompt: string
  /** Default QUICK_DEFAULT_MODEL. */
  model?: string
  maxTokens?: number
  signal?: AbortSignal
  // Every quick call is a row in the usage ledger
  /** What the call was for; defaults to 'draft'. */
  kind?: UsageKind
  companionId?: string
  /** How hard the model works (output_config.effort with the key; the other engines' own equivalent). Omitted: the model's default. */
  effort?: Effort
}

/** A json() request: the zod schema checks the reply on every engine and, when it converts, constrains it too. */
export type QuickJsonRequest<T> = QuickRequest & { schema: z.ZodType<T> }

export interface QuickModel {
  ready(): Promise<{ ok: boolean; engine: EngineId | null; reason?: string }>
  text(r: QuickRequest): Promise<string>
  json<T>(r: QuickJsonRequest<T>): Promise<T>
  /** A reply shaped by a JSON Schema where the engine can (structured output); the caller checks it. */
  structured(r: QuickRequest & { jsonSchema: Record<string, unknown> }): Promise<string>
  /** The reply as it arrives (with the key); other engines answer in one piece. Resolves to all of it. */
  stream(r: QuickRequest, onText: (text: string) => void): Promise<string>
  /**
   * A conversation with the caller's own tools (docs/apps.md › Apex as the AI
   * engine): the model may call them up to `rounds` times; each call goes to
   * `onTool`, whose answer goes back as the tool's result. With the key, as
   * Messages API tools; on another engine, whose one-shot calls carry no
   * client tools, as one call per round that answers in JSON (a tool to use,
   * or the reply). The history has the Messages API's shape on every engine,
   * so a session carries over when the engine changes.
   */
  toolLoop(r: QuickToolLoopRequest): Promise<{ text: string; history: QuickMessage[] }>
}

/** One message of a tool conversation, as the Messages API takes it. */
export type QuickMessage = { role: 'user' | 'assistant'; content: string | QuickBlock[] }
export type QuickBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface QuickTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface QuickToolLoopRequest {
  system: string
  history: QuickMessage[]
  tools: QuickTool[]
  model?: string
  maxTokens?: number
  rounds?: number
  signal?: AbortSignal
  kind?: UsageKind
  onTool(name: string, input: unknown): Promise<{ ok: boolean; text: string }>
}

/** The output_config a quick call sends with the key (the SDK's OutputConfig shape). */
export interface QuickOutputConfig {
  effort?: Effort
  format?: { type: 'json_schema'; schema: Record<string, unknown> }
}

/** The Messages request a quick call makes with the key. */
export interface QuickCreateParams {
  model: string
  max_tokens: number
  system: string
  messages: QuickMessage[]
  output_config?: QuickOutputConfig
  tools?: QuickTool[]
}

/** The slice of the Messages client a quick call uses; tests and smoke pass fakes. */
export interface QuickClient {
  messages: {
    create(
      params: QuickCreateParams,
      options?: { signal?: AbortSignal },
    ): Promise<{ content: ReadonlyArray<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>; stop_reason?: string | null; usage?: QuickUsage; model?: string }>
    /** Streaming events (content_block_delta with a text_delta, message_delta with usage); absent in fakes, which then answer in one piece. */
    stream?(params: QuickCreateParams, options?: { signal?: AbortSignal }): AsyncIterable<{ type: string; delta?: { type?: string; text?: string }; usage?: { output_tokens?: number } }>
  }
}

/** An engine besides the API key that answers quick calls (engines/extras.ts). */
export interface QuickEngine {
  /** Whether it can answer now, with the reason when it can't. */
  ready(): Promise<{ ok: boolean; reason?: string }>
  /** One tool-free call with `model`; `jsonSchema` constrains the reply where the engine can. It records its own usage (noteQuickUsage). */
  call(r: QuickRequest, model: string, jsonSchema: Record<string, unknown> | null): Promise<string>
}

export interface QuickModelDeps {
  /** The engine new chats use (settings.engine); tried first. */
  engine(): EngineId
  apiKey(): string | null
  client(apiKey: string): QuickClient
  /** The other engines that answer quick calls, by EngineId (none in builds without them, and in smoke). */
  others: Partial<Record<string, QuickEngine>>
}

/** The real Messages client for quick calls (non-streaming), under the person's own key. */
export function anthropicQuickClient(apiKey: string): QuickClient {
  const sdk = new Anthropic({ apiKey })
  return {
    messages: {
      create: (params, options) => sdk.messages.create({ ...(params as Parameters<typeof sdk.messages.create>[0]), stream: false }, options) as never,
      stream: (params, options) => sdk.messages.stream(params as Parameters<typeof sdk.messages.stream>[0], options) as never,
    },
  }
}

/**
 * A Messages client for an organisation's own model gateway (docs/apps.md ›
 * Apps for organisations, AiProvider): any Anthropic-compatible endpoint, with
 * its key (x-api-key) or its token (Authorization: Bearer).
 */
export function gatewayQuickClient(gateway: { url: string; key: string | null; token: string | null }): QuickClient {
  const sdk = new Anthropic({ baseURL: gateway.url, apiKey: gateway.key, authToken: gateway.token })
  return {
    messages: {
      create: (params, options) => sdk.messages.create({ ...(params as Parameters<typeof sdk.messages.create>[0]), stream: false }, options) as never,
      stream: (params, options) => sdk.messages.stream(params as Parameters<typeof sdk.messages.stream>[0], options) as never,
    },
  }
}

/**
 * The JSON Schema for a zod schema, trimmed to what structured outputs accept
 * (the SDK's own transform), or null when the schema can't be expressed (a
 * transform, a refinement): the call then relies on the prompt and the zod check.
 */
export function quickJsonSchema(schema: z.ZodType): Record<string, unknown> | null {
  try {
    const out = zodOutputFormat(schema).schema as Record<string, unknown>
    return out && typeof out === 'object' && Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

/** The first JSON object or array in a reply, tolerating a fenced block or a sentence around it. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  try {
    return JSON.parse(body)
  } catch {
    const start = body.search(/[[{]/)
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
    if (start < 0 || end <= start) throw new Error('The reply held no JSON.')
    return JSON.parse(body.slice(start, end + 1))
  }
}

export interface QuickUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/** Records a quick call's tokens in the usage ledger (engines that answer quick calls use it too). */
export function noteQuickUsage(r: QuickRequest, engine: EngineId, model: string, usage: QuickUsage | undefined): void {
  if (!usage) return
  recordUsage({
    chatId: null,
    companionId: r.companionId ?? '',
    model,
    engine,
    kind: r.kind ?? 'draft',
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
  })
}

const JSON_RULE = 'Reply with one JSON value only, matching the shape the request describes. No Markdown fences and no words before or after it.'

export function createQuickModel(deps: QuickModelDeps): QuickModel {
  const pick = async (): Promise<{ engine: EngineId; reason?: string } | { engine: null; reason: string }> => {
    // The chosen engine first, then the key, then any other engine that is set up.
    const order = [...new Set<EngineId>([deps.engine(), 'api-key', ...(Object.keys(deps.others) as EngineId[])])]
    const reasons: string[] = []
    for (const engine of order) {
      const other = engine === 'api-key' ? null : deps.others[engine]
      if (engine === 'api-key') {
        if (deps.apiKey()) return { engine }
        reasons.push('No Anthropic API key is saved.')
      } else if (other) {
        const state = await other.ready()
        if (state.ok) return { engine }
        reasons.push(state.reason ?? 'The chosen engine is not ready.')
      }
    }
    return { engine: null, reason: reasons[0] ?? 'No engine is ready.' }
  }

  /** One call on the chosen engine; `jsonSchema` constrains the reply where the engine can. */
  const call = async (r: QuickRequest, jsonSchema: Record<string, unknown> | null): Promise<string> => {
    const choice = await pick()
    if (!choice.engine) throw new EngineUnavailableError(choice.reason)
    const model = r.model ?? QUICK_DEFAULT_MODEL
    const engine: string = choice.engine
    if (choice.engine === 'api-key') {
      const key = deps.apiKey()
      if (!key) throw new EngineUnavailableError('No Anthropic API key is saved.')
      const base: QuickCreateParams = { model, max_tokens: r.maxTokens ?? DEFAULT_MAX_TOKENS, system: r.system, messages: [{ role: 'user', content: r.prompt }] }
      const output: QuickOutputConfig = { ...(r.effort ? { effort: r.effort } : {}), ...(jsonSchema ? { format: { type: 'json_schema' as const, schema: jsonSchema } } : {}) }
      const client = deps.client(key)
      let reply: Awaited<ReturnType<QuickClient['messages']['create']>>
      try {
        reply = await client.messages.create(Object.keys(output).length > 0 ? { ...base, output_config: output } : base, { signal: r.signal })
      } catch (err) {
        // A model or schema that refuses output_config (400) still gets the plain call; the zod check stays.
        if (!(err instanceof Anthropic.BadRequestError) || Object.keys(output).length === 0) throw err
        reply = await client.messages.create(base, { signal: r.signal })
      }
      noteQuickUsage(r, 'api-key', reply.model ?? model, reply.usage)
      if (reply.stop_reason === 'refusal') throw new Error('The model declined this request.')
      return reply.content.flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : [])).join('').trim()
    }
    const other = deps.others[engine]
    if (!other) throw new EngineUnavailableError('That engine is not available in this build.')
    return (await other.call(r, model, jsonSchema)).trim()
  }

  const text = (r: QuickRequest): Promise<string> => call(r, null)

  const stream = async (r: QuickRequest, onText: (text: string) => void): Promise<string> => {
    const choice = await pick()
    if (!choice.engine) throw new EngineUnavailableError(choice.reason)
    const key = choice.engine === 'api-key' ? deps.apiKey() : null
    const client = key ? deps.client(key) : null
    if (!client?.messages.stream) {
      const all = await call(r, null)
      onText(all)
      return all
    }
    const model = r.model ?? QUICK_DEFAULT_MODEL
    let all = ''
    let output = 0
    for await (const event of client.messages.stream({ model, max_tokens: r.maxTokens ?? DEFAULT_MAX_TOKENS, system: r.system, messages: [{ role: 'user', content: r.prompt }] }, { signal: r.signal })) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        all += event.delta.text
        onText(event.delta.text)
      } else if (event.type === 'message_delta' && event.usage?.output_tokens) output = event.usage.output_tokens
    }
    noteQuickUsage(r, 'api-key', model, { input_tokens: 0, output_tokens: output })
    return all.trim()
  }

  /** The tool loop on an engine without client tools: each round is one call that answers {"action":"tool",…} or {"action":"reply",…}. */
  const toolLoopByJson = async (r: QuickToolLoopRequest): Promise<{ text: string; history: QuickMessage[] }> => {
    const history = [...r.history]
    const rounds = r.rounds ?? 8
    const names = r.tools.map((t) => t.name)
    const system = [
      r.system,
      '',
      'You can use these tools. Each reply of yours is JSON and nothing else:',
      '- to use a tool: {"action":"tool","tool":"<its name>","input":{…matching its input schema}}; you will see what it returns, then reply again;',
      '- to answer: {"action":"reply","text":"<your answer to the person>"}.',
      'Use one tool per reply.',
      ...r.tools.map((t) => `- ${t.name}: ${t.description} Input schema: ${JSON.stringify(t.input_schema)}`),
    ].join('\n')
    const jsonSchema = {
      type: 'object',
      properties: { action: { type: 'string', enum: ['tool', 'reply'] }, tool: { type: 'string', ...(names.length > 0 ? { enum: names } : {}) }, input: { type: 'object' }, text: { type: 'string' } },
      required: ['action'],
    }
    for (let round = 0; ; round++) {
      const prompt = `${transcriptOf(history)}\n\nWhat do you do next? Reply with JSON only.`
      const reply = await call({ system, prompt, model: r.model, maxTokens: r.maxTokens, signal: r.signal, kind: r.kind ?? 'pack' }, jsonSchema)
      let move: { action?: unknown; tool?: unknown; input?: unknown; text?: unknown } = {}
      try {
        const parsed = extractJson(reply)
        if (parsed && typeof parsed === 'object') move = parsed as typeof move
      } catch {
        move = { action: 'reply', text: reply }
      }
      const tool = move.action === 'tool' && typeof move.tool === 'string' && names.includes(move.tool) ? move.tool : null
      if (!tool) {
        const text = typeof move.text === 'string' ? move.text.trim() : reply.trim()
        history.push({ role: 'assistant', content: [{ type: 'text', text }] })
        return { text, history }
      }
      if (round + 1 >= rounds) return { text: `[The conversation stopped after ${rounds} tool rounds.]`, history }
      const id = `toolu_json_${round}_${Math.random().toString(36).slice(2, 10)}`
      const input = move.input && typeof move.input === 'object' ? move.input : {}
      history.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] })
      const out = await r.onTool(tool, input).catch((err: unknown) => ({ ok: false, text: err instanceof Error ? err.message : String(err) }))
      history.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out.text, ...(out.ok ? {} : { is_error: true }) }] })
    }
  }

  const toolLoop = async (r: QuickToolLoopRequest): Promise<{ text: string; history: QuickMessage[] }> => {
    const choice = await pick()
    if (!choice.engine) throw new EngineUnavailableError(choice.reason)
    if (choice.engine !== 'api-key') return toolLoopByJson(r)
    const key = deps.apiKey()
    if (!key) throw new EngineUnavailableError('No Anthropic API key is saved.')
    const client = deps.client(key)
    const model = r.model ?? QUICK_DEFAULT_MODEL
    const history = [...r.history]
    const rounds = r.rounds ?? 8
    for (let round = 0; ; round++) {
      const reply = await client.messages.create({ model, max_tokens: r.maxTokens ?? DEFAULT_MAX_TOKENS, system: r.system, messages: history, tools: r.tools }, { signal: r.signal })
      noteQuickUsage({ system: r.system, prompt: '', kind: r.kind ?? 'pack' }, 'api-key', reply.model ?? model, reply.usage)
      const blocks: QuickBlock[] = reply.content.flatMap((b): QuickBlock[] =>
        b.type === 'text' && typeof b.text === 'string' ? [{ type: 'text', text: b.text }] : b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string' ? [{ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }] : [],
      )
      history.push({ role: 'assistant', content: blocks })
      const uses = blocks.filter((b): b is Extract<QuickBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      const said = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim()
      if (reply.stop_reason !== 'tool_use' || uses.length === 0) return { text: said, history }
      if (round + 1 >= rounds) return { text: said || `[The conversation stopped after ${rounds} tool rounds.]`, history }
      const results: QuickBlock[] = []
      for (const use of uses) {
        const out = await r.onTool(use.name, use.input).catch((err: unknown) => ({ ok: false, text: err instanceof Error ? err.message : String(err) }))
        results.push({ type: 'tool_result', tool_use_id: use.id, content: out.text, ...(out.ok ? {} : { is_error: true }) })
      }
      history.push({ role: 'user', content: results })
    }
  }

  return {
    structured: (r) => call(r, r.jsonSchema),
    stream,
    toolLoop,
    ready: async () => {
      const choice = await pick()
      return choice.engine ? { ok: true, engine: choice.engine } : { ok: false, engine: null, reason: choice.reason }
    },
    text,
    json: async <T>(r: QuickJsonRequest<T>): Promise<T> => {
      const system = `${r.system}\n\n${JSON_RULE}`
      const { schema, ...request } = r
      // Structured output where the engine can (output_config.format with the key); the zod check below still decides.
      const jsonSchema = quickJsonSchema(schema)
      let prompt = r.prompt
      // One retry with the validation error, then give up.
      for (let attempt = 0; ; attempt++) {
        const reply = await call({ ...request, system, prompt }, jsonSchema)
        let value: unknown
        let problem: string
        try {
          value = extractJson(reply)
          const checked = schema.safeParse(value)
          if (checked.success) return checked.data
          problem = checked.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).slice(0, 5).join('; ')
        } catch (err) {
          problem = err instanceof Error ? err.message : String(err)
        }
        if (attempt >= 1) throw new Error(`The model's reply did not have the expected shape (${problem}).`)
        prompt = `${r.prompt}\n\nYour last reply could not be used: ${problem}. Reply again with JSON only.`
      }
    },
  }
}

/** A tool conversation as text, for an engine that takes one prompt: who said what, which tools ran and what they returned. */
export function transcriptOf(history: readonly QuickMessage[]): string {
  const said = (role: QuickMessage['role'], text: string): string => `${role === 'user' ? 'The person' : 'You'}: ${text}`
  return history
    .map((m) =>
      typeof m.content === 'string'
        ? said(m.role, m.content)
        : m.content
            .map((b) => (b.type === 'text' ? said(m.role, b.text) : b.type === 'tool_use' ? `You used ${b.name} with ${JSON.stringify(b.input)}` : `${b.is_error ? 'The tool failed' : 'The tool returned'}: ${b.content}`))
            .join('\n'),
    )
    .join('\n\n')
}
