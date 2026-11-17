/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { ChatAgentEvent } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import type { UsageRow } from '@shared/usage'
import { CompanionFiles } from '../src/main/companionFiles'
import { Delegations } from '../src/main/agent/delegation'
import { AgentHost } from '../src/main/agent/host'
import { SiteRulesStore } from '../src/main/agent/sitePolicy'
import { registerAgentClientTools } from '../src/main/agent/tools/agentTools'
import { clientTool, contributeToolSetup, registerClientTool, resetClientToolsForTests } from '../src/main/agent/tools/registry'
import { ChatStore } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import { ConnectorStore, SkillStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'

// Private chats (CH-30, the main side), imported chats, freezing and the
// prompt viewer, on the host against a scripted stand-in for the Messages
// API. No request leaves the machine.

interface Turn {
  text?: string
  tools?: Array<{ name: string; input: unknown }>
}

interface Request {
  system: string
  tools: Array<{ name?: string; type?: string }>
  messages: Array<{ role: string; content: unknown }>
}

function fakeClient(script: (request: Request, n: number) => Turn) {
  const requests: Request[] = []
  const client = {
    beta: {
      messages: {
        stream: (request: Request) => {
          requests.push(structuredClone(request))
          const turn = script(request, requests.length)
          const content: unknown[] = []
          if (turn.text) content.push({ type: 'text', text: turn.text, citations: null })
          for (const [i, tool] of (turn.tools ?? []).entries()) content.push({ type: 'tool_use', id: `toolu_${requests.length}_${i}`, name: tool.name, input: tool.input })
          const message = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: turn.tools?.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: null } }
          return {
            async *[Symbol.asyncIterator]() {
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

const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious.', look: DEFAULT_LOOK }]

function harness(script: (request: Request, n: number) => Turn) {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-private-'))
  const companions = new CompanionStore(dir, { presets: () => presets })
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const events: ChatAgentEvent[] = []
  const api = fakeClient(script)
  const tabs = { find: () => undefined, active: () => null, activeId: () => null, rail: () => null, activate: () => undefined, all: () => [], info: () => null, setAgentControlled: () => undefined, setNeedsInput: () => undefined }
  const host = new AgentHost({
    settings: {
      get: () => ({ model: 'claude-opus-5-5', effort: 'high', webTools: true, memory: true, confirmConsequentialActions: true }),
      view: () => ({ hasApiKey: true }),
      apiKey: () => 'test-key',
    },
    tabs: tabs as unknown as TabManager,
    bridge: {} as never,
    memory: { execute: () => Promise.resolve('ok') },
    connectors: new ConnectorStore(dir),
    skills: new SkillStore(dir),
    chats,
    companions,
    presets: { personality: () => 'Curious.' },
    client: api.client,
    emit: (event: ChatAgentEvent) => events.push(event),
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  } as never)
  const usage: UsageRow[] = []
  const delegations = new Delegations(host.delegationHost())
  host.installAgentTools({
    mode: () => 'standard',
    sites: new SiteRulesStore(join(dir, 'agent-site-rules.json'), { defaultAccess: () => 'allow' }),
    recordUsage: (r) => usage.push(r),
    delegations,
    flags: () => ({}),
    project: () => null,
    isRunning: (id) => host.isRunning(id),
  })
  registerAgentClientTools({ delegate: (input, ctx) => delegations.run(input, ctx), companionFiles: new CompanionFiles(dir) })
  const eventsOf = (chatId: string): AgentEvent[] => events.filter((e) => e.chatId === chatId).map((e) => e.event)
  return { host, chats, usage, requests: api.requests, eventsOf }
}

async function until(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const toolNames = (request: Request | undefined): string[] => (request?.tools ?? []).map((t) => t.name ?? t.type ?? '')

beforeEach(() => {
  resetClientToolsForTests()
  // search_activity, as it registers: never for private chats.
  registerClientTool({ name: 'search_activity', group: 'activity', description: 'Search activity.', inputSchema: { type: 'object' }, parse: z.object({}), enabled: (s) => s.workspace.activity && !s.private, run: () => Promise.resolve({ content: '[]' }) })
})
contributeToolSetup(() => ({ activity: true }))

describe('private chats', () => {
  it('never write to ChatStore, record usage without a chat, and leave out memory and search_activity', async () => {
    const h = harness(() => ({ text: 'Hello there.' }))
    const summary = h.host.create({ private: true })
    expect(summary.private).toBe(true)
    h.host.send(summary.id, 'Plan my secret party.')
    await until(() => h.requests.length === 1 && !h.host.isRunning(summary.id), 'reply')
    expect(h.chats.summary(summary.id)).toBeUndefined()
    expect(h.chats.list().some((c) => c.id === summary.id)).toBe(false)
    expect(h.usage).toHaveLength(1)
    expect(h.usage[0]).toMatchObject({ chatId: null, kind: 'chat' })
    const tools = toolNames(h.requests[0])
    expect(tools).not.toContain('memory')
    expect(tools).not.toContain('search_activity')
    expect(tools).toContain('update_plan')
    // The live chat still answers views while it lives in memory.
    expect(h.host.view(summary.id).summary.private).toBe(true)

    // A normal chat has both.
    const normal = h.host.create({})
    h.host.send(normal.id, 'Hi')
    await until(() => h.requests.length === 2 && !h.host.isRunning(normal.id), 'normal reply')
    expect(toolNames(h.requests[1])).toEqual(expect.arrayContaining(['memory', 'search_activity']))
    expect(h.usage.at(-1)?.chatId).toBe(normal.id)
  })

  it('discard drops it, and only private chats can be discarded that way', async () => {
    const h = harness(() => ({ text: 'Sure.' }))
    const secret = h.host.create({ private: true })
    h.host.send(secret.id, 'Hi')
    await until(() => h.requests.length === 1 && !h.host.isRunning(secret.id), 'reply')
    h.host.discardPrivate(secret.id)
    expect(() => h.host.view(secret.id)).toThrow()
    const normal = h.host.create({})
    h.host.send(normal.id, 'Hi')
    await until(() => h.requests.length === 2 && !h.host.isRunning(normal.id), 'normal')
    expect(() => h.host.discardPrivate(normal.id)).toThrow(/Only private chats/)
  })

  it('CH-30: privateState tells an empty private chat from one with content, and viewing lists surfaces', async () => {
    const h = harness(() => ({ text: 'Okay.' }))
    const secret = h.host.create({ private: true })
    expect(h.host.privateState(secret.id)).toBe('empty')
    h.host.send(secret.id, 'Hi')
    expect(h.host.privateState(secret.id)).toBe('content')
    await until(() => h.requests.length === 1 && !h.host.isRunning(secret.id), 'reply')
    expect(h.host.privateState(secret.id)).toBe('content')
    const normal = h.host.create({})
    expect(h.host.privateState(normal.id)).toBeNull()
    expect(h.host.privateState('missing')).toBeNull()
    h.host.setViewing('page:t1', secret.id)
    expect(h.host.viewing()).toContainEqual(['page:t1', secret.id])
    h.host.setViewing('page:t1', null)
    expect(h.host.viewing()).toEqual([])
  })

  it('CH-30: each window reports its own side panel, and a closed or reloaded window shows nothing', () => {
    const h = harness(() => ({ text: 'Okay.' }))
    const secret = h.host.create({ private: true })
    const other = h.host.create({})
    h.host.setViewing('panel', secret.id, 1)
    h.host.setViewing('panel', other.id, 2)
    // Two windows' panels don't overwrite each other.
    expect(h.host.viewing()).toEqual([
      ['panel', secret.id, 1],
      ['panel', other.id, 2],
    ])
    // Window 2's panel stopping leaves window 1's alone.
    h.host.setViewing('panel', null, 2)
    expect(h.host.viewing()).toEqual([['panel', secret.id, 1]])
    h.host.setViewing('panel', other.id, 2)
    h.host.clearViewing(1)
    expect(h.host.viewing()).toEqual([['panel', other.id, 2]])
    expect(h.host.isViewed(secret.id)).toBe(false)
    expect(h.host.isViewed(other.id)).toBe(true)
  })

  it('routines refuse to append to a private chat', async () => {
    const h = harness(() => ({ text: 'Done.' }))
    const secret = h.host.create({ private: true })
    h.host.send(secret.id, 'Hi')
    await until(() => h.requests.length === 1 && !h.host.isRunning(secret.id), 'reply')
    await expect(h.host.runBackground({ companionId: 'nova', prompt: 'Daily note', kind: 'routine', appendTo: secret.id })).rejects.toThrow(/private chat/)
  })
})

describe('imported chats', () => {
  it('refuse new messages with a clear error', async () => {
    const h = harness(() => ({ text: 'Hi.' }))
    const chat = h.host.create({})
    h.host.send(chat.id, 'Hello')
    await until(() => h.requests.length === 1 && !h.host.isRunning(chat.id), 'reply')
    h.chats.update([chat.id], { imported: { source: 'chatgpt', originalTitle: 'Old', originalCreatedAt: null, importedAt: 1 } })
    expect(() => h.host.send(chat.id, 'More')).toThrow('This is an imported conversation. Continue it in a new chat.')
  })
})

describe('frozen setup and the prompt viewer', () => {
  it('keeps the first message’s tools, and shows the frozen prompt', async () => {
    const h = harness(() => ({ text: 'OK.' }))
    const chat = h.host.create({})
    const preview = h.host.systemPromptView({ companionId: FIRST_COMPANION_ID })
    expect(preview.frozen).toBe(false)
    h.host.send(chat.id, 'One')
    await until(() => h.requests.length === 1 && !h.host.isRunning(chat.id), 'first')
    // A tool that arrives later never joins this chat.
    registerClientTool({ name: 'aaa_late', group: 'chat', description: 'Late.', inputSchema: { type: 'object' }, parse: z.object({}), enabled: () => true, run: () => Promise.resolve({ content: '' }) })
    h.host.send(chat.id, 'Two')
    await until(() => h.requests.length === 2 && !h.host.isRunning(chat.id), 'second')
    expect(toolNames(h.requests[1])).toEqual(toolNames(h.requests[0]))
    expect(toolNames(h.requests[1])).not.toContain('aaa_late')
    // Registry tools come after the server tools, sorted by name (the built-in client tools follow them).
    const names = toolNames(h.requests[0])
    const client = names.filter((n) => clientTool(n) !== undefined)
    expect(client).toEqual([...client].sort())
    expect(names.indexOf(client[0] ?? '')).toBeGreaterThan(names.indexOf('memory'))
    const view = h.host.systemPromptView({ chatId: chat.id })
    expect(view.frozen).toBe(true)
    expect(view.system).toBe(h.requests[0]?.system)
    expect(view.tools).toEqual(expect.arrayContaining(['memory', 'update_plan']))
    expect(() => h.host.systemPromptView({ companionId: 'gone' })).toThrow(/no longer exists/)
  })
})
