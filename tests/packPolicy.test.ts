/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false, getAppPath: () => tmpdir(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle: vi.fn(), on: vi.fn(), off: vi.fn(), removeHandler: vi.fn() },
  session: { fromPartition: () => ({}) },
  BrowserWindow: Object.assign(vi.fn(), { getFocusedWindow: () => null, getAllWindows: () => [] }),
  clipboard: { writeText: vi.fn() },
  dialog: {},
  shell: {},
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  net: {},
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  webContents: { getAllWebContents: () => [] },
}))

import { NO_PACK_PERMISSIONS, PACK_MANIFEST_FILE, type PackManifest } from '@shared/packs'
import { parseValues } from '../src/main/system/registry'
import { NO_POLICY, ceilingProblems, parsePolicy, policyRefusal, readPolicy } from '../src/main/packs/policy'
import { encodeArchive, packHash, sha256 } from '../src/main/packs/files'
import type { PackFiles } from '../src/main/packs/manifest'
import { createPacksService } from '../src/main/packs/service'
import { AuthorKey, TrustedKeys } from '../src/main/packs/signing'
import { PackStore } from '../src/main/packs/store'

// Organisation policies (docs/apps.md › Apps for organisations): each value
// read on its own, who may come in and from where, the permission ceiling,
// and reading them from Group Policy, a profile or a file. Without a policy
// every rule is a no-op.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const m = (over: Partial<PackManifest> = {}): PackManifest => ({ format: 'apex-pack', manifestVersion: 2, id: 'board', name: 'Board', version: '1.0.0', description: '', contributes: { apps: [{ id: 'main', name: 'Board', root: 'app', entry: 'index.html', build: 'kit', kind: 'tool' }] }, permissions: { ...NO_PACK_PERMISSIONS }, ...over })
const KEY = '0123456789abcdef'

describe('reading a policy', () => {
  it('takes lists as JSON text and booleans as 0 or 1, as Group Policy stores them; a bad value voids only itself', () => {
    const { policy, problems } = parsePolicy({ PackIndexes: '["https://packs.corp.example/index.json"]', PackSideloading: 0, PackBlocklist: '["*"]', PackAllowlist: '[42]', SomethingElse: 'x' }, 'HKLM')
    expect(policy).toMatchObject({ managed: true, source: 'HKLM', indexes: ['https://packs.corp.example/index.json'], sideloading: false, block: ['*'], allow: null })
    expect(problems).toEqual([expect.stringMatching(/^PackAllowlist:/)])
  })

  it('is no policy at all when nothing it knows is set', () => {
    expect(parsePolicy({ Unrelated: 1 }, 'x').policy).toMatchObject({ managed: false, source: null })
  })

  it('reads every named value reg.exe prints', () => {
    const out = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\${BRAND_NAME}\r\n    PackSideloading    REG_DWORD    0x0\r\n    PackIndexes    REG_SZ    ["https://a.example/i.json"]\r\n`
    expect(parseValues(out)).toEqual({ PackSideloading: 0, PackIndexes: '["https://a.example/i.json"]' })
  })

  it('lets the machine’s policy win over the user’s on Windows, and finds none where none is', async () => {
    const values: Record<string, Record<string, string | number>> = {
      [`HKEY_CURRENT_USER\\SOFTWARE\\Policies\\${BRAND_NAME}`]: { PackSideloading: 1, PackBlocklist: '["games"]' },
      [`HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\${BRAND_NAME}`]: { PackSideloading: 0 },
    }
    const win = await readPolicy({ platform: 'win32', readValues: async (k) => values[k] ?? {} })
    expect(win.policy).toMatchObject({ managed: true, sideloading: false, block: ['games'], source: `HKLM\\SOFTWARE\\Policies\\${BRAND_NAME}` })
    expect((await readPolicy({ platform: 'win32', readValues: async () => ({}) })).policy).toBe(NO_POLICY)
    expect((await readPolicy({ platform: 'linux' })).policy.managed).toBe(false)
  })

  it('reads a smoke run’s policy from a file, and only in a smoke run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-policy-'))
    dirs.push(dir)
    const file = join(dir, 'policy.json')
    writeFileSync(file, JSON.stringify({ PackSideloading: false }))
    expect((await readPolicy({ platform: 'linux', smoke: true, env: { APEX_SMOKE_POLICY_FILE: file } })).policy.sideloading).toBe(false)
    expect((await readPolicy({ platform: 'linux', smoke: false, env: { APEX_SMOKE_POLICY_FILE: file } })).policy.managed).toBe(false)
  })
})

describe('who may come in', () => {
  const policy = (raw: Record<string, unknown>) => parsePolicy(raw, 'test').policy

  it('lets everything in without a policy', () => {
    expect(policyRefusal(NO_POLICY, m(), null, { kind: 'file' })).toBeNull()
  })

  it(`blocks by id or author key, lets the allowlist and trusted keys through, and never refuses what ${BRAND_NAME} brings or forces`, () => {
    const p = policy({ PackBlocklist: ['*'], PackAllowlist: ['notes'], PackTrustedKeys: [KEY] })
    expect(policyRefusal(p, m(), null, { kind: 'index', url: 'https://x' })).toMatch(/blocks/)
    expect(policyRefusal(p, m({ id: 'notes' }), null, { kind: 'file' })).toBeNull()
    expect(policyRefusal(p, m(), KEY, { kind: 'file' })).toBeNull()
    expect(policyRefusal(p, m(), null, { kind: 'first-party' })).toBeNull()
    expect(policyRefusal(p, m(), null, { kind: 'file' }, true)).toBeNull()
    expect(policyRefusal(policy({ PackBlocklist: [`key:${KEY}`] }), m(), KEY, { kind: 'file' })).toMatch(/blocks/)
    expect(policyRefusal(policy({ PackAllowlist: ['notes'] }), m(), null, { kind: 'file' })).toMatch(/allows only/)
  })

  it('keeps packs to the organisation’s indexes when sideloading is off or the indexes are set', () => {
    expect(policyRefusal(policy({ PackSideloading: false }), m(), null, { kind: 'link', url: 'https://x' })).toMatch(/only from its indexes/)
    expect(policyRefusal(policy({ PackSideloading: false }), m(), null, { kind: 'dev' })).toMatch(/only from its indexes/)
    expect(policyRefusal(policy({ PackIndexes: ['https://corp/i.json'] }), m(), null, { kind: 'index', url: 'https://other/i.json' })).toMatch(/doesn’t use this index/)
    expect(policyRefusal(policy({ PackIndexes: ['https://corp/i.json'] }), m(), null, { kind: 'index', url: 'https://corp/i.json' })).toBeNull()
  })

  it('holds packs under the permission ceiling, optional permissions and keys included', () => {
    const ceiling = { network: ['*.corp.example'], model: false, secrets: false }
    expect(ceilingProblems(ceiling, m({ permissions: { ...NO_PACK_PERMISSIONS, network: ['api.corp.example'] } }))).toEqual([])
    expect(ceilingProblems(ceiling, m({ permissions: { ...NO_PACK_PERMISSIONS, network: ['api.other.example'] } }))).toEqual(['sending requests to api.other.example'])
    expect(ceilingProblems(ceiling, m({ optionalPermissions: { model: true } }))).toEqual(['using a model account'])
    expect(ceilingProblems(ceiling, m({ secrets: [{ id: 'K', name: 'K', hosts: ['api.corp.example'], header: 'Authorization' }] }))).toEqual(['asking for keys'])
    expect(policyRefusal(parsePolicy({ PackPermissionCeiling: ceiling }, 't').policy, m({ permissions: { ...NO_PACK_PERMISSIONS, model: true } }), null, { kind: 'file' })).toMatch(/using a model account/)
  })
})

describe('a policy in effect', () => {
  const themePack = (id: string): PackFiles =>
    new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify({ format: 'apex-pack', manifestVersion: 1, id, name: id, version: '1.0.0', description: 'A pack.', contributes: { themes: [{ id: 't', name: 'T', accent: '#123456' }] }, permissions: { ...NO_PACK_PERMISSIONS } }))]])

  function setup(served: Record<string, Buffer> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'apex-policy-wired-'))
    dirs.push(dir)
    const store = new PackStore(dir)
    const author = new AuthorKey(join(dir, 'packs'), { encrypt: (b: Buffer) => b, decrypt: (b: Buffer) => b })
    const runtime = { problems: () => [], waiting: () => [], providerOf: () => null, usersOf: () => [], waitingPacks: () => [], allowAskingAgain: () => undefined, assetOptions: () => [], secretState: () => 'none', signInSummary: () => [], connectorSummary: () => [], tools: { reset: vi.fn() }, sandbox: { clear: vi.fn(async () => undefined) }, endTestRun: vi.fn() }
    const fetcher = vi.fn(async (url: string) => (served[url] ? new Response(new Uint8Array(served[url] as Buffer)) : new Response('nope', { status: 404 }))) as unknown as typeof fetch
    const service = createPacksService({ store, runtime: runtime as never, author, trusted: new TrustedKeys(join(dir, 'packs')), app: { agent: { startChat: vi.fn() }, skillRoutines: undefined } as never, services: () => null, companionText: () => null, fetch: fetcher })
    const archive = (files: PackFiles): Buffer => encodeArchive(files, author.sign(packHash(files)))
    return { store, service, archive }
  }

  it('stops a pack it blocks and says why, and lets it run again when the policy goes', () => {
    const { store, service, archive } = setup()
    service.confirmInstall(service.reviewArchive(archive(themePack('games')), { kind: 'file' }).token)
    expect(store.isActive('games')).toBe(true)
    store.setPolicy(parsePolicy({ PackBlocklist: ['games'] }, 't').policy)
    expect(store.isActive('games')).toBe(false)
    expect(store.active().map((p) => p.manifest.id)).not.toContain('games')
    expect(service.summary('games').problems).toContain('Your organisation blocks this pack.')
    store.setPolicy(NO_POLICY)
    expect(store.isActive('games')).toBe(true)
  })

  it('refuses sideloads in the review and again on install, and keeps Browse to the organisation’s indexes', async () => {
    const { store, service, archive } = setup()
    // Already here from a file: it keeps working; only new installs follow the rule.
    service.confirmInstall(service.reviewArchive(archive(themePack('kept')), { kind: 'file' }).token)
    const review = service.reviewArchive(archive(themePack('notes')), { kind: 'file' })
    store.setPolicy(parsePolicy({ PackSideloading: false, PackIndexes: ['https://corp.example/index.json'] }, 't').policy)
    expect(() => service.confirmInstall(review.token)).toThrow(/only from its indexes/)
    expect(service.reviewArchive(archive(themePack('notes')), { kind: 'link', url: 'https://x.example/n.apexpack' }).problems).toContain('Your organisation lets packs in only from its indexes.')
    expect(service.stateNow().policy).toEqual({ managed: true, sideloading: false, indexesLocked: true, audit: false, aiProvider: false })
    expect(store.indexes().map((i) => i.url)).toEqual(['https://corp.example/index.json'])
    await expect(service.addIndex('https://mine.example/index.json')).rejects.toThrow(/chooses the indexes/)
    expect(store.isActive('kept')).toBe(true)
  })

  it('installs what it forces, checked against its hash, and keeps it on and installed', async () => {
    const url = 'https://corp.example/tools.apexpack'
    const maker = setup()
    const data = maker.archive(themePack('corp-tools'))
    const { store, service } = setup({ [url]: data })
    store.setPolicy(parsePolicy({ PackForceInstall: [{ url, sha256: sha256(data) }], PackBlocklist: ['*'] }, 't').policy)
    expect(await service.applyPolicy()).toEqual([])
    expect(store.isActive('corp-tools')).toBe(true)
    expect(service.summary('corp-tools').managed).toBe(true)
    expect(() => service.setEnabled('corp-tools', false)).toThrow(/can’t be turned off or removed/)
    expect(() => service.remove('corp-tools')).toThrow(/can’t be turned off or removed/)
    store.setPolicy(parsePolicy({ PackForceInstall: [{ url: 'https://corp.example/other.apexpack', sha256: 'a'.repeat(64) }] }, 't').policy)
    expect((await service.applyPolicy())[0]).toMatch(/other\.apexpack/)
  })

  it('changes nothing without a policy', () => {
    const { store, service, archive } = setup()
    const review = service.reviewArchive(archive(themePack('plain')), { kind: 'file' })
    expect(review.problems).toEqual([])
    service.confirmInstall(review.token)
    expect(service.summary('plain')).toMatchObject({ managed: false, problems: [] })
    expect(service.stateNow().policy).toEqual({ managed: false, sideloading: true, indexesLocked: false, audit: false, aiProvider: false })
    expect(store.policyRefusal('plain')).toBeNull()
  })
})

describe('the audit log', () => {
  it('is on with PackAuditLog, as a DWORD too', () => {
    expect(parsePolicy({ PackAuditLog: 1 }, 't').policy.audit).toBe(true)
    expect(parsePolicy({}, 't').policy.audit).toBe(false)
  })

  it('records a permission a pack used through the bridge, after it went through', async () => {
    const { createBridge } = await import('../src/main/packs/bridge')
    const audited: string[] = []
    const ipc = (await import('electron')).ipcMain as unknown as { handle: ReturnType<typeof vi.fn> }
    ipc.handle.mockClear()
    createBridge({
      contextOf: () => ({ packId: 'board', mode: 'installed', manifest: m({ permissions: { ...NO_PACK_PERMISSIONS, clipboard: true } }) }),
      targetFor: () => null,
      isToolHost: () => false,
      storage: { read: () => ({}), write: () => undefined },
      log: () => undefined,
      notify: () => undefined,
      ask: async () => '',
      copy: () => undefined,
      open: () => undefined,
      installedGrants: () => null,
      plugin: {} as never,
      audit: (_ctx, op, detail) => audited.push(`${op}${detail ? ` ${detail}` : ''}`),
    })
    const invoke = ipc.handle.mock.calls[0]?.[1] as (event: unknown, payload: unknown) => Promise<{ ok: boolean }>
    const sender = { isDestroyed: () => false, mainFrame: {}, getURL: () => 'apex-pack://board/app/index.html' }
    const event = { sender, senderFrame: sender.mainFrame }
    expect((await invoke(event, { op: 'clipboard.write', args: ['hi'] })).ok).toBe(true)
    expect((await invoke(event, { op: 'storage.keys', args: [] })).ok).toBe(true)
    expect((await invoke(event, { op: 'notify', args: [{ title: 'x' }] })).ok).toBe(false)
    expect(audited).toEqual(['clipboard.write'])
  })

  it('can’t be cleared while the policy keeps it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-policy-audit-'))
    dirs.push(dir)
    const store = new PackStore(dir)
    const author = new AuthorKey(join(dir, 'packs'), { encrypt: (b: Buffer) => b, decrypt: (b: Buffer) => b })
    const runtime = { problems: () => [], waiting: () => [], providerOf: () => null, usersOf: () => [], waitingPacks: () => [], allowAskingAgain: () => undefined, assetOptions: () => [], secretState: () => 'none', signInSummary: () => [], connectorSummary: () => [], tools: { reset: vi.fn() }, sandbox: { clear: vi.fn(async () => undefined) }, endTestRun: vi.fn() }
    const service = createPacksService({ store, runtime: runtime as never, author, trusted: new TrustedKeys(join(dir, 'packs')), app: { agent: { startChat: vi.fn() }, skillRoutines: undefined } as never, services: () => null, companionText: () => null })
    store.setPolicy(parsePolicy({ PackAuditLog: true }, 't').policy)
    expect(() => service.clearLog('board')).toThrow(/keeps this log/)
    expect(service.stateNow().policy.audit).toBe(true)
  })
})

describe('AiProvider: the organisation’s model gateway', () => {
  it('reads the gateway, its token or key, and its model names', () => {
    const { policy, problems } = parsePolicy({ AiProvider: JSON.stringify({ url: 'https://ai.contoso.example/', token: 't-1', models: { fast: 'contoso-fast' } }) }, 'test')
    expect(problems).toEqual([])
    expect(policy.managed).toBe(true)
    expect(policy.aiProvider).toEqual({ url: 'https://ai.contoso.example', key: null, token: 't-1', models: { fast: 'contoso-fast' } })
  })

  it('needs https and exactly one of a key or a token, and a bad value voids only itself', () => {
    for (const bad of [{ url: 'http://ai.contoso.example', key: 'k' }, { url: 'https://ai.contoso.example' }, { url: 'https://ai.contoso.example', key: 'k', token: 't' }]) {
      const { policy, problems } = parsePolicy({ AiProvider: JSON.stringify(bad), PackAuditLog: 1 }, 'test')
      expect(problems.join()).toMatch(/AiProvider/)
      expect(policy.aiProvider).toBeNull()
      expect(policy.audit).toBe(true)
    }
    expect(NO_POLICY.aiProvider).toBeNull()
  })
})
