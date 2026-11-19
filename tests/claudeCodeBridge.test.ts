/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { ChatAgentEvent, MessageDetails } from '@shared/chats'
import type { EngineSettings } from '../src/main/engines/service'
import type { AgentEvent, ElementDescription } from '@shared/ipc'
import { AgentHost } from '../src/main/agent/host'
import { ChatStore } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import type { BackendTurn } from '../src/main/engines/backend'
import { MESSAGES } from '../src/engines/claude-code/main/claudeCode'
import { claudeCodeEngines, type TestEngines } from './helpers/engines'
import { ConnectorStore, SkillStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'
import { installScript, programPath } from './helpers/fakeProgram'

// The Claude subscription engine end to end against a fake `claude` that speaks the
// stream-json protocol (tests/fixtures/fake-claude.mjs). The real CLI never
// runs, and nothing leaves the machine but loopback calls to Atelier's own server.

const root = mkdtempSync(join(tmpdir(), 'atelier-claude-'))
const fake = programPath(join(root, 'bin'), 'claude')
const log = join(root, 'launches.jsonl')
const env: NodeJS.ProcessEnv = {
  ...process.env,
  CLAUDECODE: '1',
  CLAUDE_CODE_SSE_PORT: '4242',
  ELECTRON_RUN_AS_NODE: '1',
  NODE_OPTIONS: '--no-warnings',
  KEEP_ME: 'kept',
  FAKE_CLAUDE_LOG: log,
}

beforeAll(() => {
  // Installed as this platform installs a CLI: a copy with the executable bit, or npm's .cmd shim on Windows.
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  installScript(resolve(__dirname, 'fixtures/fake-claude.mjs'), bin, 'claude')
  copyFileSync(resolve(__dirname, 'fixtures/claude-version-too-old.json'), join(bin, 'claude-version-too-old.json'))
})

const services: TestEngines[] = []
afterAll(async () => {
  await Promise.all(services.map((s) => s.dispose()))
})

const buyButton: ElementDescription = { role: 'button', name: 'Buy now', tag: 'button', inputType: null, isPassword: false, isPaymentField: false, formSubmitName: null, inForm: false, formHasPaymentFields: false }

const PAGE = { x: 0, y: 0, width: 1000, height: 800 }

function fakeTabs() {
  const wc = { getURL: () => 'https://shop.example/', getTitle: () => 'Shop', isDestroyed: () => false, isLoading: () => false, getZoomFactor: () => 1 }
  const tabs = [{ id: 'tab-1', internalUrl: null, view: { webContents: wc, getBounds: () => PAGE } }]
  const controlled: Array<[string, boolean, string | null]> = []
  const manager = {
    find: (id: string) => tabs.find((t) => t.id === id),
    active: () => tabs[0],
    activeId: () => 'tab-1',
    rail: () => null,
    activate: () => undefined,
    all: () => tabs,
    isHidden: () => false,
    isChromeDrawn: () => false,
    info: () => ({ title: 'Shop', url: 'https://shop.example/' }),
    contentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    setAgentControlled: (id: string, on: boolean, chatId: string | null = null) => controlled.push([id, on, chatId]),
    setNeedsInput: () => undefined,
  }
  return { tabs: manager as unknown as TabManager, controlled }
}

const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious.', look: DEFAULT_LOOK }]

function setup(options: { settings?: Partial<EngineSettings>; approve?: boolean; idle?: boolean } = {}) {
  const dir = mkdtempSync(join(root, 'data-'))
  const settings: EngineSettings = { engine: 'claude-code', claudeCodePath: fake, externalAccess: false, externalTabs: 'own', ...options.settings }
  const opened: string[] = []
  const engines = claudeCodeEngines({
    dataDir: dir,
    home: dir,
    env,
    // The fake really runs, so the engine works the way it does on this platform.
    platform: process.platform,
    resourcesPath: null,
    settings: () => settings,
    apiKeyState: () => 'missing',
    folder: (id) => join(dir, 'companion-files', id),
    openPath: async (path) => {
      opened.push(path)
      return ''
    },
    outside: { box: { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() }, executor: { tabs: {} as TabManager, bridge: {} as never }, approve: async () => false, claim: () => undefined, release: () => undefined },
    shell: async () => null,
    // Only the fake is ever runnable, so a real install on this machine is never found.
    isExecutable: (path) => path === fake,
    available: true,
  })
  services.push(engines)
  const companions = new CompanionStore(dir, { presets: () => presets })
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const { tabs, controlled } = fakeTabs()
  const events: ChatAgentEvent[] = []
  const memoryCalls: Array<[unknown, string | null]> = []
  const host: AgentHost = new AgentHost({
    settings: {
      get: () => ({ model: 'claude-opus-5-5', effort: 'high', webTools: true, memory: true, confirmConsequentialActions: true, engine: settings.engine }),
      view: () => ({ hasApiKey: false }),
      apiKey: () => null,
    },
    tabs,
    bridge: { request: async (_wc: unknown, command: { op: string }) => (command.op === 'resolveRef' ? { ...buyButton, x: 5, y: 5 } : null) } as never,
    memory: {
      execute: async (input, scope) => {
        memoryCalls.push([input, scope])
        return 'Here are the files: (none)'
      },
    },
    connectors: new ConnectorStore(dir),
    skills: new SkillStore(dir),
    chats,
    companions,
    presets: { personality: () => undefined },
    client: () => {
      throw new Error('The API-key engine must not run in these tests.')
    },
    backends: { 'claude-code': engines.backend },
    emit: (event) => {
      events.push(event)
      if (event.event.type === 'approval') {
        const { approvalId } = event.event
        setTimeout(() => host.approve(event.chatId, approvalId, options.approve ?? false), 5)
      }
    },
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  })
  const eventsOf = (chatId: string): AgentEvent[] => events.filter((e) => e.chatId === chatId).map((e) => e.event)
  /** Sends and waits until the run is over. */
  const run = async (chatId: string | null, text: string): Promise<string> => {
    const before = events.length
    const id = chatId ?? host.start(text)
    if (chatId) host.send(chatId, text)
    await until(() => events.slice(before).some((e) => e.chatId === id && e.event.type === 'status' && e.event.status === 'running'), 'the run to start')
    await until(() => !host.isRunning(id), 'the run to end', 8000)
    return id
  }
  return { dir, engines, host, chats, events, eventsOf, run, controlled, memoryCalls, opened, settings }
}

async function until(condition: () => boolean, label: string, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function launches(): Array<{ args: string[]; cwd: string; env: Record<string, string | null>; mcp?: string[] }> {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

const flag = (args: string[], name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

describe('Claude subscription engine', () => {
  it('streams a reply once, with thinking, usage and cost, from a clean process in the companion’s folder', async () => {
    const t = setup()
    const before = launches().length
    const id = await t.run(null, 'hello')
    const events = t.eventsOf(id)
    expect(events.filter((e) => e.type === 'text-delta').map((e) => (e.type === 'text-delta' ? e.text : ''))).toEqual(['Hello ', 'there.'])
    expect(events.filter((e) => e.type === 'thinking-delta')).toHaveLength(1)
    expect(events.some((e) => e.type === 'error')).toBe(false)

    const view = t.host.view(id)
    expect(view.setup.engine).toBe('claude-code')
    const details = Object.values(view.details) as MessageDetails[]
    expect(details).toHaveLength(1)
    expect(details[0]).toMatchObject({ engine: 'claude-code', costUsd: 0.0123, usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 4 } })
    // The chat remembers Claude Code's session for --resume.
    const saved = t.chats.load(id)
    expect(saved.engineSession?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(saved.capabilities.engine).toBe('claude-code')

    const launch = launches().slice(before)[0]
    expect(launch).toBeDefined()
    const { args } = launch!
    expect(args.slice(0, 2)).toEqual(['-p', '--verbose'])
    expect(flag(args, '--permission-mode')).toBe('dontAsk')
    expect(flag(args, '--setting-sources')).toBe('')
    expect(flag(args, '--tools')).toBe('WebSearch,WebFetch') // Page reading comes with web tools, as on the API key
    expect(flag(args, '--allowedTools')?.split(',')).toContain('mcp__atelier__left_click')
    expect(flag(args, '--allowedTools')?.split(',')).toContain('mcp__atelier__memory')
    expect(flag(args, '--append-system-prompt')).toContain('You are')
    expect(flag(args, '--append-system-prompt')).toContain('no access to files, a terminal or code')
    expect(launch!.env).toEqual({ CLAUDECODE: null, CLAUDE_CODE_SSE_PORT: null, ELECTRON_RUN_AS_NODE: null, NODE_OPTIONS: null, DISABLE_AUTOUPDATER: '1', KEEP_ME: 'kept' })
    expect(launch!.cwd).toBe(realpathSync(resolve(t.dir, 'companion-files', view.setup.companionId)))
    // The token lives in a private file, never on the command line.
    const config = flag(args, '--mcp-config') ?? ''
    // Windows has no permission bits: the file is private by living in the person's own profile folder.
    if (process.platform !== 'win32') expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(args.join(' ')).not.toContain('Bearer')
    expect(t.engines.status().processes).toBe(1)
  })

  it('keeps one process per chat, and resumes by session id after an idle shutdown', async () => {
    const t = setup()
    const id = await t.run(null, 'hello')
    const a = launches().length
    await t.run(id, 'context')
    // The warm process answered: no new launch, and Claude Code has the history itself.
    expect(launches().length).toBe(a)
    expect(t.eventsOf(id).some((e) => e.type === 'text-delta' && e.text === 'context:no')).toBe(true)

    t.engines.backend.reset(id)
    await until(() => t.engines.status().processes === 0, 'the process to stop')
    const sessionId = t.chats.load(id).engineSession?.id
    await t.run(id, 'context')
    const relaunch = launches().at(-1)!
    expect(flag(relaunch.args, '--resume')).toBe(sessionId)
    expect(t.eventsOf(id).filter((e) => e.type === 'text-delta' && e.text === 'context:no')).toHaveLength(2)

    // Two chats run side by side, each in its own process.
    const other = await t.run(null, 'hello')
    expect(other).not.toBe(id)
    expect(t.engines.status().processes).toBe(2)
  })

  it('edit and resend start a fresh conversation that gets the kept history as context', async () => {
    const t = setup()
    const id = await t.run(null, 'hello')
    await t.run(id, 'hello again')
    const second = t.eventsOf(id).filter((e) => e.type === 'user-message').at(-1)
    if (second?.type !== 'user-message') throw new Error('no message')
    const before = t.events.length
    t.host.editAndResend(id, second.id, 'context')
    await until(() => t.events.slice(before).some((e) => e.chatId === id && e.event.type === 'text-delta' && e.event.text === 'context:yes'), 'the resent reply')
    await until(() => !t.host.isRunning(id), 'the run to end')
    expect(flag(launches().at(-1)!.args, '--resume')).toBeUndefined()
  })

  it('stops a turn when you press stop, and the chat carries on', async () => {
    const t = setup()
    const id = await t.run(null, 'hello')
    const before = t.events.length
    t.host.send(id, 'slow')
    await until(() => t.events.slice(before).some((e) => e.event.type === 'text-delta' && e.event.text === 'Working'), 'the slow reply')
    t.host.stop(id)
    await until(() => !t.host.isRunning(id), 'the stop')
    expect(t.eventsOf(id).some((e) => e.type === 'stopped' && e.reason === 'user')).toBe(true)
    await t.run(id, 'hello')
    expect(t.eventsOf(id).filter((e) => e.type === 'text-delta' && e.text === 'there.')).toHaveLength(2)
  })

  it('reports a crash with the CLI’s own words, and starts again on the next message', async () => {
    const t = setup()
    const id = await t.run(null, 'please crash')
    const error = t.eventsOf(id).find((e) => e.type === 'error')
    expect(error?.type === 'error' && error.message).toMatch(/stopped unexpectedly \(exit code 3: boom: something broke\)/)
    expect(t.chats.summary(id)?.status).toBe('error')
    await t.run(id, 'hello')
    expect(t.eventsOf(id).some((e) => e.type === 'text-delta' && e.text === 'there.')).toBe(true)
  })

  it('explains a signed-out CLI and an account limit in place', async () => {
    const t = setup()
    const id = await t.run(null, 'signedout')
    expect(t.eventsOf(id).find((e) => e.type === 'error')).toEqual({ type: 'error', message: MESSAGES.signedOut, code: 'cc-signed-out', details: 'Invalid API key · Please run /login' })
    // A check that started before the chat failed doesn't overrule what the chat found.
    await until(() => t.engines.status().claudeCode.state !== 'checking', 'the background check')
    expect(t.engines.status().claudeCode.state).toBe('signed-out')
    const limited = await t.run(null, 'ratelimit')
    const error = t.eventsOf(limited).find((e) => e.type === 'error')
    expect(error?.type === 'error' && error.message).toContain('reached its limit for now; it opens again at')
    expect(error).toMatchObject({ code: 'cc-limit' })
    expect(t.engines.status().claudeCode.rateLimit?.status).toBe('limited')
  })

  it('runs browser actions through the chat’s own guard and approvals, keyed by its token', async () => {
    const t = setup({ approve: false })
    const id = await t.run(null, 'tool:left_click:{"target":{"type":"ref","ref":"ref_1"}}')
    const events = t.eventsOf(id)
    const approval = events.find((e) => e.type === 'approval')
    expect(approval?.type === 'approval' && approval.description).toMatch(/wants to click button "Buy now" on (https:\/\/)?shop\.example/)
    expect(events).toContainEqual({ type: 'approval-resolved', approvalId: approval?.type === 'approval' ? approval.approvalId : '', allowed: false })
    const row = events.filter((e) => e.type === 'tool').at(-1)
    expect(row).toMatchObject({ type: 'tool', id: 'toolu_1', label: 'Click ref_1', state: 'error' })
    const reply = events.filter((e) => e.type === 'text-delta').map((e) => (e.type === 'text-delta' ? e.text : '')).join('')
    // The 28 browser tools, plus whatever other tools a chat's server carries.
    expect(Number(/tools=(\d+)/.exec(reply)?.[1] ?? 0)).toBeGreaterThanOrEqual(28)
    expect(reply).toContain('The user declined the action')
    // The tab showed the agent marker for this chat while it worked, and was let go after.
    expect(t.controlled).toContainEqual(['tab-1', true, id])
    expect(t.controlled.at(-1)).toEqual(['tab-1', false, null])
  })

  it('serves memory to the chat’s companion, and nothing to another chat’s token', async () => {
    const t = setup()
    const id = await t.run(null, 'tool:memory:{"command":"create","path":"/memories/likes.md","file_text":"tea"}')
    const companionId = t.host.view(id).setup.companionId
    expect(t.memoryCalls).toEqual([[{ command: 'create', path: '/memories/likes.md', file_text: 'tea' }, companionId]])
    const details = Object.values(t.host.view(id).details) as MessageDetails[]
    expect(details.at(-1)?.memoryPaths).toEqual(['/memories/likes.md'])

    // Chat A's token opens nothing for chat B, and calls outside a turn are refused.
    const [file] = readdirSync(join(t.dir, 'claude-code', 'mcp'))
    const server = JSON.parse(readFileSync(join(t.dir, 'claude-code', 'mcp', file!), 'utf8')).mcpServers.atelier as { url: string; headers: Record<string, string> }
    const other = server.url.replace(/[0-9a-f-]{36}$/, '00000000-0000-4000-8000-000000000000')
    expect(await rpc(other, server.headers, 'tools/list')).toMatchObject({ status: 401 })
    const idle = await rpc(server.url, server.headers, 'tools/call', { name: 'get_page_text', arguments: {} })
    expect(idle.body).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining('not working on anything') }] } })
    expect(await rpc(server.url, {}, 'tools/list')).toMatchObject({ status: 401 })
  })

  it('gives routine runs no browser tools', async () => {
    const t = setup()
    const result = await t.host.runRoutine({ id: 'r1', prompt: 'tool:memory:{"command":"view","path":"/memories"}', owner: 'shared' })
    expect(result.ok).toBe(true)
    const text = t.eventsOf(result.chatId ?? '').filter((e) => e.type === 'text-delta').map((e) => (e.type === 'text-delta' ? e.text : '')).join('')
    // Memory (and any other non-browser tools), never the browser's.
    const count = Number(/tools=(\d+)/.exec(text)?.[1] ?? 0)
    expect(count).toBeGreaterThanOrEqual(1)
    expect(count).toBeLessThan(28)
    const allowed = flag(launches().at(-1)!.args, '--allowedTools')?.split(',') ?? []
    expect(allowed).toEqual(expect.arrayContaining(['mcp__atelier__memory', 'WebSearch']))
    for (const browser of ['mcp__atelier__left_click', 'mcp__atelier__navigate', 'mcp__atelier__read_page']) expect(allowed).not.toContain(browser)
  })

  it('falls back to the API key engine for drafts when the build has no Claude Code', () => {
    const t = setup()
    const host = new AgentHost({
      settings: { get: () => ({ model: 'claude-opus-5-5', effort: 'high', webTools: true, memory: true, confirmConsequentialActions: true, engine: 'claude-code' }), view: () => ({ hasApiKey: true }), apiKey: () => 'k' },
      tabs: fakeTabs().tabs,
      bridge: {} as never,
      memory: { execute: async () => '' },
      connectors: new ConnectorStore(t.dir),
      skills: new SkillStore(t.dir),
      chats: t.chats,
      companions: new CompanionStore(t.dir, { presets: () => presets }),
      presets: { personality: () => undefined },
      emit: () => undefined,
      onTabOwners: () => undefined,
      onQueue: () => undefined,
    })
    expect(host.create().draft).toBe(true)
    expect(host.view(host.create().id).setup.engine).toBe('api-key')
    expect(t.host.view(t.host.create({ engine: 'api-key' }).id).setup.engine).toBe('api-key')
    expect(t.host.view(t.host.create().id).setup.engine).toBe('claude-code')
  })
})

// CH-15, CH-16: the queue and ⌘↩ on Claude Code. An interrupt is the
// stream-json interrupt control request, then the next user message.
describe('Claude Code chat control', () => {
  it('interrupts a turn and sends the new message next, with a valid history', async () => {
    const t = setup()
    const id = await t.run(null, 'hello')
    const before = t.events.length
    t.host.send(id, 'slow')
    await until(() => t.events.slice(before).some((e) => e.event.type === 'text-delta' && e.event.text === 'Working'), 'the slow reply')
    t.host.interrupt(id, 'hello again')
    await until(() => t.events.slice(before).some((e) => e.event.type === 'user-message' && e.event.text === 'hello again'), 'the interrupting message')
    await until(() => !t.host.isRunning(id), 'the run to end', 8000)
    const after = t.events.slice(before).map((e) => e.event)
    const order = after.map((e) => e.type)
    expect(order).toContain('interrupting')
    const stopped = after.findIndex((e) => e.type === 'stopped' && e.reason === 'interrupt')
    const next = after.findIndex((e) => e.type === 'user-message' && e.text === 'hello again')
    expect(stopped).toBeGreaterThan(-1)
    expect(next).toBeGreaterThan(stopped)
    // The new message got its own reply.
    expect(after.slice(next).some((e) => e.type === 'text-delta' && e.text === 'there.')).toBe(true)
    expect(t.eventsOf(id).filter((e) => e.type === 'error')).toEqual([])
  })

  it('queues a message sent while working and sends one now by interrupting', async () => {
    const t = setup()
    const id = await t.run(null, 'hello')
    const before = t.events.length
    t.host.send(id, 'slow')
    await until(() => t.events.slice(before).some((e) => e.event.type === 'text-delta' && e.event.text === 'Working'), 'the slow reply')
    expect(t.host.send(id, 'queued one')).toEqual({ queued: true })
    const queued = t.host.view(id).queued
    expect(queued.map((q) => q.text)).toEqual(['queued one'])
    t.host.sendNow(id, queued[0]!.id)
    await until(() => !t.host.isRunning(id) && t.events.slice(before).some((e) => e.event.type === 'user-message' && e.event.text === 'queued one'), 'the queued message', 8000)
    expect(t.host.view(id).queued).toEqual([])
    expect(t.eventsOf(id).some((e) => e.type === 'stopped' && e.reason === 'interrupt')).toBe(true)
  })
})

describe('Claude Code backend edges', () => {
  function turn(t: ReturnType<typeof setup>, text: string, patch: Partial<BackendTurn> = {}): BackendTurn & { emitted: AgentEvent[]; sessions: unknown[] } {
    const emitted: AgentEvent[] = []
    const sessions: unknown[] = []
    return {
      chatId: '11111111-2222-4333-8444-555555555555',
      companionId: FIRST_COMPANION_ID,
      capabilities: { model: 'claude-opus-5-5', effort: 'high', browser: false, webTools: false, memory: false, connectorIds: [], engine: 'claude-code' },
      system: 'You are Pip.',
      history: [],
      blocks: [{ type: 'text', text }],
      session: null,
      signal: new AbortController().signal,
      emit: (e) => emitted.push(e),
      details: () => undefined,
      setSession: (s) => sessions.push(s),
      tools: { execute: async () => 'unused' },
      connectors: [],
      emitted,
      sessions,
      ...patch,
    }
  }

  it('starts afresh, with the chat so far, when Claude Code no longer has the stored session', async () => {
    const t = setup()
    const input = turn(t, 'context', {
      session: { id: '00000000-dead-0000-0000-000000000000' },
      history: [{ role: 'user', content: [{ type: 'text', text: 'Earlier question' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] }],
    })
    const result = await t.engines.backend.run(input)
    expect(result).toEqual({ text: 'context:yes', paused: false, error: null })
    expect(input.sessions[0]).toBeNull()
    expect(input.sessions[1]).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) })
  })

  it('a fork continues the stored conversation under a new id', async () => {
    const t = setup()
    const input = turn(t, 'hello', { session: { id: 'aaaaaaaa-0000-4000-8000-000000000001', fork: true } })
    await t.engines.backend.run(input)
    expect(launches().at(-1)!.args).toContain('--fork-session')
    expect(input.sessions[0]).not.toEqual({ id: 'aaaaaaaa-0000-4000-8000-000000000001' })
  })

  it('stops a process that ignores an interrupt, and says where to find Claude Code when it is missing', async () => {
    env.FAKE_CLAUDE_DEAF = '1'
    try {
      const t = setup()
      const abort = new AbortController()
      const input = turn(t, 'slow', { signal: abort.signal })
      const running = t.engines.backend.run(input)
      await until(() => input.emitted.some((e) => e.type === 'text-delta'), 'the slow reply')
      abort.abort(new Error('Stopped by the user.'))
      await expect(running).rejects.toThrow('Stopped by the user.')
      await until(() => t.engines.status().processes === 0, 'the deaf process to be stopped', 6000)
    } finally {
      delete env.FAKE_CLAUDE_DEAF
    }
    const missing = setup({ settings: { claudeCodePath: '/nowhere/claude' } })
    expect(await missing.engines.backend.run(turn(missing, 'hello'))).toEqual({ text: '', paused: false, error: MESSAGES.notFound })
  })
})

describe('engine status', () => {
  it('reads version and sign-in without sending a message, for each outcome', async () => {
    for (const [mode, state] of [['in', 'ready'], ['out', 'signed-out'], ['old', 'unknown']] as const) {
      env.FAKE_CLAUDE_AUTH = mode
      const t = setup()
      const status = await t.engines.recheck()
      expect(status.claudeCode).toMatchObject({ state, path: fake, source: 'override', version: '9.9.9' })
      expect(status.claudeCode.nextStep === null).toBe(state === 'ready')
    }
    delete env.FAKE_CLAUDE_AUTH
    const none = setup({ settings: { claudeCodePath: '/nowhere/claude' } })
    expect((await none.engines.recheck()).claudeCode).toMatchObject({ state: 'not-found', overrideInvalid: true, path: null })
    // No message ever reached the CLI from these checks.
    expect(launches().filter((l) => l.args?.includes('auth'))).toEqual([])
  })

  it('opens Terminal with a script that runs Claude Code’s own sign-in', async () => {
    const t = setup()
    await t.engines.recheck()
    // Linux has no one terminal app to open: Atelier says what to run instead.
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      await expect(t.engines.openSignIn()).rejects.toThrow(/Open a terminal, run claude and sign in/)
      expect(t.opened).toEqual([])
      return
    }
    await t.engines.openSignIn()
    const script = readFileSync(t.opened[0] ?? '', 'utf8')
    // Terminal's .command on macOS, Command Prompt's .cmd on Windows.
    expect(t.opened[0]).toMatch(process.platform === 'win32' ? /sign-in\.cmd$/ : /sign-in\.command$/)
    // Windows may write the same folder in its long or its short (8.3) form, such as RUNNER~1.
    const forms = [fake, realpathSync.native(fake)]
    expect(forms.some((path) => script.includes(`${path} auth login`) || script.includes(`"${path}" auth login`)), script).toBe(true)
    if (process.platform !== 'win32') expect(statSync(t.opened[0] ?? '').mode & 0o777).toBe(0o700)
  })

  it('adds Atelier to Claude Code with the secret as a header, and replaces its own entry next time (ST-60)', async () => {
    const t = setup({ settings: { externalAccess: true } })
    await t.engines.settingsChanged(t.settings, { ...t.settings, externalAccess: false })
    const status = t.engines.status()
    expect(status.external).toMatchObject({ enabled: true, added: false, tabs: 'own' })
    expect(status.external.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/outside$/)
    expect(status.external.command).toContain('••••')
    const first = await t.engines.addToClaudeCode()
    expect(first.ok).toBe(true)
    expect(t.engines.status().external.added).toBe(true)
    const command = await t.engines.outsideCommand()
    const secret = /Bearer ([^'"]+)/.exec(command)?.[1] ?? ''
    const adds = launches().filter((l) => l.mcp?.[1] === 'add')
    expect(adds.at(-1)?.mcp).toEqual(['mcp', 'add', '--transport', 'http', '--scope', 'user', 'atelier', status.external.url, '--header', `Authorization: Bearer ${secret}`])
    await t.engines.addToClaudeCode()
    expect(launches().filter((l) => l.mcp?.[1] === 'remove').length).toBeGreaterThan(0)
    // The outside route answers with that secret only; revoking ends it.
    expect(await rpc(status.external.url ?? '', { Authorization: `Bearer ${secret}` }, 'tools/list')).toMatchObject({ status: 200 })
    t.engines.rotate()
    expect(await rpc(status.external.url ?? '', { Authorization: `Bearer ${secret}` }, 'tools/list')).toMatchObject({ status: 401 })
    expect(t.engines.status().external.added).toBe(false)
  })
})

function rpc(url: string, headers: Record<string, string>, method: string, params: unknown = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolvePromise, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    const target = new URL(url)
    const req = request({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => (data += chunk.toString()))
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('a CLI too old for the model', () => {
  const versionFile = join(root, 'fake-version.txt')
  const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>): Promise<void> => {
    Object.assign(env, vars)
    try {
      await fn()
    } finally {
      for (const key of Object.keys(vars)) delete env[key]
    }
  }

  it('says so, keeps the JSON out of the reply, and learns the model’s minimum', async () => {
    writeFileSync(versionFile, '2.1.50')
    await withEnv({ FAKE_CLAUDE_VERSION_FILE: versionFile, FAKE_CLAUDE_UPDATE_TO: '2.1.316' }, async () => {
      const t = setup()
      const id = await t.run(null, 'tooold')
      const events = t.eventsOf(id)
      expect(events.filter((e) => e.type === 'text-delta')).toEqual([])
      const error = events.find((e) => e.type === 'error')
      expect(error).toMatchObject({ type: 'error', code: 'cc-too-old', message: 'Your Claude Code (2.1.50) is too old for Opus 5.5. It needs 2.1.280 or newer.', facts: { version: '2.1.50', required: '2.1.280', model: 'claude-opus-5-5' } })
      expect(error?.type === 'error' && error.details).toContain('"error_code":"claude_code_version_too_old"')
      // The process that is too old stops, so the next message starts the CLI Atelier finds then.
      await until(() => t.engines.status().processes === 0, 'the old process to stop')
      await until(() => t.engines.status().claudeCode.state !== 'checking', 'the background check')
      expect(t.engines.status().claudeCode).toMatchObject({ version: '2.1.50', tooOld: { model: 'claude-opus-5-5', required: '2.1.280' } })
      expect(JSON.parse(readFileSync(join(t.dir, 'claude-code', 'minimums.json'), 'utf8'))['claude-opus-5-5'].version).toBe('2.1.280')

      // Update Claude Code: `claude update` in the background (its updater allowed for this run), then a fresh version.
      const phases: string[] = []
      t.engines.on('changed', (status) => phases.at(-1) !== status.claudeCode.update.phase && phases.push(status.claudeCode.update.phase))
      const result = await t.engines.updateCli('claude-opus-5-5')
      expect(result).toEqual({ outcome: 'updated', version: '2.1.316', required: '2.1.280', retried: false })
      expect(phases).toEqual(['updating', 'checking', 'updated'])
      expect(t.engines.status().claudeCode).toMatchObject({ version: '2.1.316', tooOld: null, update: { phase: 'updated', from: '2.1.50', to: '2.1.316' } })
      expect(launches().filter((l) => 'update' in l).at(-1)).toMatchObject({ autoupdater: null })
      expect(t.opened).toEqual([])
    })
  })

  it('opens Terminal with npm’s command when `claude update` says to use npm', async () => {
    writeFileSync(versionFile, '2.1.50')
    await withEnv({ FAKE_CLAUDE_VERSION_FILE: versionFile, FAKE_CLAUDE_UPDATE: 'npm' }, async () => {
      const t = setup()
      await t.engines.recheck()
      const result = await t.engines.updateCli(null)
      expect(result.outcome).toBe('manual')
      expect(t.engines.status().claudeCode.update).toMatchObject({ phase: 'manual', command: 'npm i -g @anthropic-ai/claude-code@latest' })
      // Linux has no one terminal app to open: the command shows in Atelier instead of in a script.
      if (process.platform !== 'darwin' && process.platform !== 'win32') {
        expect(t.opened).toEqual([])
        return
      }
      expect(t.opened.at(-1)).toMatch(process.platform === 'win32' ? /update\.cmd$/ : /update\.command$/)
      const script = readFileSync(t.opened.at(-1) ?? '', 'utf8')
      expect(script).toContain('npm i -g @anthropic-ai/claude-code@latest')
    })
  })

  it('an overloaded API gets the busy card that retries by itself, and no reply text', async () => {
    const t = setup()
    const id = await t.run(null, 'overloaded')
    expect(t.eventsOf(id).filter((e) => e.type === 'text-delta')).toEqual([])
    expect(t.eventsOf(id).find((e) => e.type === 'error')).toMatchObject({ code: 'overloaded', retryAfterMs: 20_000 })
  })

  it('lists every install it found, the one it runs marked', async () => {
    const t = setup()
    const status = await t.engines.recheck()
    expect(status.claudeCode.installs).toEqual([{ path: fake, source: 'override', version: '9.9.9', chosen: true }])
  })
})
