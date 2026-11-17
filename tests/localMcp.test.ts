/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseMcpConfig } from '../src/main/connectors/config'
import { ConnectorsCore } from '../src/main/connectors/core'
import { FaviconCache } from '../src/main/connectors/favicons'
import { LocalServers, mask, resolveCommand } from '../src/main/connectors/localServers'
import { localToolNames } from '../src/main/connectors/naming'
import { ConnectorStore, type SecretCipher } from '../src/main/connectors/store'

// Local (stdio) MCP servers against the fixture server, OV-09's
// approval gate, live tool policies, tool names, and pasted JSON configs.

const FIXTURE = resolve(__dirname, 'fixtures/mcp/echo-server.mjs')
const cipher: SecretCipher = { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function setup(): { core: ConnectorsCore; store: ConnectorStore } {
  const dataDir = mkdtempSync(join(tmpdir(), 'apex-local-mcp-'))
  const store = new ConnectorStore(dataDir, cipher)
  const core = new ConnectorsCore({
    store,
    dataDir,
    icons: new FaviconCache(dataDir, null),
    fetchFn: () => Promise.reject(new Error('no network in tests')),
    openSignIn: () => () => undefined,
    loginPath: async () => null,
    notify: () => undefined,
  })
  cleanups.push(() => core.dispose())
  return { core, store }
}

const localInput = (args: string[] = [FIXTURE]) => ({
  name: 'Fixture',
  transport: { kind: 'local' as const, command: process.execPath, args, env: [{ name: 'FIXTURE_SECRET', value: 'hunter2-secret', secret: true }] },
  auth: 'none' as const,
  enabled: true,
})

describe('local MCP servers', () => {
  it('never starts before its exact command is approved', async () => {
    const { core, store } = setup()
    const c = store.save(localInput())
    expect((await core.check(c.id)).health).toBe('needs-approval')
    const signal = new AbortController().signal
    const refused = await core.runtime().callLocal(c.id, 'echo', { text: 'hi' }, signal)
    expect(refused.isError).toBe(true)
    expect(core.logs(c.id)).toEqual([])
  })

  it('starts after approval, lists tools with policies, calls them and masks secrets in logs', async () => {
    const { core, store } = setup()
    const c = store.save(localInput())
    core.approveLocalStart(c.id)
    const checked = await core.check(c.id)
    expect(checked.health).toBe('ok')
    expect(checked.searchable).toBe(true)
    expect(checked.tools.map((t) => [t.name, t.policy, t.title])).toEqual([
      ['echo', 'allow', 'Echo'],
      ['add', 'ask', 'Add'],
      ['create_note', 'ask', 'Save note'],
    ])
    const rt = core.runtime()
    const signal = new AbortController().signal
    expect(await rt.callLocal(c.id, 'echo', { text: 'hello' }, signal)).toEqual({ content: [{ type: 'text', text: 'hello' }], isError: false })
    expect(core.logs(c.id).join('\n')).toContain('fixture starting with secret ••••')
    expect(core.logs(c.id).join('\n')).not.toContain('hunter2-secret')

    // Off is enforced live, even for a chat that started with the tool on.
    core.setToolPolicy(c.id, 'add', 'off')
    expect(rt.livePolicy(c.id, 'add')).toBe('off')
    expect((await rt.callLocal(c.id, 'add', { a: 1, b: 2 }, signal)).isError).toBe(true)
    expect(rt.localTools([c.id]).map((t) => t.apiName)).toEqual(['fixture__create_note', 'fixture__echo'])
    expect(rt.localTools([c.id])[0]?.actionLabel).toBe('Save note')

    // The edited form is checked against the tool's schema.
    expect(rt.validateInput(c.id, 'create_note', { title: 'x', pinned: true })).toEqual({ ok: true })
    const bad = rt.validateInput(c.id, 'create_note', { pinned: 'yes' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors.map((e) => e.path).sort()).toEqual(['/pinned', '/title'])

    // # records come from resources/list and resources/read.
    const hits = await core.search('launch')
    expect(hits).toEqual([{ connectorId: c.id, uri: 'note://plan', title: 'Launch plan', snippet: 'Steps for the launch' }])
    expect(await core.readRecord(c.id, 'note://plan')).toEqual({ title: 'Launch plan', text: 'Step one: test. Step two: ship.' })

    // Changing the command stops the server and asks for approval again.
    store.save({ ...localInput([FIXTURE, '--noise']), id: c.id })
    expect(store.view(c.id)?.health).toBe('needs-approval')
    expect((await rt.callLocal(c.id, 'echo', { text: 'x' }, signal)).isError).toBe(true)
  }, 20_000)

  it('reports a server that exits at start as an error with its output', async () => {
    const { core, store } = setup()
    const c = store.save(localInput([FIXTURE, '--crash']))
    core.approveLocalStart(c.id)
    const checked = await core.check(c.id)
    expect(checked.health).toBe('error')
    expect(core.logs(c.id).some((l) => l.includes('exited'))).toBe(true)
  }, 20_000)

  it('stops idle servers and finds bare commands on PATH only', async () => {
    let now = 0
    const states: string[] = []
    const servers = new LocalServers({ root: mkdtempSync(join(tmpdir(), 'apex-idle-')), loginPath: async () => null, home: tmpdir(), onState: (_id, s) => states.push(s.state), now: () => now })
    cleanups.push(() => servers.stopAll())
    const session = await servers.session({ id: 'x', command: process.execPath, args: [FIXTURE], cwd: null, env: {}, secrets: [] })
    expect((await session.listTools()).length).toBe(3)
    now = 11 * 60_000
    servers.reapIdleNow()
    expect(servers.isRunning('x')).toBe(false)
    expect(states).toEqual(['starting', 'ok', 'stopped'])
    expect(resolveCommand('node', '/nope:/usr/bin', (p) => p === '/usr/bin/node', 'linux')).toBe('/usr/bin/node')
    expect(resolveCommand('./node', '/usr/bin', () => true, 'linux')).toBeNull()
    // Windows: PATH split on ;, and npx is npx.cmd.
    expect(resolveCommand('npx', 'C:\\nope;C:\\Program Files\\nodejs', (p) => p === 'C:\\Program Files\\nodejs\\npx.cmd', 'win32')).toBe('C:\\Program Files\\nodejs\\npx.cmd')
    expect(resolveCommand('.\\npx', 'C:\\Program Files\\nodejs', () => true, 'win32')).toBeNull()
    expect(mask('token abc123 and abc1234', ['abc123', 'abc1234'])).toBe('token •••• and ••••')
  }, 20_000)
})

describe('local tool names', () => {
  it('orders by connector then tool, caps at 64 and hashes collisions', () => {
    const names = localToolNames([
      { connectorId: '2', connectorName: 'zeta', toolName: 'b' },
      { connectorId: '1', connectorName: 'alpha', toolName: 'list.items' },
      { connectorId: '3', connectorName: 'alpha', toolName: 'list items' },
      { connectorId: '4', connectorName: 'x'.repeat(40), toolName: 'y'.repeat(80) },
    ])
    expect(names.map((n) => n.apiName)).toEqual([
      'alpha__list_items',
      expect.stringMatching(/^alpha__list_items_[0-9a-f]{6}$/),
      `${'x'.repeat(24)}__${'y'.repeat(38)}`,
      'zeta__b',
    ])
    for (const n of names) expect(n.apiName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })
})

describe('pasted mcpServers JSON', () => {
  it('reads local and remote servers, with nothing turned on', () => {
    const out = parseMcpConfig(JSON.stringify({
      mcpServers: {
        files: { command: 'npx', args: ['-y', '@acme/files'], env: { ACME_TOKEN: 'abc', MODE: 'x' } },
        remote: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer tok-1' } },
        keyed: { type: 'http', url: 'https://api.example.com/mcp', headers: { 'X-API-Key': 'k' } },
      },
    }))
    expect(out.errors).toEqual([])
    expect(out.inputs.map((i) => [i.name, i.transport.kind, i.auth, i.enabled])).toEqual([
      ['files', 'local', 'none', false],
      ['remote', 'remote', 'bearer', false],
      ['keyed', 'remote', 'api-key', false],
    ])
    expect(out.inputs[0]?.transport).toMatchObject({ env: [{ name: 'ACME_TOKEN', value: 'abc', secret: true }, { name: 'MODE', value: 'x', secret: false }] })
    expect(out.inputs[1]?.secret).toBe('tok-1')
    expect(out.inputs[2]?.transport).toMatchObject({ headerName: 'X-API-Key' })
  })

  it('names the wrong field for each bad server', () => {
    const out = parseMcpConfig(JSON.stringify({
      mcpServers: {
        ok: { command: 'node' },
        http: { url: 'http://example.com/mcp' },
        args: { command: 'node', args: 'nope' },
        env: { command: 'node', env: { 'BAD-NAME': 'x' } },
        none: {},
        two: { url: 'https://x.example.com', headers: { A: '1', B: '2' } },
      },
    }))
    expect(out.inputs.map((i) => i.name)).toEqual(['ok'])
    expect(out.errors.map((e) => [e.index, e.field])).toEqual([
      [1, 'mcpServers.http.url'],
      [2, 'mcpServers.args.args'],
      [3, 'mcpServers.env.env'],
      [4, 'mcpServers.none.command'],
      [5, 'mcpServers.two.headers'],
    ])
    expect(parseMcpConfig('{ nope').errors[0]?.field).toBe('json')
    expect(parseMcpConfig('[]').errors[0]?.field).toBe('json')
    expect(parseMcpConfig(JSON.stringify({ command: 'uvx', args: ['tool'] })).inputs).toHaveLength(1)
  })
})
