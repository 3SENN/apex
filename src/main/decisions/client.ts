/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { z } from 'zod'
import {
  DECISION_LIMITS,
  DECISION_MODEL_FAMILIES,
  DECISION_MODEL_SUFFIX,
  dialectOf,
  type DecisionAnswer,
  type DecisionCatalogModel,
  type DecisionDialect,
  type DecisionErrorCode,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResult,
} from '@shared/decisions'

// The decision client (DC-02, DC-19): one POST that TypeSafe, OpenRouter,
// gateways such as Experiential Labs and self-hosted servers (Kev and the
// like) all answer the same way with TypeSafe's System One request, and
// OpenAI's Decisions request for GPT-6 Luna, which it translates both ways so
// Apex's questions and readers stay one shape. No SDK: the request is small,
// and a plain fetch keeps the timeout, the abort and the errors in Apex's
// hands. A 429 or 529 is retried once after a short pause; everything else
// fails at once so the caller's rule answers instead.

export class DecisionError extends Error {
  readonly code: DecisionErrorCode
  /** A rate limit's Retry-After, when the provider sent one. */
  readonly retryAfterMs: number | null

  constructor(code: DecisionErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'DecisionError'
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export interface Endpoint {
  url: string
  key: string | null
  model: string
  /** The request the model takes (default System One). */
  dialect?: DecisionDialect
}

export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    signal: AbortSignal
  },
) => Promise<{
  status: number
  ok: boolean
  headers?: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
}>

const probabilities = z.record(z.string(), z.number().min(0).max(1))

const answerSchema: z.ZodType<DecisionAnswer> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    confidence: z.number().min(0).max(1),
    probabilities,
  }),
  z.object({
    type: z.literal('score'),
    score: z.number().min(0),
    confidence: z.number().min(0).max(1),
    probabilities,
  }),
])

const replySchema = z.object({
  model: z.string().max(120).optional(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({ input_tokens: z.number().int().min(0).optional() })
    .partial()
    .optional(),
})

/** An address may be a server's root or a full endpoint; either way, the endpoint for `dialect`. */
export function endpointUrl(url: string, dialect: DecisionDialect = 'systemone'): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  const base = /\/(systemone|decisions)$/.test(trimmed) ? trimmed.replace(/\/(systemone|decisions)$/, '') : /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`
  return `${base}/${dialect}`
}

/**
 * The endpoint for an address and model. A provider with one request (OpenRouter's Decisions router
 * takes System One's at /api/alpha/decisions) is asked at its address as it is; 'auto' (a gateway that
 * serves both, your own server) picks the request by model and the path to match.
 */
export function endpointFor(url: string, key: string | null, model: string, dialect: DecisionDialect | 'auto' = 'auto'): Endpoint {
  if (dialect !== 'auto') return { url: url.trim().replace(/\/+$/, ''), key, model, dialect }
  const picked = dialectOf(model, url)
  return { url: endpointUrl(url, picked), key, model, dialect: picked }
}

/** Retry-After as seconds or an HTTP date, in ms; null when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/** The state as the provider takes it: text stays text, an object is sent as JSON, both held to Apex's size limit. */
export function stateOf(state: DecisionRequest['state']): DecisionRequest['state'] {
  if (typeof state === 'string') return state.slice(0, DECISION_LIMITS.stateChars)
  const json = JSON.stringify(state)
  return json.length <= DECISION_LIMITS.stateChars ? state : json.slice(0, DECISION_LIMITS.stateChars)
}

// ── OpenAI's Decisions request (DC-19) ──
// Its questions are a list with names; a yes or no is a `predicate` with a
// `probability`, options are `choices` with `value`s, levels are `levels` with
// `label`s, and its probabilities come as lists. A `refusal` answer reads as
// no answer at all (every reader is unsure of it), so the rule decides.

const LEVEL_LABEL_MAX = 100

function decisionsQuestion(name: string, q: DecisionQuestion): Record<string, unknown> {
  if (q.type === 'noul') {
    const meaning = [q.criteria?.true ? `Yes means: ${q.criteria.true}` : '', q.criteria?.false ? `No means: ${q.criteria.false}` : ''].filter(Boolean).join('\n')
    return {
      type: 'predicate',
      name,
      instructions: meaning ? `${q.instructions}\n${meaning}` : q.instructions,
    }
  }
  if (q.type === 'choice')
    return {
      type: 'choice',
      name,
      instructions: q.instructions,
      choices: Object.entries(q.criteria).map(([value, description]) => (description ? { value, description } : { value })),
    }
  return {
    type: 'score',
    name,
    instructions: q.instructions,
    levels: q.criteria.map((text) => (text.length <= LEVEL_LABEL_MAX ? { label: text } : { label: levelLabel(text), description: text })),
  }
}

function levelLabel(text: string): string {
  return text.length <= LEVEL_LABEL_MAX ? text : `${text.slice(0, LEVEL_LABEL_MAX - 1)}…`
}

function decisionsBody(model: string, request: DecisionRequest): Record<string, unknown> {
  const state = stateOf(request.state)
  return {
    model,
    input: typeof state === 'string' ? state : JSON.stringify(state),
    questions: Object.entries(request.questions).map(([name, q]) => decisionsQuestion(name, q)),
  }
}

const listed = z
  .array(
    z
      .object({
        value: z.union([z.string(), z.number(), z.boolean()]),
        label: z.string().optional(),
        probability: z.number().min(0).max(1),
      })
      .passthrough(),
  )
  .max(DECISION_LIMITS.choices)
const decisionsAnswer = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('predicate'),
    name: z.string().nullish(),
    probability: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('choice'),
    name: z.string().nullish(),
    choice: z.union([z.string(), z.boolean()]),
    confidence: z.number().min(0).max(1),
    probabilities: listed,
  }),
  z.object({
    type: z.literal('score'),
    name: z.string().nullish(),
    score: z.number().min(0),
    confidence: z.number().min(0).max(1),
    probabilities: listed,
  }),
  z.object({ type: z.literal('refusal'), name: z.string().nullish() }),
])
const decisionsReply = z.object({
  model: z.string().max(120).optional(),
  answers: z.array(z.unknown()).max(2_000),
  usage: z
    .object({ input_tokens: z.number().int().min(0).optional() })
    .partial()
    .optional(),
})

/** A Decisions answer in System One's shape; a refusal (or an unreadable answer) as an even spread nobody is sure of. */
function fromDecisions(raw: unknown, question: DecisionQuestion): unknown {
  const answer = decisionsAnswer.safeParse(raw)
  const spread = (keys: string[]): Record<string, number> => Object.fromEntries(keys.map((k) => [k, 1 / keys.length]))
  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.type === 'score' ? question.criteria.map((_, i) => String(i)) : []
  if (!answer.success || answer.data.type === 'refusal') {
    if (question.type === 'noul') return { type: 'noul', noul: 0.5 }
    return question.type === 'choice'
      ? {
          type: 'choice',
          choice: keys[0],
          confidence: 0,
          probabilities: spread(keys),
        }
      : {
          type: 'score',
          score: (keys.length - 1) / 2,
          confidence: 0,
          probabilities: spread(keys),
        }
  }
  const a = answer.data
  if (a.type === 'predicate') return { type: 'noul', noul: a.probability }
  if (a.type === 'choice')
    return {
      type: 'choice',
      choice: String(a.choice),
      confidence: a.confidence,
      probabilities: Object.fromEntries(a.probabilities.map((p) => [String(p.value), p.probability])),
    }
  // A level is matched by the label Apex sent, not the server's own numbering (which may start at 1); the score follows from that.
  // Without a label, the value counts only as a level index Apex knows.
  const labels = question.type === 'score' ? question.criteria.map(levelLabel) : []
  const indexOf = (p: z.infer<typeof listed>[number]): number => (typeof p.label === 'string' ? labels.indexOf(p.label) : typeof p.value === 'number' && Number.isInteger(p.value) && p.value >= 0 && p.value < labels.length ? p.value : -1)
  const levels = a.probabilities.map((p) => ({
    i: indexOf(p),
    p: p.probability,
  }))
  if (levels.some((l) => l.i === -1)) return fromDecisions(null, question)
  return {
    type: 'score',
    score: levels.reduce((sum, l) => sum + l.i * l.p, 0),
    confidence: a.confidence,
    probabilities: Object.fromEntries(levels.map((l) => [String(l.i), l.p])),
  }
}

/** Either reply as System One's: answers keyed by question, the model, the tokens read. Null when it can't be read. */
function readReply(
  raw: unknown,
  request: DecisionRequest,
  dialect: DecisionDialect,
): {
  model?: string
  answers: Record<string, unknown>
  inputTokens: number
} | null {
  if (dialect === 'systemone') {
    const reply = replySchema.safeParse(raw)
    return reply.success
      ? {
          ...(reply.data.model ? { model: reply.data.model } : {}),
          answers: reply.data.answers,
          inputTokens: reply.data.usage?.input_tokens ?? 0,
        }
      : null
  }
  const reply = decisionsReply.safeParse(raw)
  if (!reply.success) return null
  const list = reply.data.answers
  const nameOf = (a: unknown): string | null => (a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string' ? (a as { name: string }).name : null)
  const byName = new Map(list.map((a) => [nameOf(a), a]))
  // Answers come back in question order; a name, when given, settles which is which, so a named answer never stands in for another question.
  const answers = Object.fromEntries(Object.entries(request.questions).map(([key, q], i) => [key, fromDecisions(byName.get(key) ?? (nameOf(list[i]) === null ? list[i] : undefined), q)]))
  return {
    ...(reply.data.model ? { model: reply.data.model } : {}),
    answers,
    inputTokens: reply.data.usage?.input_tokens ?? 0,
  }
}

function codeOf(status: number): DecisionErrorCode {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 429) return 'rate-limited'
  if (status === 529 || status === 503) return 'overloaded'
  if (status === 400 || status === 404 || status === 413 || status === 415 || status === 422) return 'bad-request'
  return 'failed'
}

const RETRY_PAUSE_MS = 250

/** One decision request in the endpoint's dialect, read back as System One's answers. */
export async function requestDecision(
  fetchImpl: FetchLike,
  endpoint: Endpoint,
  request: DecisionRequest,
  options: {
    timeoutMs: number
    signal?: AbortSignal
    now?: () => number
    onRateLimit?(): void
  },
): Promise<DecisionResult> {
  // Stopped before it was sent (a chat or a hedged twin cancelled): nothing goes out.
  if (options.signal?.aborted) throw new DecisionError('timeout', 'The decision was stopped before it was sent.')
  const now = options.now ?? Date.now
  const started = now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (endpoint.key) headers.authorization = `Bearer ${endpoint.key}`
  const dialect = endpoint.dialect ?? 'systemone'
  const body = JSON.stringify(
    dialect === 'decisions'
      ? decisionsBody(endpoint.model, request)
      : {
          model: endpoint.model,
          state: stateOf(request.state),
          questions: request.questions,
        },
  )
  try {
    let res = await post()
    if (res.status === 429) options.onRateLimit?.()
    if ((res.status === 429 || res.status === 529) && options.timeoutMs - (now() - started) > RETRY_PAUSE_MS * 2) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS))
      // Stopped during the pause (its twin answered, or it met the limit beside it): no retry goes out.
      if (controller.signal.aborted) throw new DecisionError('timeout', 'The decision was stopped before its retry.')
      res = await post()
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300)
      throw new DecisionError(codeOf(res.status), `The decision model answered ${res.status}${detail ? `: ${detail}` : ''}`, res.status === 429 ? retryAfterMs(res.headers?.get('retry-after')) : null)
    }
    const reply = readReply(await res.json().catch(() => null), request, dialect)
    if (!reply) throw new DecisionError('bad-reply', `The decision model sent a reply ${BRAND_NAME} can’t read.`)
    const answers: Record<string, DecisionAnswer> = {}
    for (const key of Object.keys(request.questions)) {
      const question = request.questions[key]!
      const raw = reply.answers[key]
      // A model that declines a question answers "refusal" (OpenRouter's router): nobody is sure of it, so the rule decides.
      const refused = !!raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'refusal'
      const answer = answerSchema.safeParse(refused ? fromDecisions(null, question) : raw)
      if (!answer.success || answer.data.type !== question.type) throw new DecisionError('bad-reply', `The decision model left out or mistyped the answer to “${key}”.`)
      // A choice must be one of the question's options and a score within its levels, whatever the server sends.
      const own =
        answer.data.type === 'choice' ? question.type === 'choice' && Object.hasOwn(question.criteria, answer.data.choice) : answer.data.type === 'score' ? question.type === 'score' && answer.data.score <= question.criteria.length - 1 : true
      if (!own) throw new DecisionError('bad-reply', `The decision model answered “${key}” with something it wasn’t offered.`)
      answers[key] = answer.data
    }
    return {
      answers,
      model: reply.model ?? endpoint.model,
      source: 'model',
      ms: now() - started,
      inputTokens: reply.inputTokens,
    }
  } catch (err) {
    if (err instanceof DecisionError) throw err
    if (controller.signal.aborted) throw new DecisionError('timeout', `The decision model took longer than ${options.timeoutMs} ms.`)
    throw new DecisionError('offline', err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }

  function post(): ReturnType<FetchLike> {
    return fetchImpl(endpoint.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
  }
}

const modelsSchema = z.object({
  data: z.array(z.object({ id: z.string().max(200) }).passthrough()).max(5_000),
})

/** Where a server of your own lists its models: next to its decision endpoint. */
export function modelsUrlOf(endpointUrl: string): string {
  return endpointUrl.replace(/\/(systemone|decisions)$/, '/models')
}

/** USD per million tokens read, from the shapes gateways list prices in; null when it doesn't say. */
function priceOf(m: Record<string, unknown>): number | null {
  const pricing = m.pricing as Record<string, unknown> | undefined
  if (!pricing || typeof pricing !== 'object') return null
  // A price is a number or a number as text, never empty or below zero (OpenRouter's -1 means it varies).
  const read = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null
    if (typeof v !== 'string' || !v.trim()) return null
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : null
  }
  // Experiential Labs: nano-dollars per million tokens.
  const nano = read(pricing.input_nano_usd_per_million_tokens)
  if (nano !== null) return nano / 1e9
  // OpenRouter: dollars per token, as text.
  const perToken = read(pricing.prompt)
  return perToken === null ? null : Math.round(perToken * 1e6 * 1e6) / 1e6
}

function zdrOf(m: Record<string, unknown>): boolean | null {
  const policy = m.data_policy as { zdr?: unknown } | undefined
  return policy && typeof policy.zdr === 'boolean' ? policy.zdr : null
}

function isDecisionModel(m: Record<string, unknown>, id: string): boolean {
  const out = (m.architecture as { output_modalities?: unknown } | undefined)?.output_modalities
  if (Array.isArray(out) && out.includes('decisions')) return true
  return DECISION_MODEL_FAMILIES.test(id) || DECISION_MODEL_SUFFIX.test(id)
}

/**
 * The decision models a provider lists at its models address: all of them
 * where the list holds decision models only (OpenRouter's), otherwise those
 * marked as decision models or named like one (Jev, Kev, Clef, Laya, a
 * `-decisions` id), with the price and data policy where it says. Empty
 * when it lists none; null when the list can't be read.
 */
export async function listModels(fetchImpl: FetchLike, where: { url: string; key: string | null; decisionsOnly?: boolean }, options: { timeoutMs: number }): Promise<DecisionCatalogModel[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs)
  const headers: Record<string, string> = {}
  if (where.key) headers.authorization = `Bearer ${where.key}`
  try {
    const res = await fetchImpl(where.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    if (!res.ok) return null
    const list = modelsSchema.safeParse(await res.json().catch(() => null))
    if (!list.success) return null
    const seen = new Map<string, DecisionCatalogModel>()
    for (const m of list.data.data as Array<Record<string, unknown> & { id: string }>) {
      if (seen.has(m.id) || !(where.decisionsOnly || isDecisionModel(m, m.id))) continue
      const price = /:free$/.test(m.id) ? 0 : priceOf(m)
      seen.set(m.id, { id: m.id, price, zdr: zdrOf(m) })
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
