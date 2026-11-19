/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { ChatAgentEvent } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import { AgentHost } from '../src/main/agent/host'
import { ChatStore } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import type { AgentBackend, BackendResult, BackendTurn } from '../src/main/engines/backend'
import { ConnectorStore, SkillStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'

// Compact now and the step-limit notice on a chat that runs on Claude
// Code, through the real chat session and a fake engine backend (no CLI, no model).

const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious.', look: DEFAULT_LOOK }]

class FakeBackend implements AgentBackend {
  readonly engine = 'claude-code' as const
  readonly runs: BackendTurn[] = []
  readonly compacts: BackendTurn[] = []
  next: BackendResult = { text: 'Done.', paused: false, error: null }
  compactResult: BackendResult | Error = { text: '', paused: false, error: null }

  async run(turn: BackendTurn): Promise<BackendResult> {
    this.runs.push(turn)
    turn.setSession({ id: 'sess-1' })
    turn.emit({ type: 'text-delta', turnId: 't1', text: this.next.text })
    return this.next
  }

  async compact(turn: BackendTurn): Promise<BackendResult> {
    this.compacts.push(turn)
    if (this.compactResult instanceof Error) throw this.compactResult
    turn.emit({ type: 'compaction', id: 'cmp-1', state: 'running', trigger: 'manual' })
    turn.emit({ type: 'compaction', id: 'cmp-1', state: 'done', trigger: 'manual', replacedTokens: 1200 })
    return this.compactResult
  }

  reset(): void {}
  discard(): void {}
}

function setup(backend: AgentBackend) {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-en1-compact-'))
  const events: ChatAgentEvent[] = []
  const tabs = { find: () => undefined, active: () => null, activeId: () => null, rail: () => null, activate: () => undefined, all: () => [], info: () => ({ title: '', url: '' }), contentBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }), setAgentControlled: () => undefined, setNeedsInput: () => undefined } as unknown as TabManager
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const host = new AgentHost({
    settings: { get: () => ({ model: 'claude-opus-5-5', effort: 'medium', webTools: false, memory: false, confirmConsequentialActions: true, engine: 'claude-code', documents: false }), view: () => ({ hasApiKey: false }), apiKey: () => null },
    tabs,
    bridge: {} as never,
    memory: { execute: async () => 'ok' },
    connectors: new ConnectorStore(dir),
    skills: new SkillStore(dir),
    chats,
    companions: new CompanionStore(dir, { presets: () => presets }),
    presets: { personality: () => undefined },
    client: () => {
      throw new Error('The API-key engine must not run in these tests.')
    },
    backends: { 'claude-code': backend },
    emit: (event) => events.push(event),
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  })
  const eventsOf = (id: string): AgentEvent[] => events.filter((e) => e.chatId === id).map((e) => e.event)
  return { host, chats, eventsOf }
}

async function until(condition: () => boolean, timeout = 4000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('Timed out')
}

describe('Compact now on Claude Code', () => {
  it('goes to the engine with the chat’s session, shows its card and adds nothing to the history', async () => {
    const backend = new FakeBackend()
    const { host, chats, eventsOf } = setup(backend)
    const id = host.start('Hello there')
    await until(() => backend.runs.length === 1 && !host.isRunning(id))
    const before = chats.load(id).messages.length
    expect(() => host.compact(id)).not.toThrow()
    await until(() => backend.compacts.length === 1 && !host.isRunning(id))
    const turn = backend.compacts[0]
    if (!turn) throw new Error('Compact now never reached the engine.')
    expect(turn.session).toEqual({ id: 'sess-1' })
    expect(turn.capabilities.engine).toBe('claude-code')
    expect(turn.blocks).toEqual([])
    await expect(turn.tools.execute('navigate', {}, new AbortController().signal)).rejects.toThrow()
    const cards = eventsOf(id).filter((e) => e.type === 'compaction')
    expect(cards.map((c) => (c as { state: string }).state)).toEqual(['running', 'done'])
    expect(chats.load(id).messages.length).toBe(before)
    expect(eventsOf(id).some((e) => e.type === 'error')).toBe(false)
  })

  it('shows the engine’s reason when it has nothing to condense', async () => {
    const backend = new FakeBackend()
    backend.compactResult = new Error('Claude Code has nothing of this chat to condense yet.')
    const { host, eventsOf } = setup(backend)
    const id = host.start('Hello there')
    await until(() => backend.runs.length === 1 && !host.isRunning(id))
    host.compact(id)
    await until(() => eventsOf(id).some((e) => e.type === 'error'))
    expect(eventsOf(id).find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('nothing of this chat to condense') })
  })

  it('refuses while a reply is running, as on the API key', async () => {
    const backend = new FakeBackend()
    let release: (r: BackendResult) => void = () => undefined
    backend.run = (turn) => {
      backend.runs.push(turn)
      return new Promise((resolve) => (release = resolve))
    }
    const { host } = setup(backend)
    const id = host.start('Hello there')
    await until(() => backend.runs.length === 1)
    expect(() => host.compact(id)).toThrow(/Wait for the reply to finish/)
    release({ text: 'ok', paused: false, error: null })
    await until(() => !host.isRunning(id))
  })
})

describe('the step-limit notice on Claude Code', () => {
  it('shows the step-limit card with Continue when the engine stops at the cap', async () => {
    const backend = new FakeBackend()
    backend.next = { text: 'Halfway.', paused: true, error: null, stepLimit: true, steps: 60 }
    const { host, eventsOf } = setup(backend)
    const id = host.start('Do a long task')
    await until(() => backend.runs.length === 1 && !host.isRunning(id))
    expect(eventsOf(id).find((e) => e.type === 'step-limit')).toMatchObject({ type: 'step-limit', steps: 60 })
    expect(eventsOf(id).some((e) => e.type === 'error')).toBe(false)
  })
})
