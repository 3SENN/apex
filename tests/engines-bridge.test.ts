/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MessageDetails } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import { pdfBlock, PDF_DOCUMENT_MAX_BYTES, PDF_DOCUMENT_MAX_PAGES, StreamJsonReader, userLine, commandLine, type LineBlock } from '../src/engines/claude-code/main/streamJson'
import type { ChatCapabilities, EngineSession } from '../src/main/chats'
import { MAX_STEPS, type BackendResult, type BackendTurn } from '../src/main/engines/backend'
import { ClaudeCodeBackend, MESSAGES, toolLabel } from '../src/engines/claude-code/main/claudeCode'
import type { BridgeEvent } from '../src/engines/claude-code/main/streamJson'
import type { ClaudeProcess, ProcessExit, SpawnSpec } from '../src/engines/claude-code/main/process'

// The Claude Code bridge's step cap, Compact now, private chats and
// PDFs, against an in-memory stand-in for the `claude` process. Nothing is
// spawned and no model is called.

class FakeProcess extends EventEmitter<{ event: [BridgeEvent]; exit: [ProcessExit] }> {
  readonly lines: Array<{ blocks?: readonly LineBlock[]; command?: string }> = []
  readonly interrupts: string[] = []
  #alive = true
  #resolve!: (exit: ProcessExit) => void
  readonly exited = new Promise<ProcessExit>((resolve) => {
    this.#resolve = resolve
  })

  constructor(readonly spec: SpawnSpec) {
    super()
  }

  get alive(): boolean {
    return this.#alive
  }

  get pid(): number {
    return 4242
  }

  send(blocks: readonly LineBlock[]): boolean {
    this.lines.push({ blocks })
    return this.#alive
  }

  command(text: string): boolean {
    this.lines.push({ command: text })
    return this.#alive
  }

  interrupt(id: string): boolean {
    this.interrupts.push(id)
    return this.#alive
  }

  stop(): Promise<ProcessExit> {
    if (this.#alive) {
      this.#alive = false
      const exit: ProcessExit = { code: 0, signal: null, stderr: '', expected: true }
      this.emit('exit', exit)
      this.#resolve(exit)
    }
    return this.exited
  }

  push(...events: BridgeEvent[]): void {
    for (const event of events) this.emit('event', event)
  }
}

const root = mkdtempSync(join(tmpdir(), 'atelier-en1-'))
const at = (procs: readonly FakeProcess[], i = 0): FakeProcess => {
  const proc = procs[i]
  if (!proc) throw new Error('No process was started.')
  return proc
}

function setup() {
  const procs: FakeProcess[] = []
  const backend = new ClaudeCodeBackend({
    cli: async () => ({ path: '/fake/bin/claude', source: 'override' }),
    env: async () => ({ HOME: root }),
    folder: (id) => join(root, 'companions', id),
    configDir: join(root, 'mcp'),
    endpoint: async (chatId) => ({ url: `http://127.0.0.1:9/mcp/chat/${chatId}`, token: 'chat-token' }),
    onNote: () => undefined,
    spawn: (spec) => {
      const proc = new FakeProcess(spec)
      procs.push(proc)
      return proc as unknown as ClaudeProcess
    },
    documents: (chatId) => ({ cwd: join(root, 'documents', chatId), addDirs: [join(root, 'documents', chatId)], pluginDirs: [join(root, 'plugin')], note: '\n\n<files_and_documents/>' }),
  })
  return { backend, procs }
}

const capsOf = (patch: Partial<ChatCapabilities> = {}): ChatCapabilities => ({ model: 'claude-opus-5-5', effort: 'high', browser: false, webTools: true, memory: false, connectorIds: [], engine: 'claude-code', ...patch })

function turnOf(patch: Partial<BackendTurn> & { caps?: Partial<ChatCapabilities> } = {}) {
  const events: AgentEvent[] = []
  const sessions: Array<EngineSession | null> = []
  const details: MessageDetails[] = []
  const controller = new AbortController()
  const { caps, ...rest } = patch
  const turn: BackendTurn = {
    chatId: 'chat-1',
    companionId: 'pip',
    capabilities: capsOf(caps),
    system: 'You are Pip.',
    history: [],
    blocks: [{ type: 'text', text: 'hello' }],
    session: null,
    signal: controller.signal,
    emit: (event) => events.push(event),
    details: (d) => details.push(d),
    setSession: (session) => sessions.push(session),
    tools: { execute: async () => 'ok' },
    connectors: [],
    ...rest,
  }
  return { turn, events, sessions, details, controller }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await tick()
  if (!condition()) throw new Error('Timed out')
}

const result = (patch: Partial<Extract<BridgeEvent, { kind: 'result' }>> = {}): BridgeEvent => ({ kind: 'result', ok: true, subtype: 'success', text: '', sessionId: null, costUsd: null, usage: null, numTurns: 1, errors: [], ...patch })

describe('Claude Code: the 60-step cap', () => {
  it('counts one step per model message that asks for tools and stops after the 60th step’s results', async () => {
    const { backend, procs } = setup()
    const t = turnOf()
    const running = backend.run(t.turn)
    await until(() => procs.length === 1 && at(procs).lines.length === 1)
    const proc = at(procs)
    let settled: BackendResult | null = null
    void running.then((r) => (settled = r))
    for (let step = 1; step <= MAX_STEPS; step++) {
      // Two parallel calls in one message are one step.
      const calls = step === 7 ? ['a', 'b'] : ['a']
      for (const c of calls) proc.push({ kind: 'tool-use', id: `t${step}${c}`, name: 'WebSearch', input: { query: `q${step}` }, messageId: `m${step}` })
      await tick()
      expect(settled).toBeNull()
      for (const c of calls) proc.push({ kind: 'tool-result', id: `t${step}${c}`, isError: false, text: 'found' })
      await tick()
      if (step < MAX_STEPS) expect(settled).toBeNull()
    }
    const done = await running
    expect(done).toMatchObject({ paused: true, error: null, stepLimit: true, steps: MAX_STEPS })
    // The CLI was told to stop before it took a 61st step.
    expect(proc.interrupts).toHaveLength(1)
    expect(t.events.filter((e) => e.type === 'tool' && e.state === 'running')).toHaveLength(MAX_STEPS + 1)
    // The interrupted turn's leftovers wind down; the next message goes to the same process.
    proc.push(result({ ok: false, subtype: 'error_during_execution' }))
    const next = turnOf()
    const again = backend.run(next.turn)
    await until(() => proc.lines.length === 2)
    proc.push({ kind: 'text', messageId: 'n1', text: 'Carrying on.' }, result({ text: 'Carrying on.' }))
    expect(await again).toMatchObject({ text: 'Carrying on.', error: null, paused: false })
    expect(procs).toHaveLength(1)
    await backend.dispose()
  })

  it('never runs a step past the cap, even when results are missing', async () => {
    const { backend, procs } = setup()
    const t = turnOf()
    const running = backend.run(t.turn)
    await until(() => procs.length === 1 && at(procs).lines.length === 1)
    for (let step = 1; step <= MAX_STEPS; step++) at(procs).push({ kind: 'tool-use', id: `t${step}`, name: 'mcp__atelier__navigate', input: {}, messageId: `m${step}` })
    at(procs).push({ kind: 'tool-use', id: 'over', name: 'mcp__atelier__navigate', input: {}, messageId: 'm61' })
    expect(await running).toMatchObject({ stepLimit: true, steps: MAX_STEPS, paused: true })
    expect(t.events.some((e) => e.type === 'tool' && e.id === 'over')).toBe(false)
    await backend.dispose()
  })

  it('has no cap with No step limit on, and stops at the next step when it is turned off', async () => {
    const { backend, procs } = setup()
    let cap = Number.POSITIVE_INFINITY
    const t = turnOf({ maxSteps: () => cap })
    const running = backend.run(t.turn)
    await until(() => procs.length === 1 && at(procs).lines.length === 1)
    const proc = at(procs)
    let settled: BackendResult | null = null
    void running.then((r) => (settled = r))
    for (let step = 1; step <= MAX_STEPS + 20; step++) {
      proc.push({ kind: 'tool-use', id: `t${step}`, name: 'WebSearch', input: { query: `q${step}` }, messageId: `m${step}` })
      proc.push({ kind: 'tool-result', id: `t${step}`, isError: false, text: 'found' })
      await tick()
    }
    expect(settled).toBeNull()
    expect(proc.interrupts).toHaveLength(0)
    // Turned off mid-run: the next step past the usual cap isn't run.
    cap = MAX_STEPS
    proc.push({ kind: 'tool-use', id: 'over', name: 'WebSearch', input: { query: 'over' }, messageId: 'm-over' })
    expect(await running).toMatchObject({ stepLimit: true, steps: MAX_STEPS + 20, paused: true })
    expect(t.events.some((e) => e.type === 'tool' && e.id === 'over')).toBe(false)
    await backend.dispose()
  })

  it('reports Claude Code’s own turn cap as the same notice', async () => {
    const { backend, procs } = setup()
    const t = turnOf()
    const running = backend.run(t.turn)
    await until(() => procs.length === 1 && at(procs).lines.length === 1)
    at(procs).push({ kind: 'tool-use', id: 't1', name: 'WebSearch', input: {}, messageId: 'm1' }, { kind: 'tool-result', id: 't1', isError: false, text: '' }, result({ ok: false, subtype: 'error_max_turns', numTurns: 9 }))
    expect(await running).toMatchObject({ stepLimit: true, steps: 1, paused: true, error: null })
    await backend.dispose()
  })
})

describe('Claude Code: Compact now', () => {
  it('writes /compact on the chat’s stdin and shows the card from compact_boundary', async () => {
    const { backend, procs } = setup()
    const first = turnOf()
    const running = backend.run(first.turn)
    await until(() => procs.length === 1 && at(procs).lines.length === 1)
    at(procs).push({ kind: 'init', sessionId: 'sess-1', model: null, tools: [], mcpServers: [] }, result({ text: 'Hi.' }))
    await running
    expect(first.sessions).toEqual([{ id: 'sess-1' }])

    const t = turnOf({ session: { id: 'sess-1' } })
    const compacting = backend.compact(t.turn)
    await until(() => at(procs).lines.length === 2)
    expect(at(procs).lines[1]).toEqual({ command: '/compact' })
    const running2 = t.events.find((e) => e.type === 'compaction')
    expect(running2).toMatchObject({ type: 'compaction', state: 'running', trigger: 'manual' })
    at(procs).push({ kind: 'compacting', active: true }, { kind: 'compacting', active: false, boundary: { trigger: 'manual', preTokens: 42_000 } }, result({ text: 'Compacted.' }))
    expect(await compacting).toEqual({ text: '', paused: false, error: null })
    const cards = t.events.filter((e): e is Extract<AgentEvent, { type: 'compaction' }> => e.type === 'compaction')
    expect(cards.map((c) => c.state)).toEqual(['running', 'done'])
    expect(cards[1]).toMatchObject({ id: cards[0]?.id, trigger: 'manual', replacedTokens: 42_000 })
    expect(procs).toHaveLength(1)
    await backend.dispose()
  })

  it('fails the card when Claude Code ends without condensing', async () => {
    const { backend, procs } = setup()
    const t = turnOf({ session: { id: 'sess-9' } })
    const compacting = backend.compact(t.turn)
    // The idle chat is resumed first.
    await until(() => procs.length === 1 && at(procs).lines.length === 1)
    expect(at(procs).spec.args[at(procs).spec.args.indexOf('--resume') + 1]).toBe('sess-9')
    at(procs).push(result({ ok: false, subtype: 'error_during_execution', text: 'Not enough messages to compact.' }))
    const done = await compacting
    expect(done.error).toMatch(/Not enough messages/)
    expect(t.events.filter((e) => e.type === 'compaction').map((e) => (e as { state: string }).state)).toEqual(['running', 'failed'])
    await backend.dispose()
  })

  it('has nothing to condense in a chat Claude Code holds no conversation for', async () => {
    const { backend, procs } = setup()
    await expect(backend.compact(turnOf().turn)).rejects.toThrow(MESSAGES.nothingToCompact)
    await expect(backend.compact(turnOf({ session: { id: 'kept' }, caps: { private: true } }).turn)).rejects.toThrow(MESSAGES.nothingToCompact)
    expect(procs).toHaveLength(0)
  })
})

describe('Claude Code: private chats', () => {
  it('launches without session persistence and never stores or resumes a session', async () => {
    const { backend, procs } = setup()
    const t = turnOf({ caps: { private: true }, session: { id: 'old' } })
    const running = backend.run(t.turn)
    await until(() => procs.length === 1 && at(procs).lines.length === 1)
    const args = at(procs).spec.args
    expect(args).toContain('--no-session-persistence')
    expect(args).not.toContain('--resume')
    at(procs).push({ kind: 'init', sessionId: 'ephemeral', model: null, tools: [], mcpServers: [] }, result({ text: 'ok' }))
    await running
    expect(t.sessions).toEqual([])
    await backend.dispose()
  })
})

describe('Claude Code: the launch the bridge spawns', () => {
  it('uses the launch policy: web page reading, connector tools that are off, fallback model', async () => {
    const { backend, procs } = setup()
    const t = turnOf({
      caps: { connectorIds: ['c1'], toolPolicies: { c1: { delete_all: 'off', read: 'ask' } } },
      connectors: [{ id: 'c1', name: 'Wiki', url: 'https://wiki.example/mcp', token: 'tok' }],
    })
    const running = backend.run(t.turn)
    await until(() => procs.length === 1 && at(procs).lines.length === 1)
    const args = at(procs).spec.args
    const flag = (name: string): string => args[args.indexOf(name) + 1] ?? ''
    expect(flag('--tools')).toBe('WebSearch,WebFetch')
    expect(flag('--disallowedTools').split(',')).toContain('mcp__wiki__delete_all')
    expect(flag('--allowedTools').split(',')).toEqual(expect.arrayContaining(['mcp__wiki', 'WebSearch', 'WebFetch']))
    expect(flag('--fallback-model')).toBe('claude-sonnet-5-5')
    expect(at(procs).spec.cwd).toBe(join(root, 'companions', 'pip'))
    expect(args.join(' ')).not.toContain('tok')
    at(procs).push(result())
    await running
    await backend.dispose()
  })

  it('runs a documents chat in its workspace with its plugin', async () => {
    const { backend, procs } = setup()
    const running = backend.run(turnOf({ caps: { documents: true } }).turn)
    await until(() => procs.length === 1 && at(procs).lines.length === 1)
    const { args, cwd } = at(procs).spec
    expect(cwd).toBe(join(root, 'documents', 'chat-1'))
    expect(args[args.indexOf('--add-dir') + 1]).toBe(cwd)
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe(join(root, 'plugin'))
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('<files_and_documents/>')
    at(procs).push(result())
    await running
    await backend.dispose()
  })

  it('labels page reading as on the API key', () => {
    expect(toolLabel('WebFetch', { url: 'https://example.com/a' })).toBe('Read https://example.com/a')
  })
})

describe('Claude Code: PDFs', () => {
  const file = (bytes: number): string => {
    const path = join(root, `doc-${bytes}.pdf`)
    writeFileSync(path, Buffer.alloc(bytes, 37))
    return path
  }
  const read = (path: string) => (): Buffer => readFileSync(path)

  it('sends the PDF itself as a base64 document block', () => {
    const path = file(1000)
    const block = pdfBlock({ title: 'Report.pdf', pages: 3, text: 'words', read: read(path) })
    expect(block).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.alloc(1000, 37).toString('base64') }, title: 'Report.pdf' })
    const line = JSON.parse(userLine([block, { type: 'text', text: 'Summarize it' }])) as { message: { content: Array<{ type: string }> } }
    expect(line.message.content.map((b) => b.type)).toEqual(['document', 'text'])
  })

  it('falls back to the extracted text for very large, very long or unreadable PDFs', () => {
    const text = { type: 'text', text: '<document title="Big &amp; long.pdf" pages="3">\nwords\n</document>' }
    expect(pdfBlock({ title: 'Big & long.pdf', pages: 3, text: 'words', read: () => Buffer.alloc(PDF_DOCUMENT_MAX_BYTES + 1) })).toEqual(text)
    expect(pdfBlock({ title: 'Big & long.pdf', pages: PDF_DOCUMENT_MAX_PAGES + 1, text: 'words', read: () => Buffer.alloc(10) })).toEqual({ ...text, text: text.text.replace('pages="3"', `pages="${PDF_DOCUMENT_MAX_PAGES + 1}"`) })
    expect(pdfBlock({ title: 'Big & long.pdf', pages: 3, text: 'words', read: () => { throw new Error('ENOENT') } })).toEqual(text)
  })

  it('writes /compact as a plain user line and tags tool calls with their message', () => {
    expect(JSON.parse(commandLine('/compact'))).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } })
    const reader = new StreamJsonReader()
    const events = reader.read(JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu_1', name: 'WebFetch', input: { url: 'https://a.example' } }] } }))
    expect(events[0]).toEqual({ kind: 'tool-use', id: 'tu_1', name: 'WebFetch', input: { url: 'https://a.example' }, messageId: 'msg_1' })
  })
})
