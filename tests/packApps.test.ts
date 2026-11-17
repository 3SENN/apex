/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  session: { fromPartition: () => ({}) },
}))

import {
  APP_PACK_LIMITS,
  NO_PACK_PERMISSIONS,
  PACK_MANIFEST_FILE,
  describePackPermissions,
  isPackArchiveName,
  isPackAssetPath,
  isPackFilePath,
  packAppAt,
  packAssetPath,
  packFileLimits,
  parseAssetPath,
  parsePackRun,
  type PackApp,
  type PackManifest,
} from '@shared/packs'
import { decodeArchive, encodeArchive, packHash, peekArchiveManifest } from '../src/main/packs/files'
import { validatePack, type PackFiles } from '../src/main/packs/manifest'
import { PACK_APP_CSP, PACK_CSP, appCsp, inlineScriptHashes, parseByteRange, resolveAppPath, servePack, withImportMap, type PackFileSource } from '../src/main/packs/sandbox'
import { PackStore } from '../src/main/packs/store'
import { STARTERS, starterFiles } from '../src/main/packs/starters'

// Apps inside packs (docs/apps.md, phase 1): the manifest's apps, the limits
// a pack with an app gets, its folder's CSP, its files served from disk with
// byte ranges, and the store keeping those files out of memory.

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'atelier-pack-apps-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const game = (over: Partial<PackApp> = {}): PackApp => ({ id: 'main', name: 'Café', root: 'app', entry: 'index.html', build: 'bundled', kind: 'game', ...over })

const manifest = (apps: PackApp[] = [game()], over: Partial<PackManifest> = {}): PackManifest => ({
  format: 'atelier-pack',
  manifestVersion: 2,
  id: 'cafe',
  name: 'Café',
  version: '1.0.0',
  description: 'A café game.',
  contributes: { apps },
  permissions: { ...NO_PACK_PERMISSIONS },
  ...over,
})

const pack = (m: PackManifest, files: Record<string, string | Buffer> = {}): PackFiles =>
  new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(m))], ...Object.entries(files).map(([p, data]) => [p, Buffer.isBuffer(data) ? data : Buffer.from(data)] as [string, Buffer])])

const problems = (files: PackFiles): string => {
  const check = validatePack(files)
  return check.ok ? '' : check.problems.join('\n')
}

const MINIFIED = `var a=1;${'b();'.repeat(1_000)}\n`
const PAGE = '<!doctype html><script type="module" src="./main.js"></script>'

describe('apps in the manifest', () => {
  it('accepts a bundled app whose folder holds minified code past the review budget', () => {
    const big = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`app/assets/chunk-${i}.js`, MINIFIED.repeat(120)]))
    const check = validatePack(pack(manifest(), { 'app/index.html': PAGE, 'app/main.js': MINIFIED, ...big }))
    expect(check.ok ? check.pack.manifest.contributes.apps?.[0] : check.problems).toMatchObject({ id: 'main', root: 'app', entry: 'index.html', build: 'bundled', kind: 'game' })
  })

  it('fills the defaults', () => {
    const raw = { ...manifest(), contributes: { apps: [{ id: 'main', name: 'Café', build: 'kit' }] } }
    const check = validatePack(new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(raw))], ['app/index.html', Buffer.from(PAGE)], ['app/main.js', Buffer.from('export {}\n')]]))
    expect(check.ok ? check.pack.manifest.contributes.apps?.[0] : check.problems).toEqual({ id: 'main', name: 'Café', root: 'app', entry: 'index.html', build: 'kit', kind: 'tool' })
  })

  it('still reviews a kit app’s code, and code outside a bundled app’s folder', () => {
    expect(problems(pack(manifest([game({ build: 'kit' })]), { 'app/index.html': PAGE, 'app/main.js': MINIFIED }))).toMatch(/app\/main\.js: looks minified/)
    expect(problems(pack(manifest(), { 'app/index.html': PAGE, 'tools/x.js': MINIFIED }))).toMatch(/tools\/x\.js: looks minified/)
  })

  it('needs manifest version 2, an .html entry that exists, and folders that don’t overlap', () => {
    expect(problems(pack(manifest(undefined, { manifestVersion: 1 }), { 'app/index.html': PAGE }))).toMatch(/apps need "manifestVersion": 2/)
    expect(problems(pack(manifest(), {}))).toMatch(/app\/index\.html is not in the pack/)
    expect(problems(pack(manifest([game({ entry: 'main.js' })]), { 'app/main.js': 'x' }))).toMatch(/must be an \.html file/)
    const two = [game(), game({ id: 'editor', root: 'app/editor', kind: 'tool' })]
    expect(problems(pack(manifest(two), { 'app/index.html': PAGE, 'app/editor/index.html': PAGE }))).toMatch(/overlaps the folder/)
    expect(problems(pack(manifest([game(), game()]), { 'app/index.html': PAGE }))).toMatch(/"main" is used twice/)
  })

  it('keeps panels, tools and cards out of an app’s folder', () => {
    const m = manifest(undefined, { contributes: { apps: [game()], panels: [{ id: 'p', title: 'P', html: 'app/panel.html' }] } })
    expect(problems(pack(m, { 'app/index.html': PAGE, 'app/panel.html': PAGE }))).toMatch(/inside the app main's folder/)
  })

  it('opens an app from a command, and refuses an app it doesn’t have', () => {
    expect(parsePackRun('app:main')).toEqual({ kind: 'app', target: 'main' })
    const ok = manifest(undefined, { contributes: { apps: [game()], commands: [{ id: 'play', title: 'Play', run: 'app:main' }] } })
    expect(problems(pack(ok, { 'app/index.html': PAGE }))).toBe('')
    const missing = manifest(undefined, { contributes: { apps: [game()], commands: [{ id: 'play', title: 'Play', run: 'app:other' }] } })
    expect(problems(pack(missing, { 'app/index.html': PAGE }))).toMatch(/app:other is not in this pack/)
  })

  it('lists the app, and says when its code can’t be shown', () => {
    const lines = describePackPermissions(manifest())
    expect(lines.find((l) => l.kind === 'apps')).toMatchObject({ level: 'info', vars: { count: 1, names: 'Café' } })
    expect(lines.find((l) => l.kind === 'bundled')).toMatchObject({ level: 'notice', vars: { names: 'Café' } })
    expect(describePackPermissions(manifest([game({ build: 'kit' })])).some((l) => l.kind === 'bundled')).toBe(false)
  })

  it('lets an app’s folder hold asset names, and nothing that breaks a path or an address', () => {
    expect(isPackAssetPath('app/recipes/000-bangers & mash.png')).toBe(true)
    expect(isPackAssetPath("app/fonts/A Love of Thunder (v2).ttf")).toBe(true)
    for (const bad of ['app/a#b.png', 'app/50%.png', 'app/why?.png', 'app/ lead.png', 'app/trail.png ', 'app/dot.', 'app/CON.txt', 'app/nul', 'app/a:b', 'app/../x', '__atelier/x', 'app/a\\b']) expect(isPackAssetPath(bad), bad).toBe(false)
    expect(isPackFilePath('app/a b.png', ['app'])).toBe(true)
    expect(isPackFilePath('docs/a b.png', ['app'])).toBe(false)
    const m = manifest()
    expect(problems(pack(m, { 'app/index.html': PAGE, 'app/assets/bangers & mash.png': 'x' }))).toBe('')
    expect(problems(pack(m, { 'app/index.html': PAGE, 'notes/a b.txt': 'x' }))).toMatch(/notes\/a b\.txt: is not an allowed file path/)
    const archive = encodeArchive(pack(m, { 'app/index.html': PAGE, 'app/assets/bangers & mash.png': 'x' }), null)
    expect(decodeArchive(archive).files.has('app/assets/bangers & mash.png')).toBe(true)
  })

  it('finds the app a path belongs to', () => {
    const apps = [game(), game({ id: 'tool', root: 'tools-app' })]
    expect(packAppAt(apps, 'app/index.html')?.id).toBe('main')
    expect(packAppAt(apps, 'tools-app/a/b.js')?.id).toBe('tool')
    expect(packAppAt(apps, 'application.js')).toBeNull()
    expect(isPackArchiveName('Café-1.0.0.ATELIERAPP')).toBe(true)
    expect(isPackArchiveName('x.atelierpack')).toBe(true)
    expect(isPackArchiveName('x.zip')).toBe(false)
  })
})

describe('the limits a pack with an app gets', () => {
  const three = Buffer.alloc(3 * 1024 * 1024, 1)

  it('lets an app hold larger files, and keeps the smaller limits for every other pack', () => {
    expect(problems(pack(manifest(), { 'app/index.html': PAGE, 'app/music.m4a': three }))).toBe('')
    const plain = manifest([], { contributes: {} })
    expect(problems(pack(plain, { 'music.m4a': three }))).toMatch(/larger than 2 MB/)
    expect(packFileLimits(true)).toEqual(APP_PACK_LIMITS)
  })

  it('reads the manifest first and unzips under the limits it picks', () => {
    const files = pack(manifest(), { 'app/index.html': PAGE, 'app/music.m4a': three })
    const archive = encodeArchive(files, null)
    expect(JSON.parse(peekArchiveManifest(archive) ?? '{}').id).toBe('cafe')
    expect(packHash(decodeArchive(archive).files)).toBe(packHash(files))
    // The same file in a pack without an app still stops at 2 MB.
    const plain = encodeArchive(pack(manifest([], { contributes: {} }), { 'music.m4a': three }), null)
    expect(() => decodeArchive(plain)).toThrow(/larger than 2 MB/)
  })
})

describe('what Share… adds to an .atelierapp', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const files = pack(manifest(), { 'app/index.html': PAGE })

  it('carries a note and a PNG beside the files, outside the hash', () => {
    const archive = encodeArchive(files, null, { note: '  Try the night shift.  ', image: PNG })
    const decoded = decodeArchive(archive)
    expect(decoded.shared).toEqual({ note: 'Try the night shift.', image: PNG })
    expect(packHash(decoded.files)).toBe(packHash(files))
    expect(decoded.files.has('__atelier/share.json')).toBe(false)
  })

  it('drops an image that isn’t a PNG, and a share file that doesn’t parse', async () => {
    const { zipSync } = await import('fflate')
    const forged = Buffer.from(zipSync({ ...Object.fromEntries([...files].map(([p, d]) => [p, new Uint8Array(d)])), '__atelier/share.png': new TextEncoder().encode('<svg onload=alert(1)>'), '__atelier/share.json': new TextEncoder().encode('{"note": 5}') }))
    expect(decodeArchive(forged).shared).toEqual({ note: null, image: null })
    expect(decodeArchive(encodeArchive(files, null)).shared).toEqual({ note: null, image: null })
  })
})

describe('serving an app', () => {
  const apps = [game()]
  const source = (files: Record<string, string>, disk: Record<string, string> = {}): PackFileSource => ({
    file: (_id, path) => (files[path] === undefined ? null : Buffer.from(files[path] as string)),
    disk: (_id, path) => disk[path] ?? null,
    appAt: (_id, path) => packAppAt(apps, path),
    toolHost: () => null,
  })

  it('serves an app’s folder with the app CSP and everything else with the pack CSP', async () => {
    const src = source({ 'app/index.html': PAGE, 'panel.html': PAGE })
    const app = await servePack(src, 'cafe', 'atelier-pack://cafe/app/index.html')
    expect(app.headers.get('content-security-policy')).toBe(PACK_APP_CSP)
    expect(PACK_APP_CSP).toMatch(/worker-src 'self' blob:/)
    expect(PACK_APP_CSP).toMatch(/'wasm-unsafe-eval'/)
    expect(PACK_APP_CSP).toMatch(/default-src 'none'/)
    expect(PACK_APP_CSP).not.toMatch(/https?:/)
    const panel = await servePack(src, 'cafe', 'atelier-pack://cafe/panel.html')
    expect(panel.headers.get('content-security-policy')).toBe(PACK_CSP)
    expect((await servePack(src, 'cafe', 'atelier-pack://other/app/index.html')).status).toBe(404)
  })

  it('reads big files from disk, with byte ranges for media', async () => {
    const dir = tmp()
    const file = join(dir, 'song.mp3')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '0123456789')
    const src = source({}, { 'app/song.mp3': file })
    const whole = await servePack(src, 'cafe', 'atelier-pack://cafe/app/song.mp3')
    expect(whole.status).toBe(200)
    expect(whole.headers.get('content-type')).toBe('audio/mpeg')
    expect(await whole.text()).toBe('0123456789')
    const part = await servePack(src, 'cafe', 'atelier-pack://cafe/app/song.mp3', 'installed', 'bytes=2-5')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')
    expect((await servePack(src, 'cafe', 'atelier-pack://cafe/app/song.mp3', 'installed', 'bytes=20-')).status).toBe(416)
    expect((await servePack(src, 'cafe', 'atelier-pack://cafe/app/gone.mp3')).status).toBe(404)
  })

  it('streams a big file, whole or one span of it', async () => {
    const dir = tmp()
    const file = join(dir, 'video.webm')
    const { writeFileSync } = await import('node:fs')
    const data = Buffer.alloc(600 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = i % 251
    writeFileSync(file, data)
    const src = source({}, { 'app/video.webm': file })
    const whole = await servePack(src, 'cafe', 'atelier-pack://cafe/app/video.webm')
    expect(whole.headers.get('content-length')).toBe(String(data.length))
    expect(Buffer.from(await whole.arrayBuffer()).equals(data)).toBe(true)
    const part = await servePack(src, 'cafe', 'atelier-pack://cafe/app/video.webm', 'installed', 'bytes=300000-400000')
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 300000-400000/${data.length}`)
    expect(Buffer.from(await part.arrayBuffer()).equals(data.subarray(300000, 400001))).toBe(true)
  })

  it('reads range headers', () => {
    expect(parseByteRange(null, 10)).toBeNull()
    expect(parseByteRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 })
    expect(parseByteRange('bytes=4-100', 10)).toEqual({ start: 4, end: 9 })
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseByteRange('bytes=9-2', 10)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=0-1,4-5', 10)).toBeNull()
  })
})

describe('the store and an app’s files', () => {
  it('keeps an app’s files on disk, its icon in memory, and reads every file for export', () => {
    const m = manifest([game({ icon: 'app/icon.svg', sidebar: true })])
    const files = pack(m, { 'app/index.html': PAGE, 'app/main.js': MINIFIED, 'app/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    const store = new PackStore(tmp())
    store.install(files, { source: { kind: 'file' }, signature: 'unsigned', keyId: null, enable: true })
    expect(store.isActive('cafe')).toBe(true)
    expect(store.file('cafe', 'app/index.html')).toBeNull()
    expect(store.diskPath('cafe', 'app/index.html')).toMatch(/index\.html$/)
    expect(store.file('cafe', 'app/icon.svg')?.toString()).toMatch(/<svg/)
    expect(store.diskPath('cafe', 'app/icon.svg')).toBeNull()
    expect(store.diskPath('cafe', '../escape')).toBeNull()
    expect(packHash(store.allFiles('cafe'))).toBe(packHash(files))
    expect(store.fileSizes('cafe').map((f) => f.path).sort()).toEqual([...files.keys()].sort())
  })
})

describe('what build tools expect', () => {
  const app = game()

  it('allows a page’s own inline scripts by hash, and nothing injected later', () => {
    const html = '<script>window.boot = 1</script><script src="./x.js"></script><script type="importmap">{"imports":{}}</script><script> </script>'
    const hashes = inlineScriptHashes(html)
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    expect(hashes).toEqual([createHash('sha256').update('window.boot = 1').digest('base64'), createHash('sha256').update('{"imports":{}}').digest('base64')])
    const csp = appCsp(app, hashes)
    expect(csp).toContain(`'sha256-${hashes[0]}'`)
    expect(csp.split('; ').find((d) => d.startsWith('script-src'))).not.toContain('unsafe-inline')
    expect(csp).not.toContain("'unsafe-eval'")
    expect(appCsp({ eval: true }, [])).toContain("'unsafe-eval'")
  })

  it('finds what a request means the way static hosts do', () => {
    const files = new Set(['app/index.html', 'app/assets/a.js', 'app/about.html', 'app/blog/index.html', 'panel.html'])
    const at = (path: string, page = false) => resolveAppPath(app, path, (p) => files.has(p), page)
    expect(at('assets/a.js')).toBe('app/assets/a.js')
    expect(at('app/assets/a.js')).toBe('app/assets/a.js')
    expect(at('index.html')).toBe('app/index.html')
    expect(at('about')).toBe('app/about.html')
    expect(at('blog/')).toBe('app/blog/index.html')
    expect(at('blog')).toBe('app/blog/index.html')
    expect(at('shop/item/42', true)).toBe('app/index.html')
    expect(at('shop/item/42')).toBe('app/shop/item/42')
    expect(at('missing.png', true)).toBe('app/missing.png')
  })

  it('isolates an app that asks, and lists eval on its review', async () => {
    const isolated = [game({ isolated: true, eval: true })]
    const src: PackFileSource = { file: (_i, p) => (p === 'app/index.html' ? Buffer.from('<script>1</script>') : null), appAt: (_i, p) => packAppAt(isolated, p), toolHost: () => null }
    const res = await servePack(src, 'cafe', 'atelier-pack://cafe/app/index.html')
    expect(res.headers.get('cross-origin-embedder-policy')).toBe('require-corp')
    expect(res.headers.get('content-security-policy')).toMatch(/'unsafe-eval' 'sha256-/)
    expect(describePackPermissions(manifest(isolated)).find((l) => l.kind === 'eval')).toMatchObject({ level: 'notice' })
    expect(problems(pack(manifest(isolated), { 'app/index.html': PAGE }))).toBe('')
  })
})

describe('developer mode: a linked folder', () => {
  it('runs from the folder, reads it again on change, and is never deleted', async () => {
    const { existsSync, mkdirSync, writeFileSync } = await import('node:fs')
    const folder = join(tmp(), 'my-game')
    mkdirSync(join(folder, 'app'), { recursive: true })
    writeFileSync(join(folder, PACK_MANIFEST_FILE), JSON.stringify(manifest()))
    writeFileSync(join(folder, 'app', 'index.html'), PAGE)
    const { readPackFolder } = await import('../src/main/packs/files')
    const dataDir = tmp()
    const store = new PackStore(dataDir)
    store.install(readPackFolder(folder), { source: { kind: 'dev', url: folder }, signature: 'unsigned', keyId: null, enable: true })
    expect(existsSync(join(store.root, 'installed', 'cafe'))).toBe(false)
    expect(store.diskPath('cafe', 'app/index.html')).toBe(join(folder, 'app', 'index.html'))
    expect(store.linkedFolders()).toEqual([{ id: 'cafe', dir: folder }])

    writeFileSync(join(folder, 'app', 'index.html'), PAGE + '<!-- changed -->')
    const again = new PackStore(dataDir)
    expect(again.get('cafe')?.problems).toEqual([])
    expect(again.reloadLinked('cafe').problems).toEqual([])
    writeFileSync(join(folder, PACK_MANIFEST_FILE), '{ broken')
    expect(again.reloadLinked('cafe').problems.join(' ')).toMatch(/not valid JSON/)
    expect(again.isActive('cafe')).toBe(false)

    again.remove('cafe')
    expect(existsSync(join(folder, 'app', 'index.html'))).toBe(true)
    expect(() => store.install(new Map(), { source: { kind: 'dev', url: 'relative/path' }, signature: 'unsigned', keyId: null, enable: true })).toThrow()
  })
})

describe('start-up with big apps', () => {
  it('loads an app pack without reading its app files, then checks them in the background', async () => {
    const { writeFileSync } = await import('node:fs')
    const dir = tmp()
    const m = manifest([game({ icon: 'app/icon.svg' })])
    const files = pack(m, { 'app/index.html': PAGE, 'app/big.bin': Buffer.alloc(300 * 1024, 7), 'app/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    new PackStore(dir).install(files, { source: { kind: 'file' }, signature: 'unsigned', keyId: null, enable: true })

    const clean = new PackStore(dir, { verifyDelayMs: 60_000 })
    expect(clean.isActive('cafe')).toBe(true)
    expect(clean.get('cafe')?.onDisk.get('app/big.bin')).toBe(300 * 1024)
    expect(clean.file('cafe', 'app/icon.svg')?.toString()).toMatch(/<svg/)
    await clean.verifyNow()
    expect(clean.isActive('cafe')).toBe(true)

    writeFileSync(join(clean.root, 'installed', 'cafe', 'app', 'big.bin'), Buffer.alloc(300 * 1024, 8))
    const tampered = new PackStore(dir, { verifyDelayMs: 60_000 })
    expect(tampered.isActive('cafe')).toBe(true)
    let changed = 0
    tampered.on('changed', () => changed++)
    await tampered.verifyNow()
    expect(tampered.isActive('cafe')).toBe(false)
    expect(tampered.get('cafe')?.problems.join(' ')).toMatch(/changed on disk/)
    expect(changed).toBe(1)
  })
})

describe('asset slots and asset packs', () => {
  const diner = manifest([game({ assets: [{ id: 'art', name: 'Art', description: 'Sprites and signs.', layout: 'app/art' }] })])

  it('declares slots inside the app, unique within the pack', () => {
    expect(problems(pack(diner, { 'app/index.html': PAGE, 'app/art/sign.png': 'x' }))).toBe('')
    const outside = manifest([game({ assets: [{ id: 'art', name: 'Art', description: 'x', layout: 'elsewhere' }] })])
    expect(problems(pack(outside, { 'app/index.html': PAGE }))).toMatch(/not inside the app's folder/)
    const twice = manifest([game({ assets: [{ id: 'art', name: 'Art', description: 'x' }] }), game({ id: 'two', root: 'two', assets: [{ id: 'art', name: 'Art', description: 'x' }] })])
    expect(problems(pack(twice, { 'app/index.html': PAGE, 'two/index.html': PAGE }))).toMatch(/used by another slot/)
  })

  it('takes an asset pack of files only, big if it needs to be, and says whose app it changes', () => {
    const winter = manifest([], { id: 'winter-diner', contributes: { assets: [{ id: 'winter', name: 'Winter', for: { pack: 'cafe', app: 'main', slot: 'art' }, root: 'winter' }] } })
    expect(problems(pack(winter, { 'winter/frosty sign & menu.png': Buffer.alloc(3 * 1024 * 1024, 1) }))).toBe('')
    expect(problems(pack(winter, { 'winter/a.png': 'x', 'winter/hack.js': 'alert(1)' }))).toMatch(/winter\/hack\.js is code/)
    expect(problems(pack(winter, { 'other/a.png': 'x' }))).toMatch(/winter\/ has no files/)
    expect(describePackPermissions(winter).find((l) => l.kind === 'assets')).toMatchObject({ level: 'info', vars: { names: 'cafe' } })
    const self = manifest([], { id: 'cafe', contributes: { assets: [{ id: 'own', name: 'Own', for: { pack: 'cafe', app: 'main', slot: 'art' }, root: 'own' }] } })
    expect(problems(pack(self, { 'own/a.png': 'x' }))).toMatch(/for another pack's app/)
  })

  it('serves a slot’s files so they run nothing, and nothing for a slot without them', async () => {
    expect(parseAssetPath(packAssetPath('art', 'signs/a b.png'))).toEqual({ slot: 'art', path: 'signs/a b.png' })
    expect(parseAssetPath('app/x.png')).toBeNull()
    const src: PackFileSource = { file: () => null, appAt: () => null, asset: (_p, slot, path) => (slot === 'art' && path === 'a.svg' ? { data: Buffer.from('<svg/>'), disk: null } : null), toolHost: () => null }
    const res = await servePack(src, 'cafe', 'atelier-pack://cafe/__atelier/assets/art/a.svg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toMatch(/sandbox/)
    expect((await servePack(src, 'cafe', 'atelier-pack://cafe/__atelier/assets/art/missing.svg')).status).toBe(404)
  })
})

describe('the kit', () => {
  it('puts the import map first in a kit app’s head, where its hash is allowed', () => {
    const map = '{"imports":{"three":"/__atelier/kit/1/three/build/three.module.js"}}'
    const html = withImportMap('<!doctype html><html><head><title>x</title><script type="module" src="./m.js"></script></head></html>', map)
    expect(html).toMatch(/<head><script type="importmap">\{"imports"/)
    expect(html.indexOf('importmap')).toBeLessThan(html.indexOf('./m.js'))
    expect(withImportMap('<p>no head</p>', map)).toMatch(/^<script type="importmap">/)
    expect(withImportMap('<head></head>', null)).toBe('<head></head>')
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    expect(inlineScriptHashes(html)).toContain(createHash('sha256').update(map).digest('base64'))
  })

  it('takes only a kit this Atelier has', () => {
    expect(problems(pack(manifest([game({ build: 'kit', kit: 1 })]), { 'app/index.html': PAGE, 'app/main.js': 'export {}\n' }))).toBe('')
    expect(problems(pack(manifest([game({ build: 'kit', kit: 7 })]), { 'app/index.html': PAGE, 'app/main.js': 'export {}\n' }))).toMatch(/kit 7 isn't here/)
  })

  it('serves the kit inside the pack’s origin, and nothing outside it', async () => {
    const dir = tmp()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'three.js'), 'export const REVISION = "186"')
    const src: PackFileSource = { file: () => null, appAt: () => null, kit: (p) => (p === '1/three/build/three.module.js' ? join(dir, 'three.js') : null), toolHost: () => null }
    const res = await servePack(src, 'cafe', 'atelier-pack://cafe/__atelier/kit/1/three/build/three.module.js')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect((await servePack(src, 'cafe', 'atelier-pack://cafe/__atelier/kit/1/../../secret')).status).toBe(404)
  })
})

describe('starters for apps a companion builds', () => {
  it('each passes the pack rules as it is', () => {
    for (const starter of STARTERS) {
      const files = starterFiles(starter, { id: `starter-${starter}`, name: `Starter ${starter}`, description: 'A starter.' })
      const check = validatePack(files)
      expect(check.ok ? [] : check.problems, starter).toEqual([])
      const main = files.get('app/main.js')?.toString() ?? ''
      expect(main, starter).toContain('atelier.test?.ready(')
    }
  })
})
