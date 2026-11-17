/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import { appendToLog, buildRequest, buildTools } from '../src/main/agent/session'
import { isTrustedUiSender } from '../src/main/ipc'
import type { ChatCapabilities } from '../src/main/chats'

const caps = (overrides: Partial<ChatCapabilities> = {}): ChatCapabilities => ({
  model: 'claude-opus-5-5',
  browser: true,
  webTools: true,
  memory: true,
  connectorIds: [],
  ...overrides,
})

describe('buildTools', () => {
  it('declares the browser toolset, web tools, memory and connectors in a fixed order', () => {
    const tools = buildTools(caps(), [{ id: 'a', name: 'linear', url: 'https://mcp.example/linear', token: 't' }])
    expect(tools).toEqual([
      { type: 'browser_toolset_20260801' },
      { type: 'web_search_20260209', name: 'web_search' },
      { type: 'web_fetch_20260209', name: 'web_fetch' },
      { type: 'memory_20250818', name: 'memory' },
      { type: 'mcp_toolset', mcp_server_name: 'linear' },
    ])
  })

  it('uses the basic web tools on models without dynamic filtering', () => {
    expect(buildTools(caps({ model: 'claude-haiku-5-5', browser: false, memory: false }), [])).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
      { type: 'web_fetch_20250910', name: 'web_fetch' },
    ])
  })

  it('leaves out what the chat did not enable', () => {
    expect(buildTools(caps({ browser: false, webTools: false, memory: false }), [])).toEqual([])
  })
})

describe('buildRequest', () => {
  const base = { system: 'You are Pip.', effort: 'high' as const, messages: [{ role: 'user' as const, content: 'hi' }] }

  it('sends adaptive thinking, caching and server-side fallbacks', () => {
    const request = buildRequest({ ...base, capabilities: caps(), connectors: [] })
    expect(request).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'You are Pip.',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    expect(request).not.toHaveProperty('mcp_servers')
    expect(request).not.toHaveProperty('temperature')
  })

  it('adds MCP servers with the connector beta, and tokens only when set', () => {
    const request = buildRequest({
      ...base,
      capabilities: caps(),
      connectors: [
        { id: 'a', name: 'linear', url: 'https://mcp.example/linear', token: 'secret' },
        { id: 'b', name: 'docs', url: 'https://mcp.example/docs', token: null },
      ],
    })
    expect(request.betas).toEqual(['server-side-fallback-2026-07-01', 'mcp-client-2025-11-20'])
    expect(request.mcp_servers).toEqual([
      { type: 'url', url: 'https://mcp.example/linear', name: 'linear', authorization_token: 'secret' },
      { type: 'url', url: 'https://mcp.example/docs', name: 'docs' },
    ])
  })

  it('omits server-side fallbacks for Haiku, which has none', () => {
    const request = buildRequest({ ...base, capabilities: caps({ model: 'claude-haiku-5-5' }), connectors: [] })
    expect(request).not.toHaveProperty('fallbacks')
    expect(request).not.toHaveProperty('betas')
  })
})

describe('appendToLog', () => {
  it('merges streaming deltas and tool updates', () => {
    const log: AgentEvent[] = []
    appendToLog(log, { type: 'status', status: 'running' })
    appendToLog(log, { type: 'text-delta', turnId: 't', text: 'Hel' })
    appendToLog(log, { type: 'text-delta', turnId: 't', text: 'lo' })
    appendToLog(log, { type: 'tool', id: 'c', label: 'Read the page', state: 'running' })
    appendToLog(log, { type: 'tool', id: 'c', label: 'Read the page', state: 'done' })
    expect(log).toEqual([
      { type: 'text-delta', turnId: 't', text: 'Hello' },
      { type: 'tool', id: 'c', label: 'Read the page', state: 'done' },
    ])
  })
})

describe('isTrustedUiSender', () => {
  const mainFrame = { id: 'frame' }
  const ui = { mainFrame }

  it('accepts only the chrome main frame', () => {
    expect(isTrustedUiSender({ sender: ui, senderFrame: mainFrame }, ui)).toBe(true)
    expect(isTrustedUiSender({ sender: ui, senderFrame: { id: 'child' } }, ui)).toBe(false)
    expect(isTrustedUiSender({ sender: { mainFrame }, senderFrame: mainFrame }, ui)).toBe(false)
    expect(isTrustedUiSender({ sender: ui, senderFrame: null }, ui)).toBe(false)
  })
})
