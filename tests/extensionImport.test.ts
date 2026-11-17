/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// ST-46 X and ST-40 R: reading another Chromium browser's extensions from
// fixture profiles (Preferences, Secure Preferences and the Extensions
// folder), the batch and single installs against a fake store, the
// Recommended shelf's list and states, and the page's pick logic. Offline.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false }, safeStorage: { isEncryptionAvailable: () => false } }))

import { defaultExtensionPicks, type ImportableExtension } from '@shared/browserImport'
import { RECOMMENDED_EXTENSIONS, recommendedFor, recommendedIdsValid, recommendedState } from '@shared/recommendedExtensions'
import { EN } from '@shared/i18n/en'
import { browserExtensions, confirmList, extensionName, extensionSettings, fromChromeStore, installBatch, installOne, personInstalled, widensAccess, prefEnabled, profileExtensions, versionDir, type PackageFacts, type StoreInstaller } from '../src/main/importExtensions'
import { allPicks, keepPicks, reportHeadline, reportTone, togglePick, withInstalled } from '../src/renderer/src/settings/logic/extensionImportFlow'

const STORE = 'https://clients2.google.com/service/update2/crx'
const EDGE = 'https://edge.microsoft.com/extensionwebstorebase/v1/crx'
const ID = { dark: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', bw: 'nngceckbapebfimnlniiiahkandclblb', edge: 'aaaabbbbccccddddeeeeffffgggghhhh', theme: 'iiiijjjjkkkkllllmmmmnnnnoooopppp', comp: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', def: 'ghbmnnjooekpmoecnnnilnnbdlolhkhi', off: 'cjpalhdlnbpafiamejdnhcphjbkeiagm', msg: 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp' }

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'apex-extimport-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function writeExtension(profile: string, id: string, version: string, manifest: Record<string, unknown>, locales?: Record<string, Record<string, { message: string }>>): void {
  const dir = join(profile, 'Extensions', id, `${version}_0`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, version, ...manifest }))
  for (const [locale, messages] of Object.entries(locales ?? {})) {
    mkdirSync(join(dir, '_locales', locale), { recursive: true })
    writeFileSync(join(dir, '_locales', locale, 'messages.json'), JSON.stringify(messages))
  }
}

/** A profile like Arc's or Chrome's: settings split over Preferences and Secure Preferences. */
function fixtureProfile(): string {
  const profile = join(root, 'Default')
  writeExtension(profile, ID.dark, '4.9.96', { name: 'Dark Reader', update_url: STORE })
  writeExtension(profile, ID.bw, '2025.1.0', { name: 'Bitwarden', update_url: STORE })
  writeExtension(profile, ID.bw, '2025.10.1', { name: 'Bitwarden', update_url: STORE })
  writeExtension(profile, ID.edge, '1.0.0', { name: 'Edge Helper', update_url: EDGE })
  writeExtension(profile, ID.theme, '1.0.0', { name: 'A Theme', theme: { colors: {} }, update_url: STORE })
  writeExtension(profile, ID.off, '1.60.0', { name: 'Old Blocker', update_url: STORE })
  writeExtension(profile, ID.msg, '2025.5.30', { name: '__MSG_name__', default_locale: 'en_US', update_url: STORE }, { en_US: { Name: { message: 'Privacy Badger' } } })
  const prefs = { extensions: { settings: { [ID.dark]: { location: 1, path: `${ID.dark}/4.9.96_0` }, [ID.edge]: { location: 1, from_webstore: true } } } }
  const secure = {
    extensions: {
      settings: {
        [ID.dark]: { from_webstore: true, disable_reasons: [] },
        [ID.bw]: { location: 1, from_webstore: true, path: `${ID.bw}/../../evil` },
        [ID.theme]: { location: 1, from_webstore: true },
        [ID.comp]: { location: 5, path: '/Applications/Arc.app/Resources/pdf' },
        [ID.def]: { location: 6, from_webstore: true, path: `${ID.def}/1.0_0` },
        [ID.off]: { location: 1, from_webstore: true, disable_reasons: [8388608] },
        [ID.msg]: { location: 1, from_webstore: true, state: 1 },
        'not-an-id': { location: 1 },
      },
    },
  }
  writeFileSync(join(profile, 'Preferences'), JSON.stringify(prefs))
  writeFileSync(join(profile, 'Secure Preferences'), JSON.stringify(secure))
  return profile
}

describe('reading a Chromium profile’s extensions', () => {
  it('merges Preferences and Secure Preferences field by field, valid ids only', () => {
    const merged = extensionSettings({ extensions: { settings: { [ID.dark]: { location: 1 }, bad: {} } } }, null, { extensions: { settings: { [ID.dark]: { from_webstore: true } } } })
    expect([...merged.keys()]).toEqual([ID.dark])
    expect(merged.get(ID.dark)).toEqual({ location: 1, from_webstore: true })
  })

  it('reads on and off from disable_reasons (number or list) and the old state', () => {
    expect(prefEnabled({})).toBe(true)
    expect(prefEnabled({ disable_reasons: 0 })).toBe(true)
    expect(prefEnabled({ disable_reasons: [] })).toBe(true)
    expect(prefEnabled({ disable_reasons: 1 })).toBe(false)
    expect(prefEnabled({ disable_reasons: [8388608] })).toBe(false)
    expect(prefEnabled({ state: 0 })).toBe(false)
  })

  it('keeps only what the person installed', () => {
    expect(personInstalled(ID.dark, { location: 1 })).toBe(true)
    expect(personInstalled(ID.comp, { location: 1 })).toBe(false)
    expect(personInstalled(ID.dark, { location: 5 })).toBe(false)
    expect(personInstalled(ID.dark, { location: 6 })).toBe(false)
    expect(personInstalled(ID.dark, { location: 1, was_installed_by_default: true })).toBe(false)
    expect(personInstalled(ID.dark, { location: 1, was_installed_by_oem: true })).toBe(false)
  })

  it('tells the Chrome Web Store from other stores by the update address', () => {
    expect(fromChromeStore({ update_url: STORE }, null)).toBe(true)
    expect(fromChromeStore({ update_url: EDGE }, { from_webstore: true })).toBe(false)
    expect(fromChromeStore({}, { from_webstore: true })).toBe(true)
    expect(fromChromeStore({}, {})).toBe(false)
    expect(fromChromeStore(null, null)).toBe(false)
  })

  it('finds the version folder, refusing paths that leave the folder', () => {
    const profile = fixtureProfile()
    const ext = join(profile, 'Extensions')
    expect(versionDir(ext, ID.dark, `${ID.dark}/4.9.96_0`)).toBe(join(ext, ID.dark, '4.9.96_0'))
    expect(versionDir(ext, ID.bw, `${ID.bw}/../../evil`)).toBe(join(ext, ID.bw, '2025.10.1_0'))
    expect(versionDir(ext, ID.bw, `${ID.dark}/4.9.96_0`)).toBe(join(ext, ID.bw, '2025.10.1_0'))
    expect(versionDir(ext, ID.comp, null)).toBeNull()
  })

  it('resolves __MSG_ names from _locales, falling back to the id', () => {
    const profile = fixtureProfile()
    const dir = join(profile, 'Extensions', ID.msg, '2025.5.30_0')
    expect(extensionName(dir, { name: '__MSG_name__', default_locale: 'en_US' }, ID.msg)).toBe('Privacy Badger')
    expect(extensionName(null, { name: '__MSG_missing__' }, ID.msg)).toBe(ID.msg)
    expect(extensionName(null, { name: '  ', short_name: 'Short' }, ID.msg)).toBe('Short')
  })

  it('lists a profile: enabled first, by name; themes, built-ins and defaults left out', () => {
    const list = profileExtensions(fixtureProfile())
    expect(list.map((e) => e.id)).toEqual([ID.bw, ID.dark, ID.edge, ID.msg, ID.off])
    expect(list.find((e) => e.id === ID.bw)).toEqual({ id: ID.bw, name: 'Bitwarden', version: '2025.10.1', enabled: true, onStore: true })
    expect(list.find((e) => e.id === ID.edge)?.onStore).toBe(false)
    expect(list.find((e) => e.id === ID.off)).toMatchObject({ enabled: false, onStore: true })
    expect(list.find((e) => e.id === ID.msg)?.name).toBe('Privacy Badger')
  })

  it('falls back to the Extensions folder without preferences', () => {
    const profile = join(root, 'Profile 2')
    writeExtension(profile, ID.dark, '4.9.96', { name: 'Dark Reader', update_url: STORE })
    writeExtension(profile, ID.comp, '1.0', { name: 'PDF' })
    writeExtension(profile, ID.edge, '1.0.0', { name: 'Edge Helper', update_url: EDGE })
    mkdirSync(join(profile, 'Extensions', 'Temp'), { recursive: true })
    expect(profileExtensions(profile)).toEqual([
      { id: ID.dark, name: 'Dark Reader', version: '4.9.96', enabled: true, onStore: true },
      { id: ID.edge, name: 'Edge Helper', version: '1.0.0', enabled: true, onStore: false },
    ])
  })

  it('reads a detected browser’s profile and marks what this Apex profile has', () => {
    const home = root
    const arc = join(home, 'Library', 'Application Support', 'Arc', 'User Data')
    mkdirSync(arc, { recursive: true })
    writeFileSync(join(arc, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Me' } } } }))
    const profile = join(arc, 'Default')
    writeExtension(profile, ID.dark, '4.9.96', { name: 'Dark Reader', update_url: STORE })
    writeFileSync(join(profile, 'Secure Preferences'), JSON.stringify({ extensions: { settings: { [ID.dark]: { location: 1, from_webstore: true } } } }))
    const list = browserExtensions('darwin', home, {}, 'arc', 'Default', new Set([ID.dark]))
    expect(list).toEqual([{ id: ID.dark, name: 'Dark Reader', version: '4.9.96', enabled: true, onStore: true, installed: true }])
    expect(browserExtensions('darwin', home, {}, 'firefox', 'x', new Set())).toEqual([])
    expect(() => browserExtensions('darwin', home, {}, 'arc', 'Profile 9', new Set())).toThrow()
    expect(() => browserExtensions('darwin', home, {}, 'nope', 'Default', new Set())).toThrow()
  })
})

function fakeStore(over: Partial<StoreInstaller> & { store?: Record<string, PackageFacts | null>; have?: string[]; yes?: boolean } = {}): StoreInstaller & { downloads: string[]; installs: Array<[string, boolean]>; confirms: number } {
  const store = over.store ?? {}
  const io = {
    downloads: [] as string[],
    installs: [] as Array<[string, boolean]>,
    confirms: 0,
    installedIds: () => new Set(over.have ?? []),
    download: async (id: string) => {
      io.downloads.push(id)
      if (store[id] === undefined) throw new Error('network down')
      return store[id] ? Buffer.from(id) : null
    },
    inspect: (id: string) => {
      const facts = store[id]
      if (!facts) throw new Error('not verified')
      return facts
    },
    confirmBatch: async () => {
      io.confirms++
      return over.yes ?? true
    },
    prompt: async (_id: string, facts: PackageFacts) => ({ ok: over.yes ?? true, unsupported: facts.supported ? null : facts.reason }),
    install: async (id: string, _crx: Buffer, approved: boolean) => {
      io.installs.push([id, approved])
      return store[id]?.name ?? id
    },
    ...over,
  }
  return io
}

const facts = (name: string, supported = true, access: string[] = []): PackageFacts => ({ name, supported, reason: supported ? null : 'Needs side panels', manifestJson: '{}', icon: null, access })

describe('installing from the store', () => {
  it('asks once for the batch, then reports added, not on the store, unsupported and failed', async () => {
    const io = fakeStore({ store: { [ID.dark]: facts('Dark Reader'), [ID.edge]: null, [ID.msg]: facts('Privacy Badger', false) }, have: [ID.bw] })
    const report = await installBatch(
      io,
      [
        { id: ID.dark, name: 'Dark Reader', access: [] },
        { id: ID.dark, name: 'again' },
        { id: ID.bw, name: 'Bitwarden' },
        { id: ID.edge, name: 'Edge Helper' },
        { id: ID.msg, name: 'Privacy Badger' },
        { id: ID.off, name: 'Old Blocker' },
        { id: 'bad', name: 'Bad' },
      ],
      'Arc',
    )
    expect(io.confirms).toBe(1)
    expect(io.installs).toEqual([[ID.dark, false]])
    expect(report.cancelled).toBe(false)
    expect(report.added).toEqual([{ id: ID.dark, name: 'Dark Reader' }])
    expect(report.skipped.map((s) => [s.id, s.reason])).toEqual([
      [ID.bw, 'installed'],
      [ID.edge, 'notOnStore'],
      [ID.msg, 'unsupported'],
      [ID.off, 'failed'],
    ])
    expect(report.skipped.find((s) => s.id === ID.msg)?.message).toBe('Needs side panels')
  })

  it('asks the store’s own prompt only for one whose store version wants more than was shown', async () => {
    const all = 'Read and change everything on every website'
    const tabs = 'See your tabs'
    const io = fakeStore({
      store: { [ID.dark]: facts('Dark Reader', true, [all]), [ID.bw]: facts('Bitwarden', true, [all, tabs]), [ID.msg]: facts('Privacy Badger', true, [all]) },
      prompt: async (id: string) => ({ ok: id === ID.bw, unsupported: null }),
    })
    const report = await installBatch(
      io,
      [
        { id: ID.dark, name: 'Dark Reader', access: [all] },
        { id: ID.bw, name: 'Bitwarden', access: [all] },
        { id: ID.msg, name: 'Privacy Badger', access: [] },
      ],
      'Chrome',
    )
    expect(io.installs).toEqual([
      [ID.dark, false],
      [ID.bw, true],
    ])
    expect(report.skipped).toEqual([{ id: ID.msg, name: 'Privacy Badger', reason: 'declined' }])
    expect(widensAccess(undefined, [])).toBe(true)
    expect(widensAccess([all, tabs], [tabs])).toBe(false)
  })

  it('lists each one with what it can do in the confirmation, capped', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: ID.dark, name: `Ext ${i}`, access: ['A', 'B', 'C', 'D'] }))
    const lines = confirmList([{ id: ID.bw, name: 'Bitwarden', access: [] }, ...many]).split('\n')
    expect(lines[0]).toBe('Bitwarden: needs no special access')
    expect(lines[1]).toBe('Ext 0: A; B; C; 1 more')
    expect(lines).toHaveLength(11)
    expect(lines.at(-1)).toBe('and 3 more extensions')
  })

  it('fetches nothing when the person says no, and asks nothing when all are here', async () => {
    const no = fakeStore({ store: { [ID.dark]: facts('Dark Reader') }, yes: false })
    expect(await installBatch(no, [{ id: ID.dark, name: 'Dark Reader' }], null)).toEqual({ cancelled: true, added: [], skipped: [] })
    expect(no.downloads).toEqual([])
    const here = fakeStore({ have: [ID.dark] })
    const report = await installBatch(here, [{ id: ID.dark, name: 'Dark Reader' }], null)
    expect(here.confirms).toBe(0)
    expect(report.skipped).toEqual([{ id: ID.dark, name: 'Dark Reader', reason: 'installed' }])
  })

  it('adds one from the shelf after the store’s own prompt', async () => {
    const io = fakeStore({ store: { [ID.dark]: facts('Dark Reader') } })
    expect(await installOne(io, { id: ID.dark, name: 'Dark Reader' })).toEqual({ cancelled: false, added: [{ id: ID.dark, name: 'Dark Reader' }], skipped: [] })
    expect(io.installs).toEqual([[ID.dark, true]])
    const declined = fakeStore({ store: { [ID.dark]: facts('Dark Reader') }, yes: false })
    expect((await installOne(declined, { id: ID.dark, name: 'Dark Reader' })).cancelled).toBe(true)
    expect(declined.installs).toEqual([])
    const unsupported = fakeStore({ store: { [ID.msg]: facts('Privacy Badger', false) } })
    expect((await installOne(unsupported, { id: ID.msg, name: 'Privacy Badger' })).skipped[0]?.reason).toBe('unsupported')
    expect((await installOne(fakeStore({ store: { [ID.edge]: null } }), { id: ID.edge, name: 'Gone' })).skipped[0]?.reason).toBe('notOnStore')
    expect((await installOne(fakeStore({ have: [ID.dark] }), { id: ID.dark, name: 'Dark Reader' })).skipped[0]?.reason).toBe('installed')
    expect((await installOne(fakeStore(), { id: 'nope', name: 'Nope' })).skipped[0]?.reason).toBe('failed')
  })
})

describe('the Recommended shelf', () => {
  it('is a short list of well-formed, unique Web Store ids with translated reasons', () => {
    expect(recommendedIdsValid()).toBe(true)
    expect(RECOMMENDED_EXTENSIONS.length).toBeGreaterThanOrEqual(6)
    expect(RECOMMENDED_EXTENSIONS.length).toBeLessThanOrEqual(10)
    for (const r of RECOMMENDED_EXTENSIONS) expect(EN[r.reason], r.id).toBeTruthy()
    expect(recommendedIdsValid([{ id: ID.dark }, { id: ID.dark }])).toBe(false)
  })

  it('shows Apple’s password extension only on macOS, as a pointer to the built-in switch', () => {
    const mac = recommendedFor('darwin')
    const apple = mac.find((r) => r.action === 'passwords-switch')
    expect(apple?.id).toBe('pejdijmoenmkgeppbflobdenhhabjlaj')
    expect(recommendedFor('linux').some((r) => r.action === 'passwords-switch')).toBe(false)
    expect(recommendedFor('win32').length).toBe(mac.length - 1)
  })

  it('picks each row’s state', () => {
    const store = { id: ID.dark, action: 'store' as const }
    const apple = { id: 'pejdijmoenmkgeppbflobdenhhabjlaj', action: 'passwords-switch' as const }
    expect(recommendedState(store, new Set(), new Set())).toBe('add')
    expect(recommendedState(store, new Set(), new Set([ID.dark]))).toBe('adding')
    expect(recommendedState(store, new Set([ID.dark]), new Set())).toBe('installed')
    expect(recommendedState(apple, new Set(), new Set())).toBe('setup')
    expect(recommendedState(apple, new Set([apple.id]), new Set())).toBe('installed')
  })
})

describe('the import page’s extension picks', () => {
  const ext = (id: string, over: Partial<ImportableExtension> = {}): ImportableExtension => ({ id, name: id, version: '1', enabled: true, onStore: true, installed: false, ...over })
  const list = [ext(ID.dark), ext(ID.bw, { enabled: false }), ext(ID.edge, { onStore: false }), ext(ID.msg, { installed: true })]

  it('starts with what was on there, is on the store and isn’t here yet', () => {
    expect(defaultExtensionPicks(list)).toEqual([ID.dark])
    expect(allPicks(list)).toEqual([ID.dark, ID.bw])
  })

  it('toggles in list order and never picks what can’t be added', () => {
    expect(togglePick([ID.dark], ID.bw, true, list)).toEqual([ID.dark, ID.bw])
    expect(togglePick([ID.dark, ID.bw], ID.dark, false, list)).toEqual([ID.bw])
    expect(togglePick([], ID.edge, true, list)).toEqual([])
    expect(togglePick([], ID.msg, true, list)).toEqual([])
  })

  it('follows installs that land meanwhile', () => {
    const live = withInstalled(list, new Set([ID.dark]))
    expect(live[0]?.installed).toBe(true)
    expect(keepPicks([ID.dark, ID.bw], live)).toEqual([ID.bw])
  })

  it('reads the report', () => {
    expect(reportHeadline({ cancelled: true, added: [], skipped: [] })).toBe('cancelled')
    expect(reportTone({ cancelled: false, added: [{ id: ID.dark, name: 'D' }], skipped: [{ id: ID.bw, name: 'B', reason: 'installed' }] })).toBe('success')
    expect(reportTone({ cancelled: false, added: [{ id: ID.dark, name: 'D' }], skipped: [{ id: ID.bw, name: 'B', reason: 'notOnStore' }] })).toBe('warning')
    expect(reportHeadline({ cancelled: false, added: [], skipped: [] })).toBe('none')
  })
})
