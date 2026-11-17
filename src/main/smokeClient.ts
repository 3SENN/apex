/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// An offline stand-in for the Messages API, used only by the smoke test so
// chats can run end to end in real Electron without a key or a network
// request. It answers each message with a short canned reply, streamed in a
// few pieces. `hold()` makes the next reply wait until `release()`, so the
// test can see a chat while it is still working.

import { smokeFilesApi, smokeRichChatReply } from './agent/smokeClientRichChat'

interface StreamRequest {
  model: string
  messages: Array<{ role: string; content: unknown }>
}

/** The newest plain text the user sent, without the browser context block. */
function lastUserText(request: StreamRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === 'user')
  const blocks = Array.isArray(last?.content) ? (last.content as Array<{ type?: string; text?: string }>) : []
  const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string)
  return texts[texts.length - 1] ?? ''
}

// The voice smoke proves a hold's screenshot reached the model
/** Image blocks in the newest user message, wherever the agent put them (top level or inside a tool result). */
function lastUserImages(request: StreamRequest): number {
  const last = [...request.messages].reverse().find((m) => m.role === 'user')
  const count = (v: unknown): number =>
    Array.isArray(v) ? v.reduce<number>((n, b) => n + (b && typeof b === 'object' && (b as { type?: string }).type === 'image' ? 1 : count((b as { content?: unknown } | null)?.content)), 0) : 0
  return count(last?.content)
}

// The meetings smoke proves an attached meeting reached the model
/** Every text block of the newest user message, joined, so attachments placed before the typed text show too. */
function lastUserAllText(request: StreamRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === 'user')
  const blocks = Array.isArray(last?.content) ? (last.content as Array<{ type?: string; text?: string }>) : []
  return blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')
}

/** Canned answers; the fallback just acknowledges the message. */
export function smokeReply(text: string): string {
  const lower = text.toLowerCase()
  if (lower.includes('picnic')) {
    return [
      'Here is a simple plan for Saturday:',
      '',
      // Replies show as plain text until Markdown rendering lands.
      '- Spot: the lawn by the pond has shade after noon.',
      '- Food: wraps, fruit and a cold drink each.',
      '- Bring: a blanket, sun cream and a bag for rubbish.',
      '',
      'Should I check the weather forecast before you go?',
    ].join('\n')
  }
  if (lower.includes('laptop')) {
    return [
      'Both are good picks. The lighter one lasts longer on battery; the other has the brighter screen and more ports.',
      '',
      'For travel I would take the lighter one.',
    ].join('\n')
  }
  return `Noted: “${text.slice(0, 80)}”. This answer comes from the smoke test’s offline stand-in.`
}

/** QuickModel's offline answers: JSON when the system prompt asks for it (summaries), else a short line. */
export function smokeQuickReply(system: string, prompt: string): string {
  // ON-18: the setup conversation (src/main/userProfile.ts), scripted: two questions, then done.
  if (/get to know them so \S+ can set up their workspace/.test(system)) {
    const answers = (prompt.match(/^Person: /gm) ?? []).length
    if (answers === 0) return JSON.stringify({ say: 'Hi! What do you do?', chips: ['🎨 I design apps', '📚 I teach', '💼 I run a business'], multi: false, done: false })
    if (answers === 1) return JSON.stringify({ say: 'Which apps do you use most?', chips: ['🎨 Figma', '📝 Notion', '💬 Slack', '📅 Google Calendar'], multi: true, done: false })
    return JSON.stringify({ say: 'Thanks, I’ll set things up now.', chips: [], multi: false, done: true })
  }
  if (/into their profile/.test(system)) {
    return JSON.stringify({ name: null, work: 'Designs apps', techLevel: 'mixed', interests: ['design', 'meetings'], goals: [], habits: [{ what: 'Plan the week', prompt: 'Plan my week with me.', days: [1], time: '09:00', skill: 'weekly-review' }], apps: ['Figma'], replyStyle: null })
  }
  if (/JSON/.test(system)) {
    return JSON.stringify({
      title: 'Smoke test meeting',
      summary: 'A short offline summary from the smoke test’s stand-in.',
      takeaways: ['The fake helper played both sides.'],
      decisions: [],
      actionItems: [],
      participants: [],
      labels: { mic: 'You', system: 'Others' },
    })
  }
  return `Offline reply: ${prompt.slice(0, 60)}`
}

export interface SmokeClient {
  /** The factory the agent sessions call instead of constructing the SDK client. */
  client(apiKey: string | null): never
  /** The next reply waits until release() (or until the run is stopped). */
  hold(): void
  release(): void
  /** How many requests were answered, to prove nothing went elsewhere. */
  readonly requests: number
  /** Image blocks in the last user message of the newest streamed request. */
  readonly lastImages: number
  /** Every text block of the last user message of the newest streamed request. */
  readonly lastText: string
}

export function createSmokeClient(): SmokeClient {
  let requests = 0
  let lastImages = 0
  let lastText = ''
  let gate: { promise: Promise<void>; open(): void } | null = null
  /** Gates a reply already waits on, opened by release(). */
  const waiting: Array<() => void> = []
  const waitFor = (promise: Promise<void>, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'))
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      void promise.then(resolve)
    })
  const api = {
    files: smokeFilesApi(), // Uploads, generated-file downloads and deletes, offline
    // QuickModel's non-streaming messages.create, answered offline
    messages: {
      create: async (request: { model: string; system?: string; messages: Array<{ role: string; content: unknown }> }) => {
        requests++
        const prompt = typeof request.messages[request.messages.length - 1]?.content === 'string' ? (request.messages[request.messages.length - 1]?.content as string) : ''
        const text = smokeQuickReply(request.system ?? '', prompt)
        return { id: `msg_smoke_${requests}`, type: 'message', role: 'assistant', model: request.model, content: [{ type: 'text', text, citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 200, output_tokens: Math.ceil(text.length / 4) } }
      },
    },
    beta: {
      messages: {
        stream: (request: StreamRequest, { signal }: { signal: AbortSignal }) => {
          requests++
          lastImages = lastUserImages(request)
          lastText = lastUserAllText(request)
          const held = gate
          gate = null
          if (held) waiting.push(held.open)
          // RegisterScenario: scripted text, thinking and tool calls, offline
          const scenario = scenarioReply(request, requests)
          if (scenario) {
            return {
              async *[Symbol.asyncIterator]() {
                if (held) await waitFor(held.promise, signal)
                for (const event of scenario.events) {
                  await waitFor(new Promise((r) => setTimeout(r, 10)), signal)
                  yield event
                }
                if (scenario.error) throw new Error(scenario.error)
              },
              finalMessage: async () => scenario.message,
            }
          }
          // Compaction, code-execution outputs, the extra client tools; see agent/smokeClientRichChat.ts
          const scripted = smokeRichChatReply(request, requests)
          if (scripted) {
            const reply = { id: `msg_smoke_${requests}`, type: 'message', role: 'assistant', model: request.model, content: scripted.content, stop_reason: scripted.stopReason, stop_sequence: null, container: scripted.container ?? null, usage: { input_tokens: 2000, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
            return {
              async *[Symbol.asyncIterator]() {
                if (held) await waitFor(held.promise, signal)
                for (const event of scripted.events) {
                  await waitFor(new Promise((r) => setTimeout(r, 10)), signal)
                  yield event
                }
              },
              finalMessage: async () => reply,
            }
          }
          const text = smokeReply(lastUserText(request))
          const message = {
            id: `msg_smoke_${requests}`,
            type: 'message',
            role: 'assistant',
            model: request.model,
            content: [{ type: 'text', text, citations: null }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1200 + text.length, output_tokens: Math.ceil(text.length / 4), cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
          }
          return {
            async *[Symbol.asyncIterator]() {
              if (held) await waitFor(held.promise, signal)
              // A few pieces, so the reply streams like a real one.
              const pieces = text.match(/[\s\S]{1,48}/g) ?? []
              for (const piece of pieces) {
                await waitFor(new Promise((r) => setTimeout(r, 15)), signal)
                yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }
              }
            },
            finalMessage: async () => message,
          }
        },
      },
    },
  }
  return {
    client: () => api as never,
    hold: () => {
      let open = (): void => undefined
      const promise = new Promise<void>((resolve) => {
        open = resolve
      })
      gate = { promise, open }
    },
    release: () => {
      // A hold that no request picked up yet is simply dropped.
      gate = null
      for (const open of waiting.splice(0)) open()
    },
    get requests() {
      return requests
    },
    get lastImages() {
      return lastImages
    },
    get lastText() {
      return lastText
    },
  }
}

// Scripted model behaviour for the agent smoke checks, so no request leaves the machine
/** One scripted step of the offline client's reply to a matching message. */
export type ScenarioStep =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  /** A client or browser tool call; the next step runs after its result comes back. */
  | { kind: 'tool'; name: string; input: unknown; browser?: boolean }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | { kind: 'error'; message: string }

const scenarios: Array<{ trigger: RegExp; steps: ScenarioStep[] }> = []

/** Scripts the reply to any message matching `trigger`; the latest registration wins. The offline client replays them. */
export function registerScenario(trigger: RegExp, steps: ScenarioStep[]): void {
  scenarios.unshift({ trigger, steps })
}

/** The scripted steps for a message, or null for the canned reply. */
export function scenarioFor(text: string): ScenarioStep[] | null {
  return scenarios.find((s) => s.trigger.test(text))?.steps ?? null
}

/** Tests and smoke runs only: forget every scenario. */
export function resetScenarios(): void {
  scenarios.length = 0
}

type Block = { type?: string; text?: string }
const blocksOf = (m: { content: unknown } | undefined): Block[] => (Array.isArray(m?.content) ? (m.content as Block[]) : typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : [])

/**
 * The scripted reply to a request, or null. The newest typed message picks
 * the scenario; each tool result since then moves one segment on, so a
 * scenario plays as text and thinking up to a tool call, waits for its
 * result, and goes on with the steps after it.
 */
export function scenarioReply(request: StreamRequest, n: number): { message: Record<string, unknown>; events: unknown[]; error: string | null } | null {
  let typed = -1
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]
    const blocks = blocksOf(m)
    if (m?.role === 'user' && blocks.some((b) => b.type === 'text') && !blocks.some((b) => b.type === 'tool_result')) {
      typed = i
      break
    }
  }
  if (typed < 0) return null
  // The typed words can come after context blocks (the page, the date), so each block is tried too.
  const texts = blocksOf(request.messages[typed]).filter((b) => b.type === 'text').map((b) => b.text ?? '')
  const steps = scenarioFor(texts.join('\n')) ?? texts.map((t) => scenarioFor(t)).find((s) => s !== null) ?? null
  if (!steps) return null
  const segment = request.messages.slice(typed + 1).filter((m) => m.role === 'user' && blocksOf(m).some((b) => b.type === 'tool_result')).length
  // Segments end at each tool call.
  const segments: ScenarioStep[][] = [[]]
  for (const step of steps) {
    segments[segments.length - 1]?.push(step)
    if (step.kind === 'tool') segments.push([])
  }
  const mine = segments[segment] ?? [{ kind: 'text', text: 'Done.' }]
  const content: unknown[] = []
  const events: unknown[] = []
  let usage = { input_tokens: 1500, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  let error: string | null = null
  let stop = 'end_turn'
  for (const step of mine) {
    const index = content.length
    if (step.kind === 'text') {
      content.push({ type: 'text', text: step.text, citations: null })
      for (const piece of step.text.match(/[\s\S]{1,48}/g) ?? []) events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
    } else if (step.kind === 'thinking') {
      content.push({ type: 'thinking', thinking: step.text, signature: 'smoke' })
      events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: step.text } })
    } else if (step.kind === 'tool') {
      content.push({ type: 'tool_use', id: `toolu_smoke_${n}_${index}`, name: step.name, input: step.input, ...(step.browser ? { toolset_name: 'browser' } : {}) })
      stop = 'tool_use'
    } else if (step.kind === 'usage') {
      usage = { ...usage, input_tokens: step.inputTokens, output_tokens: step.outputTokens }
    } else {
      error = step.message
    }
  }
  return { message: { id: `msg_smoke_${n}`, type: 'message', role: 'assistant', model: request.model, content, stop_reason: stop, stop_sequence: null, usage }, events, error }
}
