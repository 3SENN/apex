/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ElementDescription } from '@shared/ipc'
import { OutsideAccess, addCommand, type OutsideDeps } from '../src/main/mcp/external'
import { McpServer, loopbackHost, type McpRoute } from '../src/main/mcp/server'
import { bearerOf, chatToken, newSecret, tokensEqual } from '../src/main/mcp/secrets'
import { browserToolSpecs, describeBrowserState, qualified, toMcpResult, unqualified } from '../src/main/mcp/tools'
import { memberSchemas } from '../src/main/agent/schemas'
import type { TabManager } from '../src/main/tabs'

// Apex's local MCP server: it fails closed on a missing or wrong secret, a
// browser origin or a foreign host, and dispatches tools for its route.

interface Reply {
  status: number
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? '' : body instanceof Buffer ? body.toString() : JSON.stringify(body)
    const req = request({ host: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers } }, (res) => {
      let data = ''
      res.on('data', (chunk: Buffer) => (data += chunk.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null, headers: res.headers }))
    })
    req.on('error', reject)
    req.end(text)
  })
}

const servers: McpServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

async function start(route: McpRoute, token = 'a-good-token-of-sixteen+'): Promise<{ port: number; auth: Record<string, string> }> {
  const server = new McpServer((path, given) => (path === '/mcp/test' && tokensEqual(given, token) ? route : null))
  servers.push(server)
  const port = await server.listen()
  return { port, auth: { Authorization: `Bearer ${token}` } }
}

const echoRoute = (calls: unknown[] = []): McpRoute => ({
  name: 'Apex',
  tools: () => [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
  call: async (name, args) => {
    calls.push([name, args])
    return { content: [{ type: 'text', text: `echo ${JSON.stringify(args)}` }] }
  },
})

describe('McpServer', () => {
  it('refuses a missing or wrong token, a browser origin, a foreign host and other methods', async () => {
    const calls: unknown[] = []
    const { port, auth } = await start(echoRoute(calls))
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: {} } }
    const missing = await post(port, '/mcp/test', call)
    expect(missing.status).toBe(401)
    expect(missing.headers['www-authenticate']).toBe('Bearer')
    expect((await post(port, '/mcp/test', call, { Authorization: 'Bearer wrong-token-of-sixteen!!' })).status).toBe(401)
    expect((await post(port, '/mcp/other', call, auth)).status).toBe(401)
    expect((await post(port, '/mcp/test', call, { ...auth, Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(port, '/mcp/test', call, { ...auth, Host: 'evil.example' })).status).toBe(403)
    expect((await post(port, '/mcp/test', undefined, auth, 'GET')).status).toBe(405)
    expect(calls).toEqual([])
  })

  it('answers initialize, ping, tools/list and tools/call, and accepts notifications', async () => {
    const calls: unknown[] = []
    const { port, auth } = await start(echoRoute(calls))
    const init = await post(port, '/mcp/test', { jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '2025-06-18' } }, auth)
    expect(init.body).toMatchObject({ jsonrpc: '2.0', id: 'a', result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Apex' } } })
    const unknownVersion = await post(port, '/mcp/test', { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, auth)
    expect((unknownVersion.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-11-25')
    expect((await post(port, '/mcp/test', { jsonrpc: '2.0', method: 'notifications/initialized' }, auth)).status).toBe(202)
    expect((await post(port, '/mcp/test', { jsonrpc: '2.0', id: 3, method: 'ping' }, auth)).body).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
    expect((await post(port, '/mcp/test', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, auth)).body).toMatchObject({ result: { tools: [{ name: 'echo' }] } })
    const called = await post(port, '/mcp/test', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } }, auth)
    expect(called.body).toEqual({ jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: 'echo {"x":1}' }] } })
    expect(calls).toEqual([['echo', { x: 1 }]])
    expect((await post(port, '/mcp/test', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } }, auth)).body).toMatchObject({ result: { isError: true } })
    expect((await post(port, '/mcp/test', { jsonrpc: '2.0', id: 7, method: 'resources/list' }, auth)).body).toMatchObject({ error: { code: -32601 } })
    const batch = await post(port, '/mcp/test', [{ jsonrpc: '2.0', id: 8, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }], auth)
    expect(batch.body).toEqual([{ jsonrpc: '2.0', id: 8, result: {} }])
    const broken = await post(port, '/mcp/test', Buffer.from('{bad'), auth)
    expect(broken.status).toBe(400)
    expect(broken.body).toMatchObject({ error: { code: -32700 } })
    // A bare string is no request: nothing to answer.
    expect((await post(port, '/mcp/test', 'hello', auth)).status).toBe(202)
  })

  it('turns a throwing tool into an error result and lets notifications/cancelled abort a call', async () => {
    let seen: AbortSignal | null = null
    const route: McpRoute = {
      name: 'Apex',
      tools: () => [{ name: 'wait', description: '', inputSchema: { type: 'object' } }, { name: 'boom', description: '', inputSchema: { type: 'object' } }],
      call: (name, _args, signal) => {
        if (name === 'boom') return Promise.reject(new Error('kaput'))
        seen = signal
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ content: [{ type: 'text', text: 'cancelled' }], isError: true })))
      },
    }
    const { port, auth } = await start(route)
    expect((await post(port, '/mcp/test', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'boom' } }, auth)).body).toMatchObject({ result: { isError: true, content: [{ text: 'Error: kaput' }] } })
    const pending = post(port, '/mcp/test', { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'wait' } }, auth)
    while (!seen) await new Promise((r) => setTimeout(r, 5))
    await post(port, '/mcp/test', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } }, auth)
    expect((await pending).body).toMatchObject({ id: 99, result: { isError: true } })
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
  })

  it('reuses a preferred port when it is free and falls back when it is taken', async () => {
    const first = new McpServer(() => null)
    servers.push(first)
    const port = await first.listen()
    const second = new McpServer(() => null)
    servers.push(second)
    expect(await second.listen(port)).not.toBe(port)
  })
})

describe('secrets and helpers', () => {
  it('derives one token per chat and compares in constant time', () => {
    const secret = newSecret()
    const a = chatToken(secret, '11111111-1111-1111-1111-111111111111')
    expect(a).not.toBe(chatToken(secret, '22222222-2222-2222-2222-222222222222'))
    expect(a).not.toBe(chatToken(newSecret(), '11111111-1111-1111-1111-111111111111'))
    expect(tokensEqual(a, a)).toBe(true)
    expect(tokensEqual(null, a)).toBe(false)
    expect(tokensEqual(`${a}x`, a)).toBe(false)
    expect(bearerOf(`Bearer ${a}`)).toBe(a)
    expect(bearerOf('Basic abc')).toBeNull()
    expect(bearerOf(undefined)).toBeNull()
    expect(loopbackHost('127.0.0.1:4000')).toBe(true)
    expect(loopbackHost('localhost')).toBe(true)
    expect(loopbackHost('apex.example:4000')).toBe(false)
  })

  it('exposes every browser member with its schema as an object', () => {
    const specs = browserToolSpecs()
    expect(specs.map((s) => s.name)).toEqual(Object.keys(memberSchemas))
    for (const spec of specs) {
      expect(spec.inputSchema.type).toBe('object')
      expect(spec.inputSchema).not.toHaveProperty('$schema')
      expect(spec.description.length).toBeGreaterThan(10)
    }
    expect(qualified(['navigate'])).toEqual(['mcp__apex__navigate'])
    expect(unqualified('mcp__apex__navigate')).toBe('navigate')
    expect(unqualified('WebSearch')).toBeNull()
  })

  it('turns executor output into MCP content', () => {
    const state = { type: 'browser_state' as const, tabs: [{ tab_id: 't1', title: 'Home', url: 'https://a.example/', active: true }], state_changes: [{ type: 'tab_opened' as const, tab_id: 't1' }] }
    expect(toMcpResult('ok')).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(toMcpResult([])).toEqual({ content: [{ type: 'text', text: 'Done.' }] })
    const out = toMcpResult([{ type: 'text', text: 'Clicked' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, state])
    expect(out.content[1]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' })
    expect(describeBrowserState(state)).toContain('t1 (active): Home — https://a.example/')
    expect(describeBrowserState(state)).toContain('Opened tab t1.')
  })

  it('quotes the add command so the secret header stays one argument', () => {
    expect(addCommand('/opt/claude', 'http://127.0.0.1:4000/mcp/outside', 'SECRET', 'darwin')).toBe("/opt/claude mcp add --transport http --scope user apex http://127.0.0.1:4000/mcp/outside --header 'Authorization: Bearer SECRET'")
    expect(addCommand('C:\\Program Files\\nodejs\\claude.cmd', 'http://127.0.0.1:4000/mcp/outside', 'SECRET', 'win32')).toBe('"C:\\Program Files\\nodejs\\claude.cmd" mcp add --transport http --scope user apex http://127.0.0.1:4000/mcp/outside --header "Authorization: Bearer SECRET"')
  })
})

// ---- ST-60: the outside route ----

const buyButton: ElementDescription = { role: 'button', name: 'Buy now', tag: 'button', inputType: null, isPassword: false, isPaymentField: false, formSubmitName: null, inForm: false, formHasPaymentFields: false }

const PAGE = { x: 0, y: 0, width: 1000, height: 800 }

function outsideSetup(policy: 'own' | 'any', approve: (description: string) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'apex-outside-'))
  const wc = (url: string) => ({ getURL: () => url, getTitle: () => 'Shop', isDestroyed: () => false, isLoading: () => false, getZoomFactor: () => 1 })
  const tabs = [{ id: 'tab-1', internalUrl: null, view: { webContents: wc('https://shop.example/'), getBounds: () => PAGE } }]
  let active = 'tab-1'
  const manager = {
    find: (id: string) => tabs.find((t) => t.id === id),
    active: () => tabs.find((t) => t.id === active) ?? null,
    activeId: () => active,
    rail: () => null,
    activate: (id: string) => {
      active = id
    },
    all: () => tabs,
    isHidden: () => false,
    isChromeDrawn: () => false,
    info: (tab: { id: string }) => ({ title: 'Shop', url: `https://${tab.id}.example/` }),
    create: () => {
      const tab = { id: `tab-${tabs.length + 1}`, internalUrl: null, view: { webContents: wc('about:blank'), getBounds: () => PAGE } }
      tabs.push(tab)
      active = tab.id
      return tab
    },
    contentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  }
  const bridge = { request: async (_wc: unknown, command: { op: string }) => (command.op === 'resolveRef' ? { ...buyButton, x: 10, y: 10 } : null) }
  const claimed: string[] = []
  const asked: string[] = []
  let enabled = true
  const deps: OutsideDeps = {
    dir,
    box: { available: () => true, encrypt: (t) => Buffer.from(t, 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') },
    executor: { tabs: manager as unknown as TabManager, bridge: bridge as never },
    approve: async (description) => {
      asked.push(description)
      return approve(description)
    },
    claim: (tabId) => claimed.push(tabId),
    release: () => claimed.splice(0),
    enabled: () => enabled,
    tabs: () => policy,
    onChange: () => undefined,
  }
  const outside = new OutsideAccess(deps)
  outside.ensureSecret()
  const secret = (outside.command('claude', 'http://x') ?? '').match(/Bearer ([^'"]+)/)?.[1] ?? ''
  return { outside, secret, claimed, asked, tabs, disable: () => (enabled = false), dir }
}

describe('outside access (ST-60)', () => {
  const signal = new AbortController().signal

  it('opens only with its own secret while switched on', () => {
    const { outside, secret, disable } = outsideSetup('any', () => false)
    expect(secret.length).toBeGreaterThan(20)
    expect(outside.route(secret)).not.toBeNull()
    expect(outside.route('not-the-secret-at-all')).toBeNull()
    expect(outside.route(null)).toBeNull()
    disable()
    expect(outside.route(secret)).toBeNull()
  })

  it('always asks before consequential actions, and a decline stops the action', async () => {
    const { outside, secret, asked, claimed } = outsideSetup('any', () => false)
    const result = await outside.route(secret)?.call('left_click', { target: { type: 'ref', ref: 'ref_1' } }, signal)
    expect(asked).toEqual(['Claude Code wants to click button "Buy now" on https://shop.example.'])
    expect(result?.isError).toBe(true)
    expect(result?.content[0]).toMatchObject({ text: expect.stringContaining('declined') })
    // Its tab carries the agent marker.
    expect(claimed).toEqual(['tab-1'])
  })

  it('under "own" it may use only the tabs it opened', async () => {
    const { outside, secret, claimed } = outsideSetup('own', () => true)
    const route = outside.route(secret)
    const refused = await route?.call('get_page_text', {}, signal)
    expect(refused?.isError).toBe(true)
    expect(refused?.content[0]).toMatchObject({ text: expect.stringContaining('only the tabs it opens') })
    const opened = await route?.call('new_tab', {}, signal)
    expect(opened?.isError).toBeFalsy()
    expect(claimed).toEqual(['tab-2'])
    expect(outside.status('http://x').activeTabs).toBe(1)
  })

  it('revoking makes a new secret, so the old command stops working', () => {
    const { outside, secret, dir } = outsideSetup('any', () => true)
    outside.rotate()
    expect(outside.route(secret)).toBeNull()
    const next = (outside.command('claude', 'http://x') ?? '').match(/Bearer ([^'"]+)/)?.[1] ?? ''
    expect(next).not.toBe(secret)
    expect(outside.route(next)).not.toBeNull()
    // The secret survives a restart (it is stored encrypted), and the status never shows it.
    const again = new OutsideAccess({ ...outsideSetup('any', () => true), dir, box: { available: () => true, encrypt: (t) => Buffer.from(t, 'utf8').reverse(), decrypt: (b) => Buffer.from(b).reverse().toString('utf8') }, executor: { tabs: {} as TabManager, bridge: {} as never }, approve: async () => false, claim: () => undefined, release: () => undefined, enabled: () => true, tabs: () => 'any', onChange: () => undefined })
    expect(again.route(next)).not.toBeNull()
    expect(again.status('http://x').command).not.toContain(next)
  })
})
