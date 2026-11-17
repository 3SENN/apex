/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  session: { fromPartition: () => ({}) },
  ipcMain: { handle: () => undefined, on: () => undefined, removeHandler: () => undefined, off: () => undefined },
}))

import { CREATOR_TOOL, clientToolNames, registerClientTool, resetClientToolsForTests, runClientTool, type ClientTool, type ClientToolContext, type ToolSetup } from '../src/main/agent/tools/registry'
import { SessionAgentTools, type SessionAgentToolsHost } from '../src/main/agent/sessionAgentTools'
import { BUILDER_TOOL_NAMES, registerPackAgentTools } from '../src/main/packs/agentTools'
import { registerPackBuilderTools } from '../src/main/packs/builder'

// Creator mode (docs/apps.md › Creator mode): the builder tools are in
// Creator chats only; creator_mode turns a chat into one, and the tools join
// it then. Tools of a pack installed mid-chat join at the next turn. Only the
// packs group's tools ever join; on an engine that takes tools only at launch
// the chat goes straight on in a fresh process that has them.

const SETUP: ToolSetup = {
  companionId: 'nova',
  browser: true,
  memory: true,
  routine: false,
  private: false,
  flags: { 'pack-builder': 'on' },
  workspace: { folders: false, tables: false, apps: false, calendar: false, activity: false },
}

const fakeDeps = { store: { get: () => undefined }, runtime: { isRunning: () => false, providerOf: () => null, callService: async () => null, runningManifests: () => [] } }

function registerAll(): void {
  registerPackAgentTools(fakeDeps as never)
  registerPackBuilderTools({ store: {}, runtime: {}, app: {}, companionName: () => null, isOwn: () => false } as never)
}

const context = (): ClientToolContext => ({ chatId: 'c', companionId: 'nova', isPrivate: false, isRoutine: false, signal: new AbortController().signal, emit: () => undefined, ask: () => Promise.reject(new Error('no')) })

beforeEach(() => resetClientToolsForTests())

describe('which chats get the builder', () => {
  it('gives Creator chats the builder tools and other chats only the switch', () => {
    registerAll()
    const normal = clientToolNames(SETUP)
    expect(normal).toContain('creator_mode')
    expect(normal).toContain('use_app')
    for (const name of BUILDER_TOOL_NAMES) expect(normal).not.toContain(name)
    const creator = clientToolNames({ ...SETUP, creator: true })
    for (const name of BUILDER_TOOL_NAMES) expect(creator).toContain(name)
    expect(creator).not.toContain('creator_mode')
    expect(CREATOR_TOOL).toBe('create_pack')
  })

  it('never builds in private chats, routines or a delegated child, and not with the builder off', () => {
    registerAll()
    for (const setup of [{ ...SETUP, private: true }, { ...SETUP, routine: true }, { ...SETUP, flags: { 'pack-builder': 'off' } }]) {
      const names = clientToolNames({ ...setup, creator: true })
      expect(names).not.toContain('create_pack')
      expect(clientToolNames(setup)).not.toContain('creator_mode')
    }
    expect(clientToolNames({ ...SETUP, child: true })).not.toContain('creator_mode')
  })

  it('creator_mode answers with the build guide and asks to change the chat’s setup', async () => {
    registerAll()
    const result = await runClientTool('creator_mode', {}, context())
    expect(result.setup).toEqual({ creator: true })
    expect(result.content).toMatch(/Creator mode is on/)
    expect(result.content).toMatch(/atelier_inspect/)
    expect((await runClientTool('creator_mode', { extra: 1 }, context())).isError).toBe(true)
  })
})

describe('tools that join a running chat', () => {
  const tool = (name: string, group: ClientTool['group'], enabled: (s: ToolSetup) => boolean = () => true, setup?: { creator: boolean }): ClientTool<Record<string, unknown>> => ({
    name,
    group,
    description: name,
    inputSchema: { type: 'object' },
    parse: z.record(z.string(), z.unknown()),
    enabled,
    run: async () => ({ content: 'done', ...(setup ? { setup } : {}) }),
  })

  function chat(clientTools: string[], options: { engine?: string; isPrivate?: boolean } = {}) {
    const caps = { clientTools, browser: true, memory: true, private: options.isPrivate === true, engine: options.engine ?? 'api-key' }
    let saved = 0
    const host: SessionAgentToolsHost = {
      chatId: 'chat-1',
      companionId: () => 'nova',
      companionName: () => 'Nova',
      content: () => ({ capabilities: caps }) as never,
      emit: () => undefined,
      waiting: () => undefined,
      persist: () => {
        saved++
      },
      actWithoutAsking: () => false,
      confirmConsequential: () => true,
    }
    const d = new SessionAgentTools(host, () => ({ flags: () => ({ 'pack-builder': 'on' }) }) as never, {}, options.isPrivate === true)
    return { d, caps, saves: () => saved }
  }
  const base = { companionId: 'nova', browser: true, memory: true, routine: false }

  it('adds a pack installed mid-chat at the end of the list, and nothing from other groups', () => {
    registerClientTool(tool('pk_weather_forecast', 'packs'))
    registerClientTool(tool('search_everything', 'workspace'))
    registerClientTool(tool('create_pack', 'packs', (s) => s.creator === true))
    const { d, caps, saves } = chat(['update_plan'])
    expect(d.joinTools(base)).toEqual(['pk_weather_forecast'])
    expect(caps.clientTools).toEqual(['update_plan', 'pk_weather_forecast'])
    expect(saves()).toBe(1)
    // Nothing new: nothing changes, nothing is saved.
    expect(d.joinTools(base)).toEqual([])
    expect(saves()).toBe(1)
  })

  it('brings the builder in once creator_mode runs, and a Creator chat keeps getting new pack tools', async () => {
    registerClientTool(tool('creator_mode', 'packs', (s) => s.creator !== true, { creator: true }))
    registerClientTool(tool('create_pack', 'packs', (s) => s.creator === true))
    registerClientTool(tool('test_pack', 'packs', (s) => s.creator === true))
    const { d, caps } = chat(['creator_mode'])
    expect(d.joinTools(base)).toEqual([])
    await d.executeClient('creator_mode', {}, new AbortController().signal)
    expect(caps.clientTools).toEqual(['creator_mode', 'create_pack', 'test_pack'])
    // On the API key the next step has them; nothing needs a new process.
    expect(d.takeRelaunch()).toBe(false)
    registerClientTool(tool('pk_board_post', 'packs'))
    expect(d.joinTools(base)).toEqual(['pk_board_post'])
  })

  it('asks another engine to go straight on in a fresh process when tools joined mid-turn, once', async () => {
    registerClientTool(tool('creator_mode', 'packs', (s) => s.creator !== true, { creator: true }))
    registerClientTool(tool('create_pack', 'packs', (s) => s.creator === true))
    const { d } = chat(['creator_mode'], { engine: 'another-engine' })
    await d.executeClient('creator_mode', {}, new AbortController().signal)
    expect(d.takeRelaunch()).toBe(true)
    expect(d.takeRelaunch()).toBe(false)
  })

  it('leaves a chat that gained no pack exactly as it was, even a Creator chat when a builder tool is new', () => {
    registerClientTool(tool('create_pack', 'packs', (s) => s.creator === true))
    registerClientTool(tool('atelier_inspect', 'packs', (s) => s.creator === true))
    registerClientTool(tool('use_app', 'packs'))
    const { d, caps, saves } = chat(['create_pack'])
    expect(d.joinTools(base)).toEqual([])
    expect(caps.clientTools).toEqual(['create_pack'])
    expect(saves()).toBe(0)
  })

  it('never adds tools to a private chat', () => {
    registerClientTool(tool('pk_weather_forecast', 'packs'))
    const { d, caps } = chat([], { isPrivate: true })
    expect(d.joinTools(base)).toEqual([])
    expect(caps.clientTools).toEqual([])
  })
})
