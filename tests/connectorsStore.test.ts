/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConnectorStore, approvalHash, type SecretCipher } from '../src/main/connectors/store'
import { checkConnectorUrl, executionOf, isPrivateHost } from '@shared/connectors'

// The Connector v2 store: migration of older records, encrypted secrets, approval
// hashes, and which connectors go to Anthropic's MCP connector.

const cipher: SecretCipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(`enc:${Buffer.from(text).toString('base64')}`),
  decrypt: (data) => {
    const s = data.toString()
    if (!s.startsWith('enc:')) throw new Error('not ours')
    return Buffer.from(s.slice(4), 'base64').toString()
  },
}

const dir = (): string => mkdtempSync(join(tmpdir(), 'apex-connectors-'))

describe('ConnectorStore migration', () => {
  it('turns older records and their id → token secrets into v2', () => {
    const d = dir()
    writeFileSync(join(d, 'connectors.json'), JSON.stringify([
      { id: 'a', name: 'linear', url: 'https://mcp.linear.app/mcp', enabled: true, owner: 'shared' },
      { id: 'b', name: 'notes', url: 'http://localhost:3000/mcp', enabled: false },
      { id: 'bad' },
    ]))
    writeFileSync(join(d, 'connector-secrets.bin'), cipher.encrypt(JSON.stringify({ a: 'tok-123456' })))
    const store = new ConnectorStore(d, cipher)
    const [a, b] = store.views()
    expect(store.views()).toHaveLength(2)
    expect(a).toMatchObject({ id: 'a', name: 'linear', displayName: 'linear', source: 'custom', auth: 'bearer', execution: 'server', hasSecret: true, hasToken: true, url: 'https://mcp.linear.app/mcp' })
    expect(a?.transport).toEqual({ kind: 'remote', url: 'https://mcp.linear.app/mcp', headerName: null })
    expect(b).toMatchObject({ auth: 'none', execution: 'local', enabled: false, owner: 'shared', health: 'unknown', tools: [] })
    // The file is rewritten in the v2 shape, and still reads back the same.
    const saved = JSON.parse(readFileSync(join(d, 'connectors.json'), 'utf8')) as { transport: unknown }[]
    expect(saved[0]?.transport).toEqual({ kind: 'remote', url: 'https://mcp.linear.app/mcp', headerName: null })
    expect(new ConnectorStore(d, cipher).views()).toEqual(store.views())
  })

  it('falls back field by field on damaged v2 records', () => {
    const d = dir()
    writeFileSync(join(d, 'connectors.json'), JSON.stringify([{ id: 'x', name: 'Odd Name', transport: { kind: 'remote', url: 'https://x.example/mcp' }, auth: 'weird', health: 'checking', labelColor: 'red', tools: [{ name: 't', policy: 'nope' }, 3] }]))
    const [c] = new ConnectorStore(d, cipher).views()
    expect(c).toMatchObject({ name: 'odd-name', auth: 'none', health: 'unknown', labelColor: null })
    expect(c?.tools).toEqual([{ name: 't', title: 't', description: '', readOnly: false, policy: 'allow', inputSchema: { type: 'object' } }])
  })
})

describe('ConnectorStore secrets', () => {
  it('keeps every secret encrypted, mode 0600, and never in views', () => {
    const d = dir()
    const store = new ConnectorStore(d, cipher)
    const c = store.save({
      name: 'Local tools',
      transport: { kind: 'local', command: 'node', args: ['server.js'], env: [{ name: 'API_KEY', value: 'very-secret-value', secret: true }, { name: 'MODE', value: 'dev', secret: false }] },
      auth: 'none',
      enabled: true,
    })
    const raw = readFileSync(join(d, 'connector-secrets.bin')).toString()
    expect(raw).not.toContain('very-secret-value')
    // Windows has no POSIX permission bits to check.
    if (process.platform !== 'win32') expect(statSync(join(d, 'connector-secrets.bin')).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(store.views())).not.toContain('very-secret-value')
    expect(c.transport).toEqual({ kind: 'local', command: 'node', args: ['server.js'], env: [{ name: 'API_KEY', secret: true, hasValue: true }, { name: 'MODE', secret: false, hasValue: true }], cwd: null })
    expect(store.secretOf(c.id).env).toEqual({ API_KEY: 'very-secret-value', MODE: 'dev' })
    // An omitted value keeps the saved one; null clears it; a dropped name drops its value.
    store.save({ id: c.id, name: 'Local tools', transport: { kind: 'local', command: 'node', args: ['server.js'], env: [{ name: 'API_KEY', secret: true }] }, auth: 'none', enabled: true })
    expect(store.secretOf(c.id).env).toEqual({ API_KEY: 'very-secret-value' })
    store.save({ id: c.id, name: 'Local tools', transport: { kind: 'local', command: 'node', args: ['server.js'], env: [{ name: 'API_KEY', value: null, secret: true }] }, auth: 'none', enabled: true })
    expect(store.secretOf(c.id).env ?? {}).toEqual({})
    // A fresh store reads the secrets back.
    store.save({ id: c.id, name: 'Local tools', transport: { kind: 'remote', url: 'https://tools.example.com/mcp' }, auth: 'bearer', secret: 'tok-abcdef', enabled: true })
    expect(new ConnectorStore(d, cipher).secretOf(c.id).token).toBe('tok-abcdef')
    store.remove(c.id)
    expect(new ConnectorStore(d, cipher).secretOf(c.id)).toEqual({})
  })

  it('refuses to save a secret without the keychain', () => {
    const store = new ConnectorStore(dir(), { ...cipher, available: () => false })
    expect(() => store.save({ name: 'x', url: 'https://x.example.com/mcp', token: 'tok-123456', enabled: true })).toThrow(/Secure storage/)
  })

  it('names the wrong field', () => {
    const store = new ConnectorStore(dir(), cipher)
    expect(() => store.save({ name: 'x', transport: { kind: 'remote', url: 'http://example.com/mcp' }, auth: 'none', enabled: true })).toThrow(/https/)
    expect(() => store.save({ name: '!!!', transport: { kind: 'remote', url: 'https://example.com/mcp' }, auth: 'none', enabled: true })).toThrow(/name/)
    expect(() => store.save({ name: 'x', transport: { kind: 'local', command: 'node', args: [], env: [{ name: 'DYLD_INSERT_LIBRARIES', value: 'x', secret: false }] }, auth: 'none', enabled: true })).toThrow(/DYLD_INSERT_LIBRARIES/)
  })
})

describe('local approval hashes (OV-09)', () => {
  it('needs approval again after any change to the command', () => {
    const store = new ConnectorStore(dir(), cipher)
    const c = store.save({ name: 'srv', transport: { kind: 'local', command: 'node', args: ['a.js'], env: [{ name: 'TOKEN', value: 'one-value', secret: true }] }, auth: 'none', enabled: true })
    expect(c.health).toBe('needs-approval')
    store.patch(c.id, { approvedHash: store.currentApprovalHash(c.id) })
    expect(store.isApproved(c.id)).toBe(true)
    expect(store.view(c.id)?.health).toBe('unknown')
    const change = (args: string[], value?: string): void => void store.save({ id: c.id, name: 'srv', transport: { kind: 'local', command: 'node', args, env: [{ name: 'TOKEN', value, secret: true }] }, auth: 'none', enabled: true })
    change(['a.js'])
    expect(store.isApproved(c.id)).toBe(true)
    change(['b.js'])
    expect(store.isApproved(c.id)).toBe(false)
    store.patch(c.id, { approvedHash: store.currentApprovalHash(c.id) })
    change(['b.js'], 'another-value')
    expect(store.isApproved(c.id)).toBe(false)
    expect(approvalHash({ kind: 'remote', url: 'https://x', headerName: null }, undefined)).toBeNull()
  })
})

describe('routing between server and local', () => {
  it('sends only public https bearer servers to Anthropic', () => {
    const store = new ConnectorStore(dir(), cipher)
    const pub = store.save({ name: 'pub', url: 'https://mcp.example.com/mcp', token: 'tok-public', enabled: true })
    const loc = store.save({ name: 'loc', url: 'http://127.0.0.1:9000/mcp', enabled: true })
    const hdr = store.save({ name: 'hdr', transport: { kind: 'remote', url: 'https://api.example.com/mcp', headerName: 'X-API-Key' }, auth: 'api-key', secret: 'k-123456', enabled: true })
    const cmd = store.save({ name: 'cmd', transport: { kind: 'local', command: 'node', args: [], env: [] }, auth: 'none', enabled: false })
    expect([pub, loc, hdr, cmd].map((c) => c.execution)).toEqual(['server', 'local', 'local', 'local'])
    expect(store.resolve([pub.id, loc.id, hdr.id, cmd.id])).toEqual([{ id: pub.id, name: 'pub', url: 'https://mcp.example.com/mcp', token: 'tok-public' }])
    expect(store.enabledIds()).toEqual([pub.id, loc.id, hdr.id])
    expect(() => store.resolve(['missing'])).toThrow(/removed/)
  })

  it('applies the URL rules', () => {
    expect(checkConnectorUrl('https://example.com/mcp')).toMatchObject({ ok: true, private: false })
    expect(checkConnectorUrl('http://localhost:3000')).toMatchObject({ ok: true, private: true })
    expect(checkConnectorUrl('http://192.168.1.4/mcp')).toMatchObject({ ok: true, private: true })
    expect(checkConnectorUrl('http://10.0.0.2')).toMatchObject({ ok: true })
    expect(checkConnectorUrl('http://example.com')).toEqual({ ok: false, problem: 'insecure' })
    expect(checkConnectorUrl('ftp://example.com')).toEqual({ ok: false, problem: 'scheme' })
    expect(checkConnectorUrl('https://me:pw@example.com')).toEqual({ ok: false, problem: 'credentials' })
    expect(checkConnectorUrl('nope')).toEqual({ ok: false, problem: 'invalid' })
    expect(isPrivateHost('[::1]')).toBe(true)
    expect(isPrivateHost('172.32.0.1')).toBe(false)
    expect(executionOf({ kind: 'remote', url: 'https://x.example.com', headerName: null }, 'oauth')).toBe('server')
    expect(executionOf({ kind: 'remote', url: 'https://x.example.com', headerName: 'X-Key' }, 'bearer')).toBe('local')
  })

  it('keeps one default per service and names extra accounts apart', () => {
    const store = new ConnectorStore(dir(), cipher)
    const one = store.save({ name: 'notion', directoryId: 'notion', source: 'directory', transport: { kind: 'remote', url: 'https://mcp.notion.com/mcp' }, auth: 'none', enabled: true })
    const two = store.save({ name: 'notion', directoryId: 'notion', source: 'directory', transport: { kind: 'remote', url: 'https://mcp.notion.com/mcp' }, auth: 'none', enabled: true })
    expect([one.name, two.name]).toEqual(['notion', 'notion-2'])
    expect([one.isDefault, two.isDefault]).toEqual([true, false])
    store.setDefault(two.id)
    expect(store.views().map((c) => c.isDefault)).toEqual([false, true])
    store.remove(two.id)
    expect(store.view(one.id)?.isDefault).toBe(true)
  })
})
