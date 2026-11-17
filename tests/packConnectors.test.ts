/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  session: { fromPartition: () => ({}) },
}))

import { NO_PACK_PERMISSIONS, PACK_MANIFEST_FILE, describePackPermissions, permissionDiff, setPackConnectorNames, type PackManifest } from '@shared/packs'
import { ConnectorsCore } from '../src/main/connectors/core'
import { FaviconCache } from '../src/main/connectors/favicons'
import { ConnectorStore, type SecretCipher } from '../src/main/connectors/store'
import { validatePack, type PackFiles } from '../src/main/packs/manifest'
import { ceilingProblems, parsePolicy } from '../src/main/packs/policy'

// Connectors in apps (docs/apps.md › Apps for organisations): what a
// manifest may name, what the review says, the organisation's ceiling, and
// the connectors' side: finding the one an app names, and running its tools
// as the person set them (off refuses, a local server needs its approval).

const FIXTURE = resolve(__dirname, 'fixtures/mcp/echo-server.mjs')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const manifest = (over: Partial<PackManifest> = {}): PackManifest => ({
  format: 'atelier-pack',
  manifestVersion: 2,
  id: 'tickets',
  name: 'Tickets',
  version: '1.0.0',
  description: 'The team’s open issues.',
  contributes: { apps: [{ id: 'main', name: 'Tickets', root: 'app', entry: 'index.html', build: 'kit', kind: 'tool' }] },
  permissions: { ...NO_PACK_PERMISSIONS, connectors: ['atlassian', 'github'] },
  ...over,
})
const problems = (m: PackManifest): string => {
  const files: PackFiles = new Map([
    [PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(m))],
    ['app/index.html', Buffer.from('<!doctype html><script type="module" src="./main.js"></script>')],
    ['app/main.js', Buffer.from('export {}\n')],
  ])
  const check = validatePack(files)
  return check.ok ? '' : check.problems.join('\n')
}

describe('the manifest: permissions.connectors', () => {
  it('names connectors by directory id or server name', () => {
    expect(problems(manifest())).toBe('')
    expect(problems(manifest({ permissions: { ...NO_PACK_PERMISSIONS, connectors: ['Atlassian'] } }))).toMatch(/directory id or server name/)
    expect(problems(manifest({ permissions: { ...NO_PACK_PERMISSIONS, connectors: ['github', 'github'] } }))).toMatch(/listed twice/)
    expect(problems(manifest({ manifestVersion: 1 }))).toMatch(/connectors needs "manifestVersion": 2/)
  })

  it('needs code that calls them', () => {
    expect(problems(manifest({ contributes: { skills: ['skills/a'] } }))).toMatch(/only panels, apps, tools and cards call connectors/)
  })

  it('says on the review which connectors it uses, and asks again for a new one', () => {
    const line = describePackPermissions(manifest()).find((l) => l.kind === 'usesConnectors')
    expect(line).toMatchObject({ level: 'warning', vars: { names: 'atlassian, github' } })
    const more = manifest({ permissions: { ...NO_PACK_PERMISSIONS, connectors: ['atlassian', 'github', 'linear'] } })
    expect(permissionDiff(manifest(), more)).toMatchObject([{ kind: 'usesConnectors', vars: { names: 'linear' } }])
  })

  it('names them as people know them, once main says how', () => {
    setPackConnectorNames((ref) => (ref === 'atlassian' ? 'Jira and Confluence' : ref === 'github' ? 'GitHub' : ref))
    try {
      expect(describePackPermissions(manifest()).find((l) => l.kind === 'usesConnectors')?.vars.names).toBe('Jira and Confluence, GitHub')
    } finally {
      setPackConnectorNames((ref) => ref)
    }
  })

  it('stays within the organisation’s ceiling', () => {
    const { policy } = parsePolicy({ PackPermissionCeiling: JSON.stringify({ connectors: ['atlassian'] }) }, 'test')
    expect(ceilingProblems(policy.ceiling, manifest()).join()).toMatch(/github/)
    expect(ceilingProblems(policy.ceiling, manifest({ permissions: { ...NO_PACK_PERMISSIONS, connectors: ['atlassian'] } }))).toEqual([])
  })
})

describe('the connectors an app uses', () => {
  const cipher: SecretCipher = { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() }
  function setup(): { core: ConnectorsCore; store: ConnectorStore } {
    const dataDir = mkdtempSync(join(tmpdir(), 'atelier-pack-connectors-'))
    const store = new ConnectorStore(dataDir, cipher)
    const core = new ConnectorsCore({ store, dataDir, icons: new FaviconCache(dataDir, null), fetchFn: () => Promise.reject(new Error('no network in tests')), openSignIn: () => () => undefined, loginPath: async () => null, notify: () => undefined })
    cleanups.push(() => core.dispose())
    return { core, store }
  }
  const local = { transport: { kind: 'local' as const, command: process.execPath, args: [FIXTURE], env: [] }, auth: 'none' as const }

  it('finds one by its server name or directory entry, the default and switched-on one first', () => {
    const { core, store } = setup()
    const rt = core.runtime()
    expect(rt.forApp?.('notes')).toBeNull()
    const off = store.save({ ...local, name: 'notes', enabled: false })
    expect(rt.forApp?.('notes')).toMatchObject({ id: off.id, enabled: false })
    const on = store.save({ ...local, name: 'notes-2', displayName: 'Team notes', directoryId: 'notes', enabled: true })
    expect(rt.forApp?.('notes')).toMatchObject({ id: on.id, name: 'Team notes', enabled: true })
  })

  it('runs a tool once the local server is approved, and never one the person turned off', async () => {
    const { core, store } = setup()
    const rt = core.runtime()
    const c = store.save({ ...local, name: 'notes', enabled: true })
    const signal = new AbortController().signal
    expect((await rt.callForApp?.(c.id, 'echo', { text: 'hi' }, signal))?.isError).toBe(true)
    core.approveLocalStart(c.id)
    await core.check(c.id)
    const ran = await rt.callForApp?.(c.id, 'echo', { text: 'hi' }, signal)
    expect(ran).toMatchObject({ isError: false, content: [{ type: 'text', text: 'hi' }] })
    core.setToolPolicy(c.id, 'echo', 'off')
    expect((await rt.callForApp?.(c.id, 'echo', { text: 'hi' }, signal))?.isError).toBe(true)
  })
})
