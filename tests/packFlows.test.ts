/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
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
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
  net: {},
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  webContents: { getAllWebContents: () => [] },
}))

import { NO_PACK_PERMISSIONS, PACK_MANIFEST_FILE } from '@shared/packs'
import { blankWorld } from '@shared/worlds'
import { decodeArchive, encodeArchive, packHash } from '../src/main/packs/files'
import type { PackFiles } from '../src/main/packs/manifest'
import { createPacksService } from '../src/main/packs/service'
import { AuthorKey, TrustedKeys } from '../src/main/packs/signing'
import { PackStore } from '../src/main/packs/store'
import { OwnWorlds } from '../src/main/packs/worlds'

// The flows a person goes through (docs/apps.md): Open on something that is
// off turns it on, or says plainly why it can't run; a shared world never
// takes the place of someone else's; a draft knows when it is installed.

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const themePack = (id: string, over: Record<string, unknown> = {}): PackFiles =>
  new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify({ format: 'atelier-pack', manifestVersion: 1, id, name: id, version: '1.0.0', description: 'A pack.', contributes: { themes: [{ id: 't', name: 'T', accent: '#123456' }] }, permissions: { ...NO_PACK_PERMISSIONS }, ...over }))]])

function setup(now = () => Date.UTC(2026, 10, 4, 12, 0, 0)) {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-pack-flows-'))
  dirs.push(dir)
  const store = new PackStore(dir)
  const author = new AuthorKey(join(dir, 'packs'), { encrypt: (b: Buffer) => b, decrypt: (b: Buffer) => b })
  const ownWorlds = new OwnWorlds(join(dir, 'worlds'))
  const waits = new Map<string, Array<{ kind: 'pack'; id: string }>>()
  const runtime = {
    problems: () => [],
    waiting: (id: string) => waits.get(id) ?? [],
    waitingPacks: (id: string) => (waits.get(id) ?? []).map((w) => w.id),
    isRunning: (id: string) => store.isActive(id) && !waits.has(id),
    providerOf: () => null,
    usersOf: () => [],
    assetOptions: () => [],
    secretState: () => 'none', signInSummary: () => [], connectorSummary: () => [],
    allowAskingAgain: vi.fn(),
    ownWorlds,
    tools: { reset: vi.fn() },
    sandbox: { clear: vi.fn(async () => undefined) },
    endTestRun: vi.fn(),
  }
  const service = createPacksService({ store, runtime: runtime as never, author, trusted: new TrustedKeys(join(dir, 'packs')), app: { agent: { startChat: vi.fn(() => 'chat-1'), view: vi.fn() }, skillRoutines: undefined, windows: { focused: () => null, all: () => [] } } as never, services: () => null, companionText: () => null, now })
  const archive = (files: PackFiles): Buffer => encodeArchive(files, author.sign(packHash(files)))
  return { store, service, archive, author, ownWorlds, waits, runtime }
}

describe('Open', () => {
  it('turns a pack that is off back on, and lets refused permissions be asked again', () => {
    const { store, service, archive, runtime } = setup()
    service.confirmInstall(service.reviewArchive(archive(themePack('notes')), { kind: 'file' }).token)
    service.setEnabled('notes', false)
    expect(store.isActive('notes')).toBe(false)
    service.prepareOpen('notes')
    expect(store.isActive('notes')).toBe(true)
    expect(runtime.allowAskingAgain).toHaveBeenCalledWith('notes')
  })

  it('says plainly what a pack waits for, instead of “isn’t on”', () => {
    const { service, archive, waits } = setup()
    service.confirmInstall(service.reviewArchive(archive(themePack('board')), { kind: 'file' }).token)
    waits.set('board', [{ kind: 'pack', id: 'scores' }])
    expect(() => service.prepareOpen('board')).toThrow(/board is on, and waits for/)
    expect(service.summary('board').waitingFor).toEqual(['scores'])
  })
})

describe('sharing a world', () => {
  it('gives each author’s copy an id of its own, and each share a newer version', () => {
    let at = Date.UTC(2026, 10, 4, 12, 0, 0)
    const { service, ownWorlds, author } = setup(() => at)
    ownWorlds.save(blankWorld('harbour-town-my-copy', 'Harbour town (my copy)'))
    const first = decodeArchive(service.exportWorld('own:harbour-town-my-copy').data)
    const manifest = JSON.parse((first.files.get(PACK_MANIFEST_FILE) as Buffer).toString('utf8'))
    expect(manifest.id).toBe(`world-harbour-town-my-co-${(author.keyId() ?? '').slice(0, 6)}`)
    expect(manifest.id.length).toBeLessThanOrEqual(32)
    at += 90_000
    const second = JSON.parse((decodeArchive(service.exportWorld('own:harbour-town-my-copy').data).files.get(PACK_MANIFEST_FILE) as Buffer).toString('utf8'))
    const [, d1, s1] = (manifest.version as string).split('.').map(Number) as [number, number, number]
    const [, d2, s2] = (second.version as string).split('.').map(Number) as [number, number, number]
    expect(d2 * 86_400 + s2).toBeGreaterThan(d1 * 86_400 + s1)
  })
})

describe('drafts', () => {
  it('says Installed when what is installed is exactly the draft', () => {
    const { store, service } = setup()
    store.writeDraft('mine', themePack('mine'))
    expect(service.stateNow().drafts[0]).toMatchObject({ id: 'mine', installedSame: false, installedVersion: null })
    service.confirmInstall(service.reviewDraft('mine').token)
    expect(service.stateNow().drafts[0]).toMatchObject({ installedSame: true, installedVersion: '1.0.0' })
  })
})
