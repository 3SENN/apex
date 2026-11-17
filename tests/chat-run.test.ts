/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { ChatAgentEvent, QueuedMessage } from '@shared/chats'
import type { AgentEvent, ElementDescription } from '@shared/ipc'
import { AgentHost } from '../src/main/agent/host'
import { classifyApiError, classifySaveError, retryAfterMs } from '../src/main/agent/errors'
import { newestPage, olderPage, pageStart } from '../src/main/agent/paging'
import { chatPreview, plainSnippet } from '../src/main/agent/preview'
import { RunGate, TabNotes, noteBlock, INTERRUPTED } from '../src/main/agent/runControl'
import { ChatStore } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import { ConnectorStore, SkillStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'

// The run control against a scripted stand-in for the Messages API:
// queue, interrupt, continue, stop, pause, notes, paging, the offline hold
// and typed errors. No request leaves the machine.

interface Turn {
  text?: string
  tools?: Array<{ name: string; input: unknown; client?: boolean }>
  server?: Array<{ name: string; input: unknown; results: number }>
  stop?: string
  gate?: Promise<void>
  fail?: Error
}

interface Request {
  model: string
  messages: Array<{ role: string; content: unknown }>
}

function abortable(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('aborted'))
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    void gate.then(resolve)
  })
}

function fakeClient(script: (request: Request, n: number) => Turn) {
  const requests: Request[] = []
  const client = {
    beta: {
      messages: {
        stream: (request: Request, { signal }: { signal: AbortSignal }) => {
          requests.push(structuredClone(request))
          const turn = script(request, requests.length)
          const content: unknown[] = []
          for (const [i, s] of (turn.server ?? []).entries()) {
            content.push({ type: 'server_tool_use', id: `srv_${requests.length}_${i}`, name: s.name, input: s.input })
            content.push({ type: 'web_search_tool_result', tool_use_id: `srv_${requests.length}_${i}`, content: Array.from({ length: s.results }, () => ({ type: 'web_search_result' })) })
          }
          if (turn.text) content.push({ type: 'text', text: turn.text, citations: null })
          for (const [i, tool] of (turn.tools ?? []).entries()) {
            content.push({ type: 'tool_use', id: `toolu_${requests.length}_${i}`, name: tool.name, input: tool.input, ...(tool.client ? {} : { toolset_name: 'browser' }) })
          }
          const message = {
            id: `msg_${requests.length}`,
            type: 'message',
            role: 'assistant',
            model: request.model,
            content,
            stop_reason: turn.stop ?? (turn.tools?.length ? 'tool_use' : 'end_turn'),
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: null },
          }
          return {
            async *[Symbol.asyncIterator]() {
              for (const [i, s] of (turn.server ?? []).entries()) yield { type: 'content_block_start', index: i, content_block: { type: 'server_tool_use', id: `srv_${requests.length}_${i}`, name: s.name, input: {} } }
              if (turn.gate) await abortable(turn.gate, signal)
              if (turn.fail) throw turn.fail
              if (turn.text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } }
            },
            finalMessage: async () => message,
          }
        },
      },
    },
  }
  return { client: () => client as never, requests }
}

const buyButton: ElementDescription = { role: 'button', name: 'Buy now', tag: 'button', inputType: null, isPassword: false, isPaymentField: false, formSubmitName: null, inForm: false, formHasPaymentFields: false }
const passwordField: ElementDescription = { ...buyButton, role: 'textbox', name: 'Password', tag: 'input', inputType: 'password', isPassword: true }

const PAGE = { x: 0, y: 0, width: 1000, height: 800 }

function fakeTabs() {
  const wc = { getURL: () => 'https://shop.example/', getTitle: () => 'Shop', isDestroyed: () => false, isLoading: () => false, getZoomFactor: () => 1, debugger: { isAttached: () => true, attach: () => undefined, sendCommand: async () => ({}) } }
  const tabs = [{ id: 't1', internalUrl: null, view: { webContents: wc, getBounds: () => PAGE } }, { id: 't2', internalUrl: null, view: { webContents: wc, getBounds: () => PAGE } }]
  const closed: string[] = []
  const manager = {
    find: (id: string) => tabs.find((t) => t.id === id),
    active: () => tabs[0],
    activeId: () => 't1',
    rail: () => null,
    activate: () => undefined,
    all: () => tabs,
    isHidden: () => false,
    isChromeDrawn: () => false,
    info: (tab: { id: string }) => ({ id: tab.id, title: `Title ${tab.id}`, url: `https://${tab.id}.example/` }),
    contentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    setAgentControlled: () => undefined,
    setNeedsInput: () => undefined,
    closeMany: (ids: readonly string[]) => {
      closed.push(...ids)
      return ids.length
    },
  }
  return { tabs: manager as unknown as TabManager, closed }
}

const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious.', look: DEFAULT_LOOK }]

function setup(script: (request: Request, n: number) => Turn, options: { confirm?: boolean; focus?: ElementDescription | null; online?: { value: boolean; listeners: Array<(on: boolean) => void> }; memoryGate?: Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-run-'))
  const companions = new CompanionStore(dir, { presets: () => presets })
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const events: ChatAgentEvent[] = []
  const queues: Array<[string, QueuedMessage[]]> = []
  const memoryCalls: unknown[] = []
  const { tabs, closed } = fakeTabs()
  const api = fakeClient(script)
  const online = options.online
  const host: AgentHost = new AgentHost({
    settings: {
      get: () => ({ model: 'claude-opus-5-5', effort: 'high', webTools: true, memory: true, confirmConsequentialActions: options.confirm ?? true }),
      view: () => ({ hasApiKey: true }),
      apiKey: () => 'test-key',
    },
    tabs,
    bridge: {
      request: async (_wc: unknown, command: { op: string }) => {
        if (command.op === 'resolveRef') return { ...buyButton, x: 5, y: 5 }
        if (command.op === 'describeFocus') return options.focus ?? null
        if (command.op === 'viewport') return { width: 1000, height: 800, dpr: 1 }
        return null
      },
    } as never,
    memory: {
      execute: async (input) => {
        memoryCalls.push(input)
        if (options.memoryGate) await options.memoryGate
        return 'ok'
      },
    },
    connectors: new ConnectorStore(dir),
    skills: new SkillStore(dir),
    chats,
    companions,
    presets: { personality: () => undefined },
    client: api.client,
    emit: (event) => {
      events.push(event)
      if (event.event.type === 'approval') {
        const { approvalId } = event.event
        setTimeout(() => host.approve(event.chatId, approvalId, true), 5)
      }
    },
    onTabOwners: () => undefined,
    onQueue: (chatId, queued) => queues.push([chatId, queued]),
    ...(online
      ? {
          online: {
            isOnline: () => online.value,
            onChange: (fn: (on: boolean) => void) => {
              online.listeners.push(fn)
              return () => undefined
            },
          },
        }
      : {}),
  })
  const eventsOf = (chatId: string): AgentEvent[] => events.filter((e) => e.chatId === chatId).map((e) => e.event)
  return { host, chats, events, eventsOf, queues, requests: api.requests, closed, memoryCalls }
}

async function until(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function gate(): { promise: Promise<void>; open(): void } {
  let open = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** Every tool_use in the history has a tool_result in the next message. */
function historyIsValid(messages: Array<{ role: string; content: unknown }>): boolean {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue
    const ids = (m.content as Array<{ type: string; id?: string }>).filter((b) => b.type === 'tool_use').map((b) => b.id)
    if (ids.length === 0) continue
    const next = messages[i + 1]
    const answered = new Set(Array.isArray(next?.content) ? (next.content as Array<{ type: string; tool_use_id?: string }>).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : [])
    if (ids.some((id) => !answered.has(id))) return false
  }
  return true
}

const users = (log: AgentEvent[]): string[] => log.flatMap((e) => (e.type === 'user-message' ? [e.text] : []))

describe('queue (CH-15)', () => {
  it('sends queued messages in order, keeps edits, and sends one now by interrupting', async () => {
    const first = gate()
    const t = setup((_r, n) => (n === 1 ? { text: 'First.', gate: first.promise } : { text: `Reply ${n}.` }))
    const id = t.host.start('One')
    await until(() => t.requests.length === 1, 'first request')
    t.host.send(id, 'Two')
    t.host.send(id, 'Three')
    const [two, three] = t.host.view(id).queued
    t.host.editQueued(id, three?.id ?? '', 'Three, edited')
    t.host.sendNow(id, three?.id ?? '')
    await until(() => !t.host.isRunning(id) && t.host.view(id).queued.length === 0 && t.requests.length === 3, 'drained')
    expect(two).toBeDefined()
    // Three jumped the queue by interrupting One; Two still went out after it.
    expect(users(t.host.view(id).log)).toEqual(['One', 'Three, edited', 'Two'])
    expect(t.eventsOf(id).some((e) => e.type === 'stopped' && e.reason === 'interrupt')).toBe(true)
  })

  it('holds the queue on a failed send and goes on after retry', async () => {
    const hold = gate()
    let fail = true
    const t = setup((_r, n) => (n === 1 ? { text: 'ok', gate: hold.promise } : fail && n === 2 ? { fail: new Anthropic.InternalServerError(500, { type: 'error', error: { type: 'api_error', message: 'boom' } }, 'boom', new Headers()) } : { text: `Reply ${n}.` }))
    const id = t.host.start('One')
    await until(() => t.host.isRunning(id))
    t.host.send(id, 'Two')
    t.host.send(id, 'Three')
    hold.open()
    await until(() => !t.host.isRunning(id) && t.host.view(id).queued[0]?.failed !== undefined, 'failed head')
    const queued = t.host.view(id).queued
    expect(queued.map((q) => q.text)).toEqual(['Three'])
    expect(queued[0]?.failed).toMatch(/unavailable/i)
    fail = false
    t.host.retryQueued(id, queued[0]?.id ?? '')
    await until(() => !t.host.isRunning(id) && t.host.view(id).queued.length === 0 && t.requests.length === 3, 'retried')
    expect(users(t.host.view(id).log)).toEqual(['One', 'Two', 'Three'])
    const error = t.eventsOf(id).find((e) => e.type === 'error')
    expect(error).toMatchObject({ code: 'unavailable' })
  })
})

describe('interrupt (CH-16)', () => {
  it('answers every started step so the history stays valid, then sends the new message', async () => {
    const slow = gate()
    const t = setup(
      (_r, n) => (n === 1 ? { tools: [{ name: 'memory', input: { command: 'view', path: '/memories' }, client: true }, { name: 'list_tabs', input: {} }, { name: 'list_tabs', input: {} }] } : { text: `Reply ${n}.` }),
      { memoryGate: slow.promise },
    )
    const id = t.host.start('Do three things')
    await until(() => t.memoryCalls.length === 1, 'first step running')
    t.host.interrupt(id, 'Actually, stop and do this')
    expect(t.eventsOf(id).some((e) => e.type === 'interrupting')).toBe(true)
    slow.open()
    await until(() => !t.host.isRunning(id) && t.requests.length === 2, 'redirected')
    const sent = t.requests[1]?.messages ?? []
    expect(historyIsValid(sent)).toBe(true)
    const results = (sent[2]?.content ?? []) as Array<{ tool_use_id: string; content: unknown }>
    expect(results).toHaveLength(3)
    expect(results.slice(1).every((r) => r.content === INTERRUPTED)).toBe(true)
    expect(users(t.host.view(id).log)).toEqual(['Do three things', 'Actually, stop and do this'])
    // 'interrupting' is live only; the saved log keeps the stop mark.
    const saved = t.chats.load(id).log
    expect(saved.some((e) => e.type === 'interrupting')).toBe(false)
    expect(saved.some((e) => e.type === 'stopped' && e.reason === 'interrupt')).toBe(true)
  })

  it('cuts a streaming turn without adding it to the history', async () => {
    const hold = gate()
    const t = setup((_r, n) => (n === 1 ? { text: 'never', gate: hold.promise } : { text: 'Redirected.' }))
    const id = t.host.start('Long answer')
    // Interrupt once the reply is streaming, not before its first step.
    await until(() => t.requests.length === 1, 'first request')
    t.host.interrupt(id, 'Shorter please')
    await until(() => !t.host.isRunning(id) && t.requests.length === 2, 'second request')
    const sent = t.requests[1]?.messages ?? []
    expect(sent.map((m) => m.role)).toEqual(['user', 'user'])
    expect(t.chats.summary(id)?.status).toBe('finished')
  })

  it('is a plain send while idle', async () => {
    const t = setup(() => ({ text: 'Hi.' }))
    const id = t.host.start('Hello')
    await until(() => t.chats.summary(id)?.status === 'finished')
    t.host.interrupt(id, 'Again')
    await until(() => t.requests.length === 2 && !t.host.isRunning(id))
    expect(users(t.host.view(id).log)).toEqual(['Hello', 'Again'])
  })
})

describe('step limit and continue (CH-14)', () => {
  it('shows a step-limit notice and continues the same run without a new message', async () => {
    let steps = 0
    const t = setup(() => {
      steps++
      return steps <= 60 ? { tools: [{ name: 'list_tabs', input: {} }] } : { text: 'All done.' }
    })
    const id = t.host.start('A very long task')
    await until(() => t.chats.summary(id)?.status === 'finished', 'step limit')
    expect(t.eventsOf(id).find((e) => e.type === 'step-limit')).toMatchObject({ steps: 60 })
    expect(t.eventsOf(id).some((e) => e.type === 'error')).toBe(false)
    expect(t.chats.summary(id)?.needsInput).toBe(true)
    t.host.continue(id)
    await until(() => t.requests.length === 61 && !t.host.isRunning(id), 'continued')
    expect(users(t.host.view(id).log)).toEqual(['A very long task'])
    expect(t.host.view(id).log.some((e) => e.type === 'text-delta' && e.text === 'All done.')).toBe(true)
    expect(() => t.host.continue(id)).toThrow(/nothing to continue/)
  })
})

describe('stop (CH-17)', () => {
  it('marks the run stopped and ends running server steps with it', async () => {
    const hold = gate()
    const t = setup(() => ({ server: [{ name: 'web_search', input: { query: 'kettles' }, results: 3 }], text: 'x', gate: hold.promise }))
    const id = t.host.start('Search')
    await until(() => t.eventsOf(id).some((e) => e.type === 'tool' && e.state === 'running'), 'search running')
    const running = t.eventsOf(id).find((e) => e.type === 'tool')
    expect(running).toMatchObject({ kind: 'web-search', startedAt: expect.any(Number) })
    t.host.stop(id)
    await until(() => !t.host.isRunning(id), 'stopped')
    const tools = t.eventsOf(id).filter((e) => e.type === 'tool')
    expect(tools.at(-1)).toMatchObject({ state: 'error', detail: 'Stopped', endedAt: expect.any(Number) })
    expect(t.eventsOf(id).find((e) => e.type === 'stopped')).toMatchObject({ reason: 'user' })
    expect(t.chats.summary(id)).toMatchObject({ status: 'idle', needsInput: false })
  })

  it('fills the step fields for browser and server steps', async () => {
    const t = setup((_r, n) => (n === 1 ? { server: [{ name: 'web_search', input: { query: 'tea' }, results: 2 }], tools: [{ name: 'list_tabs', input: {} }] } : { text: 'Done.' }))
    const id = t.host.start('Look around')
    await until(() => t.chats.summary(id)?.status === 'finished')
    const tools = t.host.view(id).log.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool')
    expect(tools[0]).toMatchObject({ kind: 'web-search', state: 'done', result: '2 results', input: '{"query":"tea"}' })
    expect(tools[1]).toMatchObject({ kind: 'tabs', state: 'done', startedAt: expect.any(Number), endedAt: expect.any(Number) })
    expect(tools[1]?.result).toBeTruthy()
  })
})

describe('pause, notes and the chat mode', () => {
  it('holds tool steps while paused and carries notes into the next result', async () => {
    const slow = gate()
    const t = setup(
      (_r, n) => (n === 1 ? { tools: [{ name: 'switch_tab', input: { tab_id: 't1' } }, { name: 'memory', input: { command: 'view', path: '/memories' }, client: true }, { name: 'list_tabs', input: {} }] } : { text: 'ok' }),
      { memoryGate: slow.promise },
    )
    const id = t.host.start('Go')
    await until(() => t.host.tabOwners().t1 === id && t.memoryCalls.length === 1, 'owns t1 and is on the memory step')
    t.host.pause(id)
    expect(t.host.isPaused(id)).toBe(true)
    t.host.noteForNextResult('t1', 'The page asked for your camera and Atelier denied it.')
    slow.open()
    await new Promise((r) => setTimeout(r, 30))
    // The next browser step waits at the gate.
    expect(t.requests).toHaveLength(1)
    expect(t.eventsOf(id).filter((e) => e.type === 'tool' && e.state === 'running').length).toBe(3)
    t.host.resume(id)
    await until(() => t.chats.summary(id)?.status === 'finished', 'finished')
    const results = JSON.stringify(t.requests[1]?.messages.at(-1))
    expect(results).toContain('atelier_note')
    expect(results).toContain('camera')
  })

  it('acts without asking when the chat says so, starting from the global setting', async () => {
    const t = setup((_r, n) => (n === 1 ? { tools: [{ name: 'left_click', input: { target: { type: 'ref', ref: 'ref_1' } } }] } : { text: 'Bought.' }), { confirm: false })
    const id = t.host.start('Buy it')
    await until(() => t.chats.summary(id)?.status === 'finished')
    expect(t.chats.summary(id)?.actWithoutAsking).toBe(true)
    expect(t.eventsOf(id).some((e) => e.type === 'approval')).toBe(false)
    // Asking again for this chat only.
    t.host.setActWithoutAsking(id, false)
    expect(t.chats.summary(id)?.actWithoutAsking).toBe(false)
    const draft = t.host.create()
    expect(draft.actWithoutAsking).toBe(true)
  })

  it('keeps password fields blocked in either mode', async () => {
    const t = setup((_r, n) => (n === 1 ? { tools: [{ name: 'type', input: { text: 'hunter2' } }] } : { text: 'ok' }), { confirm: false, focus: passwordField })
    const id = t.host.start('Log in')
    await until(() => t.chats.summary(id)?.status === 'finished')
    const step = t.eventsOf(id).filter((e) => e.type === 'tool').at(-1)
    expect(step).toMatchObject({ state: 'error', detail: expect.stringContaining('password') })
  })
})

describe('offline hold (SS-06)', () => {
  it('holds a send while offline and sends it when the connection returns', async () => {
    const online = { value: false, listeners: [] as Array<(on: boolean) => void> }
    const t = setup(() => ({ text: 'Back.' }), { online })
    const draft = t.host.create()
    t.host.send(draft.id, 'Hello offline')
    await until(() => t.host.view(draft.id).queued.length === 1)
    expect(t.host.view(draft.id).queued[0]).toMatchObject({ text: 'Hello offline', offline: true })
    expect(t.requests).toHaveLength(0)
    online.value = true
    for (const fn of online.listeners) fn(true)
    await until(() => t.requests.length === 1 && !t.host.isRunning(draft.id), 'sent')
    expect(t.host.view(draft.id).queued).toEqual([])
  })
})

describe('tabs used and previews', () => {
  it('lists and closes the tabs a chat used, and previews the chat', async () => {
    const t = setup((_r, n) => (n === 1 ? { tools: [{ name: 'switch_tab', input: { tab_id: 't2' } }] } : { text: 'Here is a **summary**. Want more?' }))
    const id = t.host.start('Check the second tab')
    await until(() => t.chats.summary(id)?.status === 'finished')
    expect(t.host.tabsUsed(id)).toEqual([{ tabId: 't2', title: 'Title t2', url: 'https://t2.example/' }])
    const preview = t.host.preview(id)
    expect(preview).toMatchObject({ kind: 'chat', lastRequest: { text: 'Check the second tab', source: 'you' }, replySnippet: 'Here is a summary. Want more?', progress: 'needs-you', pendingCount: 1 })
    expect(preview.pending[0]).toMatchObject({ kind: 'question' })
    expect(t.host.closeTabsUsed(id)).toBe(1)
    expect(t.closed).toEqual(['t2'])
    expect(t.host.tabsUsed(id)).toEqual([])
  })
})

describe('save failures (SS-05)', () => {
  it('reports a failed save, keeps the session, and clears it after a retry', async () => {
    const t = setup(() => ({ text: 'Saved?' }))
    const states: Array<string | null> = []
    t.host.onSaveState((_id, error) => states.push(error))
    const save = t.chats.save.bind(t.chats)
    let broken = true
    t.chats.save = (...args: Parameters<typeof save>) => {
      if (broken) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
      return save(...args)
    }
    const draft = t.host.create()
    t.host.send(draft.id, 'Hello')
    await until(() => states.length > 0 && !t.host.isRunning(draft.id))
    expect(states[0]).toMatch(/disk is full/)
    expect(t.host.view(draft.id).saveError).toMatch(/disk is full/)
    broken = false
    expect(t.host.retrySave(draft.id)).toBe(true)
    expect(states.at(-1)).toBeNull()
    expect(t.chats.summary(draft.id)).toBeDefined()
  })
})

describe('error types (SS-03)', () => {
  const headers = new Headers({ 'retry-after': '12' })
  it('maps API failures to codes with retry times', () => {
    expect(classifyApiError(new Anthropic.AuthenticationError(401, undefined, 'bad', new Headers()), true).code).toBe('key-rejected')
    expect(classifyApiError(new Anthropic.AuthenticationError(401, undefined, 'bad', new Headers()), false).code).toBe('key-missing')
    expect(classifyApiError(new Anthropic.RateLimitError(429, undefined, 'slow down', headers), true)).toMatchObject({ code: 'rate-limited', retryAfterMs: 12_000 })
    expect(classifyApiError(new Anthropic.APIError(529, { error: { type: 'overloaded_error' } }, 'Overloaded', new Headers()), true).code).toBe('overloaded')
    expect(classifyApiError(new Anthropic.BadRequestError(400, undefined, 'prompt is too long: 250000 tokens > 200000 maximum', new Headers()), true).code).toBe('too-long')
    expect(classifyApiError(new Anthropic.APIError(413, undefined, 'request_too_large', new Headers()), true).code).toBe('too-large')
    expect(classifyApiError(new Anthropic.BadRequestError(400, undefined, 'Your credit balance is too low to access the Anthropic API.', new Headers()), true).code).toBe('quota')
    expect(classifyApiError(new Anthropic.PermissionDeniedError(403, undefined, 'model not allowed', new Headers()), true).code).toBe('model-not-allowed')
    expect(classifyApiError(new Anthropic.InternalServerError(500, undefined, 'oops', new Headers()), true).code).toBe('unavailable')
    expect(classifyApiError(new Anthropic.APIConnectionError({ message: 'down' }), true).code).toBe('offline')
    expect(classifyApiError(new Error('weird'), true)).toMatchObject({ code: 'other', message: 'weird' })
  })
  it('reads Retry-After in its forms, and names a full disk', () => {
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '2500' }))).toBe(2500)
    expect(retryAfterMs({ 'retry-after': '3' })).toBe(3000)
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(Date.now() + 60_000).toUTCString() }))).toBeGreaterThan(50_000)
    expect(retryAfterMs(null)).toBeNull()
    expect(classifySaveError(Object.assign(new Error('x'), { code: 'ENOSPC' })).code).toBe('disk-full')
  })
})

describe('run helpers', () => {
  it('pages a long log newest first, starting pages at a message of yours', () => {
    const log: AgentEvent[] = []
    for (let i = 0; i < 300; i++) {
      log.push({ type: 'user-message', id: `u${i}`, text: `q${i}` })
      log.push({ type: 'text-delta', turnId: `t${i}`, text: `a${i}` })
    }
    const page = newestPage(log, 101)
    expect(page.events[0]?.type).toBe('user-message')
    expect(page.start + page.events.length).toBe(600)
    expect(page.events.length).toBeGreaterThanOrEqual(101)
    const older = olderPage(log, page.start, 50)
    expect(older.events.at(-1)).toEqual(log[page.start - 1])
    expect(older.events[0]?.type).toBe('user-message')
    expect(older.hasOlder).toBe(true)
    expect(olderPage(log, 4, 50)).toMatchObject({ hasOlder: false, start: 0 })
    expect(pageStart(log, 10, 100)).toBe(0)
    expect(newestPage(log.slice(0, 10)).start).toBe(0)
  })

  it('gates, notes and snippets', async () => {
    const run = new RunGate()
    let passed = false
    run.pause()
    const wait = run.wait().then(() => {
      passed = true
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(passed).toBe(false)
    run.resume()
    await wait
    expect(passed).toBe(true)
    const stop = new AbortController()
    run.pause()
    const aborted = run.wait(stop.signal)
    stop.abort(new Error('Stopped.'))
    await expect(aborted).rejects.toThrow('Stopped.')

    const notes = new TabNotes()
    notes.add('t1', 'one')
    notes.add('t1', 'one')
    notes.add('t2', 'two')
    expect(notes.take(['t1'])).toEqual(['one'])
    expect(notes.take(['t1'])).toEqual([])
    expect(noteBlock(['x'])?.text).toContain('<atelier_note>')
    expect(noteBlock([])).toBeNull()
    expect(plainSnippet('## Title\n- **bold** item and `code` [link](https://x.y)')).toBe('Title bold item and code link')
  })

  it('previews routine runs and approvals', () => {
    const summary = { ...newSummary(), routineId: 'r1', status: 'finished' as const }
    const preview = chatPreview({
      summary,
      status: 'awaiting-approval',
      log: [
        { type: 'user-message', id: 'u1', text: 'Brief me' },
        { type: 'approval', approvalId: 'a1', description: 'Nova wants to click "Buy".', origin: 'https://shop.example' },
      ],
      nextRunAt: 5,
    })
    expect(preview).toMatchObject({ kind: 'routine-run', lastRequest: { source: 'routine' }, progress: 'needs-you', pending: [{ kind: 'approval' }], nextRunAt: 5 })
  })
})

function newSummary() {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Chat',
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0,
    routineId: null,
    companionId: 'pip',
    model: 'claude-opus-5-5',
    status: 'idle' as const,
    unread: false,
    pinned: false,
    archived: false,
    needsInput: false,
    draft: false,
    actWithoutAsking: false,
    muted: false,
    private: false,
    parentChatId: null,
    delegationStatus: null,
    projectId: null,
    imported: null,
    routineRun: null,
  }
}
