/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
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

import { NO_PACK_PERMISSIONS, PACK_MANIFEST_FILE } from '@shared/packs'
import { filterBrowse } from '../src/renderer/src/packs/logic'
import { encodeArchive, packHash } from '../src/main/packs/files'
import type { PackFiles } from '../src/main/packs/manifest'
import { createPacksService } from '../src/main/packs/service'
import { downloadImage, parseIndex } from '../src/main/packs/sharing'
import { AuthorKey, TrustedKeys } from '../src/main/packs/signing'
import { PackStore } from '../src/main/packs/store'
import { parsePolicy } from '../src/main/packs/policy'

// The community index for apps and worlds (docs/apps.md › The community
// index): what an entry is, its picture and shelf, withdrawn ids, Browse's
// filter, and that nobody's Apex fetches an index it doesn't need.

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'apex-pack-index-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const entry = (over: Record<string, unknown> = {}) => ({ id: 'cafe', name: 'Café', version: '1.0.0', url: 'https://x.test/cafe.apexapp', sha256: 'a'.repeat(64), ...over })
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest')])

describe('the index format', () => {
  it('reads kind, picture, shelf, size and colour, and an older entry as a pack', () => {
    const index = parseIndex(JSON.stringify({ format: 'apex-pack-index', packs: [entry({ kind: 'app', image: 'https://x.test/cafe.png', category: 'games', size: 54_000_000, color: '#FF8A5C' }), entry({ id: 'old' })] }))
    expect(index.packs[0]).toMatchObject({ kind: 'app', image: 'https://x.test/cafe.png', category: 'games', size: 54_000_000, color: '#FF8A5C' })
    expect(index.packs[1]).toMatchObject({ id: 'old', kind: 'pack' })
    expect(index.withdrawn).toEqual([])
  })

  it('skips an entry with a picture somewhere Apex doesn’t fetch, or an unknown kind', () => {
    const index = parseIndex(JSON.stringify({ format: 'apex-pack-index', packs: [entry({ image: 'http://x.test/a.png' }), entry({ id: 'odd', kind: 'plugin' })] }))
    expect(index.packs).toEqual([])
    expect(index.skipped).toBe(2)
  })

  it('never offers a withdrawn id, and lists why', () => {
    const index = parseIndex(JSON.stringify({ format: 'apex-pack-index', packs: [entry(), entry({ id: 'kept' })], withdrawn: [{ id: 'cafe', reason: 'Uses art it may not share.' }, { id: 'BAD ID' }] }))
    expect(index.packs.map((p) => p.id)).toEqual(['kept'])
    expect(index.withdrawn).toEqual([{ id: 'cafe', reason: 'Uses art it may not share.' }])
  })

  it('takes a picture only as PNG or JPEG', async () => {
    const serve = (body: Buffer) => vi.fn(async () => new Response(new Uint8Array(body))) as unknown as typeof fetch
    expect((await downloadImage('https://x.test/a.png', serve(PNG))).mediaType).toBe('image/png')
    expect((await downloadImage('https://x.test/a.jpg', serve(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1])))).mediaType).toBe('image/jpeg')
    await expect(downloadImage('https://x.test/a.svg', serve(Buffer.from('<svg/>')))).rejects.toThrow(/not a PNG or JPEG/)
  })
})

describe('Browse', () => {
  const entries = [
    { id: 'cafe', name: 'Corner café', description: 'Run a busy café.', author: 'Ana', kind: 'app' },
    { id: 'harbour', name: 'Harbour', description: 'A seaside town.', author: null, kind: 'world' },
    { id: 'notes', name: 'Notes', description: 'Quick notes in a panel.', author: 'Bo', kind: 'pack' },
  ]
  it('filters by kind and by every word of the search', () => {
    expect(filterBrowse(entries, 'all', '').map((e) => e.id)).toEqual(['cafe', 'harbour', 'notes'])
    expect(filterBrowse(entries, 'world', '').map((e) => e.id)).toEqual(['harbour'])
    expect(filterBrowse(entries, 'all', 'run BUSY').map((e) => e.id)).toEqual(['cafe'])
    expect(filterBrowse(entries, 'all', 'ana').map((e) => e.id)).toEqual(['cafe'])
    expect(filterBrowse(entries, 'app', 'seaside')).toEqual([])
  })
})

describe('the service', () => {
  const INDEX = 'https://index.test/index.json'
  function setup(index: Record<string, unknown>) {
    const dir = tmp()
    const store = new PackStore(dir)
    const vault = { encrypt: (b: Buffer) => b, decrypt: (b: Buffer) => b }
    const author = new AuthorKey(join(dir, 'packs'), vault)
    const runtime = { problems: () => [], waiting: () => [], providerOf: () => null, usersOf: () => [], waitingPacks: () => [], allowAskingAgain: () => undefined, assetOptions: () => [], secretState: () => 'none', signInSummary: () => [], connectorSummary: () => [], tools: { reset: vi.fn() }, sandbox: { clear: vi.fn(async () => undefined) }, endTestRun: vi.fn() }
    const fetched: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      fetched.push(url)
      if (url === INDEX) return new Response(JSON.stringify(index))
      if (url === 'https://index.test/cafe.png') return new Response(new Uint8Array(PNG))
      return new Response('nope', { status: 404 })
    }) as unknown as typeof fetch
    const service = createPacksService({ store, runtime: runtime as never, author, trusted: new TrustedKeys(join(dir, 'packs')), app: { agent: { startChat: vi.fn() }, skillRoutines: undefined } as never, services: () => null, companionText: () => null, fetch: fetcher })
    store.saveIndex({ url: INDEX, name: 'Community', addedAt: 1, lastError: null })
    return { store, author, service, fetched }
  }
  const files = (id: string): PackFiles => new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify({ format: 'apex-pack', manifestVersion: 1, id, name: id, version: '1.0.0', description: 'A pack.', contributes: { themes: [{ id: 't', name: 'T', accent: '#123456' }] }, permissions: { ...NO_PACK_PERMISSIONS } }))]])

  it('lists entries with what they are, and fetches their picture once', async () => {
    const { service, fetched } = setup({ format: 'apex-pack-index', packs: [entry({ kind: 'app', image: 'https://index.test/cafe.png', category: 'games' })] })
    const [listed] = await service.browse()
    expect(listed).toMatchObject({ id: 'cafe', kind: 'app', category: 'games', hasImage: true, size: null, color: null })
    expect(await service.browseImage(INDEX, 'cafe')).toMatch(/^data:image\/png;base64,/)
    await service.browseImage(INDEX, 'cafe')
    expect(fetched.filter((u) => u.endsWith('.png'))).toHaveLength(1)
    expect(await service.browseImage(INDEX, 'unknown')).toBeNull()
  })

  it('puts a notice on an installed pack an index withdrew, and takes it away when the index does', async () => {
    const index: Record<string, unknown> = { format: 'apex-pack-index', packs: [], withdrawn: [{ id: 'mine', reason: 'Broken.' }] }
    const { store, author, service } = setup(index)
    const archive = encodeArchive(files('mine'), author.sign(packHash(files('mine'))))
    service.confirmInstall(service.reviewArchive(archive, { kind: 'index', url: INDEX }).token)
    await service.browse()
    expect(service.summary('mine').withdrawn).toEqual({ index: 'Community', reason: 'Broken.' })
    index.withdrawn = []
    await service.browse()
    expect(store.get('mine')?.entry.withdrawn ?? null).toBeNull()
  })

  it('reads no index in the daily check unless something came from one', async () => {
    const { author, service, fetched } = setup({ format: 'apex-pack-index', packs: [] })
    const archive = encodeArchive(files('local'), author.sign(packHash(files('local'))))
    service.confirmInstall(service.reviewArchive(archive, { kind: 'file' }).token)
    await service.checkUpdates()
    expect(fetched).toEqual([])
    service.confirmInstall(service.reviewArchive(encodeArchive(files('listed'), author.sign(packHash(files('listed')))), { kind: 'index', url: INDEX }).token)
    await service.checkUpdates()
    expect(fetched).toEqual([INDEX])
  })
})

describe('a private index (the organisation’s, behind its sign-in)', () => {
  const PRIVATE = 'https://apps.contoso.test/index.json'
  function setup(opts: { signedIn: boolean; status?: number }) {
    const dir = tmp()
    const store = new PackStore(dir)
    const vault = { encrypt: (b: Buffer) => b, decrypt: (b: Buffer) => b }
    const author = new AuthorKey(join(dir, 'packs'), vault)
    const signIns = { state: () => ({ signedIn: opts.signedIn, user: opts.signedIn ? 'ana@contoso.test' : null }), fresh: async () => ({ signedIn: opts.signedIn, user: null }), token: () => (opts.signedIn ? 'index-token' : null), signOut: vi.fn() }
    const runtime = { problems: () => [], waiting: () => [], providerOf: () => null, usersOf: () => [], waitingPacks: () => [], allowAskingAgain: () => undefined, assetOptions: () => [], secretState: () => 'none', signInSummary: () => [], connectorSummary: () => [], signIns, tools: { reset: vi.fn() }, sandbox: { clear: vi.fn(async () => undefined) }, endTestRun: vi.fn() }
    const seen: Array<{ url: string; auth: string | null }> = []
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') })
      if (url === PRIVATE) return opts.status ? new Response('no', { status: opts.status }) : new Response(JSON.stringify({ format: 'apex-pack-index', name: 'Contoso apps', packs: [entry({ id: 'dash', url: 'https://apps.contoso.test/dash.apexapp' })] }))
      return new Response('nope', { status: 404 })
    }) as unknown as typeof fetch
    const service = createPacksService({ store, runtime: runtime as never, author, trusted: new TrustedKeys(join(dir, 'packs')), app: { agent: { startChat: vi.fn() }, skillRoutines: undefined } as never, services: () => null, companionText: () => null, fetch: fetcher })
    const { policy } = parsePolicy({ PackIndexes: JSON.stringify([{ url: PRIVATE, name: 'Contoso apps', auth: { issuer: 'https://login.contoso.test', clientId: 'apex' } }]) }, 'test')
    store.setPolicy(policy)
    return { service, seen, signIns }
  }

  it('isn’t read before anyone signs in, and Browse says whom to sign in with', async () => {
    const { service, seen } = setup({ signedIn: false })
    expect(await service.browse()).toEqual([])
    expect(seen).toEqual([])
    expect(service.stateNow().indexes[0]).toMatchObject({ url: PRIVATE, name: 'Contoso apps', signIn: { issuer: 'login.contoso.test', signedIn: false } })
  })

  it('is read with the sign-in, which goes to its own origin and nowhere else', async () => {
    const { service, seen } = setup({ signedIn: true })
    expect((await service.browse()).map((e) => e.id)).toEqual(['dash'])
    expect(seen[0]).toEqual({ url: PRIVATE, auth: 'Bearer index-token' })
    await service.reviewIndexEntry(PRIVATE, 'dash').catch(() => undefined)
    expect(seen.find((s) => s.url.endsWith('dash.apexapp'))?.auth).toBe('Bearer index-token')
    await service.reviewLink('https://elsewhere.test/x.apexpack').catch(() => undefined)
    expect(seen.find((s) => s.url.startsWith('https://elsewhere.test'))?.auth).toBeNull()
  })

  it('offers Sign in again when the index refuses the sign-in', async () => {
    const { service, signIns } = setup({ signedIn: true, status: 401 })
    await service.browse()
    expect(signIns.signOut).toHaveBeenCalled()
  })
})
