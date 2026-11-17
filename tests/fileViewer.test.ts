/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileViewerUrl } from '@shared/files'
import { codeLanguageOf, isTextPreviewable, mediaTypeOf, parseFrontmatter, previewableOf } from '@shared/fileKinds'
import { highlight } from '@shared/codeHighlight'
import { fileViewerName, internalTitle } from '@shared/url'
import { PathRefused, confine } from '../src/main/files/confine'
import { fileTokenOf, parseRange, serveFile } from '../src/main/files/fileProtocol'
import { LibraryStore } from '../src/main/files/library'
import { TokenRegistry } from '../src/main/files/tokens'
import { Viewer } from '../src/main/files/viewer'
import { linkFile, linkFolder } from './helpers/links'

// The file viewer (OV-32): confinement to Atelier's folders (symlinks included),
// tokens that expire with their tab, kind detection, front matter, and the
// open, save, rename and delete round trip.

let dir: string
let outside: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-viewer-'))
  outside = mkdtempSync(join(tmpdir(), 'atelier-outside-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function viewer(extra: Partial<ConstructorParameters<typeof Viewer>[0]> = {}): Viewer {
  return new Viewer({ dataDir: dir, library: new LibraryStore(join(dir, 'library')), ...extra })
}

describe('confinement', () => {
  it('keeps paths inside the root and refuses .. and absolute escapes', () => {
    mkdirSync(join(dir, 'root', 'sub'), { recursive: true })
    expect(confine(join(dir, 'root'), 'sub/a.md')).toBe(join(dir, 'root', 'sub', 'a.md'))
    expect(() => confine(join(dir, 'root'), '../x.md')).toThrow(PathRefused)
    expect(() => confine(join(dir, 'root'), 'sub/../../x.md')).toThrow(PathRefused)
    expect(() => confine(join(dir, 'root'), '')).toThrow(PathRefused)
    expect(() => confine(join(dir, 'root'), 'a\0b')).toThrow(PathRefused)
  })

  it('refuses a symlinked file or folder that leaves the root', () => {
    mkdirSync(join(dir, 'root'), { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    const linked = linkFile(join(outside, 'secret.txt'), join(dir, 'root', 'link.txt'))
    linkFolder(outside, join(dir, 'root', 'away'))
    if (linked) expect(() => confine(join(dir, 'root'), 'link.txt')).toThrow(PathRefused)
    expect(() => confine(join(dir, 'root'), 'away/secret.txt')).toThrow(PathRefused)
    expect(() => confine(join(dir, 'root'), 'away/new.txt')).toThrow(PathRefused)
  })

  it('opens a companion file but refuses a symlink escape through the viewer', async () => {
    const root = join(dir, 'companion-files', 'pip')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'notes.md'), '# Notes')
    writeFileSync(join(outside, 'secret.md'), 'secret')
    const linked = linkFile(join(outside, 'secret.md'), join(root, 'sneaky.md'))
    const v = viewer()
    expect((await v.open({ kind: 'companion-file', companionId: 'pip', path: 'notes.md' })).text).toBe('# Notes')
    if (linked) await expect(v.open({ kind: 'companion-file', companionId: 'pip', path: 'sneaky.md' })).rejects.toThrow(PathRefused)
    await expect(v.open({ kind: 'companion-file', companionId: '../x', path: 'notes.md' })).rejects.toThrow(PathRefused)
  })

  it('opens a local file only after it was granted this session', async () => {
    const file = join(outside, 'mine.txt')
    writeFileSync(file, 'hello')
    const v = viewer()
    await expect(v.open({ kind: 'local', path: file })).rejects.toThrow(PathRefused)
    const target = v.grantLocal(file)
    expect(target?.kind).toBe('local')
    const doc = await v.open(target!)
    expect(doc).toMatchObject({ text: 'hello', editable: true, renamable: false, deletable: false, revealable: true })
    expect(v.grantLocal(join(outside, 'nothing-here.txt'))).toBeNull()
  })
})

describe('tokens', () => {
  it('expire with their tab, on release, and after idling without a tab', () => {
    let now = 0
    const tokens = new TokenRegistry<string>({ now: () => now, idleMs: 1000, limit: 3 })
    const a = tokens.issue('a', 't1')
    const b = tokens.issue('b', 't1')
    const c = tokens.issue('c', null)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(tokens.get(a)).toBe('a')
    expect(tokens.releaseOwner('t1')).toBe(2)
    expect(tokens.get(b)).toBeNull()
    now = 2000
    expect(tokens.get(c)).toBeNull()
    const d = tokens.issue('d', null)
    tokens.release(d)
    expect(tokens.get(d)).toBeNull()
  })

  it('caps how many stay alive, dropping the least recently used', () => {
    let now = 0
    const tokens = new TokenRegistry<number>({ now: () => now++, limit: 2 })
    const first = tokens.issue(1, 't')
    const second = tokens.issue(2, 't')
    tokens.get(first)
    tokens.issue(3, 't')
    expect(tokens.get(second)).toBeNull()
    expect(tokens.get(first)).toBe(1)
  })

  it('a released token no longer serves atelier-file requests', async () => {
    const lib = new LibraryStore(join(dir, 'library'))
    const v = new Viewer({ dataDir: dir, library: lib })
    const file = lib.addGenerated({ chatId: '11111111-2222-4333-8444-555555555555', companionId: 'c', name: 'a.png', mediaType: 'image/png', bytes: Buffer.from([1, 2, 3, 4]) })
    const doc = await v.open({ kind: 'library', id: file.id }, 't9')
    expect(doc.url).toMatch(/^atelier-file:\/\/[0-9a-f]{32}\/a\.png$/)
    const token = fileTokenOf(doc.url!)!
    expect(v.served(token)?.path).toBe(lib.pathOf(file.id))
    v.releaseOwner('t9')
    expect(v.served(token)).toBeNull()
  })
})

describe('kinds and front matter', () => {
  it('detects previews from names and media types', () => {
    expect(previewableOf('a.md', '', 3)).toBe('markdown')
    expect(previewableOf('a.ts', mediaTypeOf('a.ts'), 3)).toBe('code')
    expect(previewableOf('data.xlsx', mediaTypeOf('data.xlsx'), 3)).toBe('sheet')
    expect(previewableOf('a.csv', 'text/csv', 3)).toBe('sheet')
    expect(previewableOf('pic.svg', 'image/svg+xml', 3)).toBe('svg')
    expect(previewableOf('pic.webp', mediaTypeOf('pic.webp'), 3)).toBe('image')
    expect(previewableOf('doc.pdf', mediaTypeOf('doc.pdf'), 3)).toBe('pdf')
    expect(previewableOf('talk.m4a', mediaTypeOf('talk.m4a'), 3)).toBe('audio')
    expect(previewableOf('clip.mov', mediaTypeOf('clip.mov'), 3)).toBe('video')
    expect(previewableOf('page.html', mediaTypeOf('page.html'), 3)).toBe('html')
    expect(previewableOf('report.docx', mediaTypeOf('report.docx'), 3)).toBe('binary')
    expect(previewableOf('noext', mediaTypeOf('noext'), 3)).toBe('unknown')
    expect(previewableOf('a.md', 'text/markdown', 0)).toBe('empty')
    expect(previewableOf('Transcript', 'text/plain', 10)).toBe('text')
    expect(isTextPreviewable('sheet', 'a.csv')).toBe(true)
    expect(isTextPreviewable('sheet', 'a.xlsx')).toBe(false)
    expect(codeLanguageOf('x.py')).toBe('py')
    expect(codeLanguageOf('x.unknown')).toBe('plain')
  })

  it('parses front matter, keeping the body and quoted values', () => {
    const { data, body } = parseFrontmatter('---\nname: weekly-report\ndescription: "Sums up: the week"\ntags:\n  - a\n  - b\n---\n# Body\n')
    expect(data).toEqual({ name: 'weekly-report', description: 'Sums up: the week', tags: '- a - b' })
    expect(body).toBe('# Body\n')
    expect(parseFrontmatter('# No front matter').data).toEqual({})
    expect(parseFrontmatter('---\nunclosed: yes\n').body).toBe('---\nunclosed: yes\n')
  })

  it('highlights code without losing a character', () => {
    const code = 'const x = "a\\"b" // note\nreturn 42 /* c */'
    const tokens = highlight(code, 'js')
    expect(tokens.map((t) => t.text).join('')).toBe(code)
    expect(tokens.find((t) => t.kind === 'keyword')?.text).toBe('const')
    expect(tokens.some((t) => t.kind === 'comment' && t.text === '// note')).toBe(true)
    expect(tokens.some((t) => t.kind === 'number' && t.text === '42')).toBe(true)
    const json = highlight('{"a": [1, true, "b"]}', 'json')
    expect(json.find((t) => t.kind === 'key')?.text).toBe('"a"')
    expect(json.find((t) => t.kind === 'string')?.text).toBe('"b"')
    const xml = highlight('<a href="x">t</a>', 'xml')
    expect(xml.map((t) => t.text).join('')).toBe('<a href="x">t</a>')
    expect(xml.find((t) => t.kind === 'attr')?.text).toBe('href')
  })

  it('titles viewer tabs by the file name', () => {
    const url = fileViewerUrl({ kind: 'memory', owner: 'shared', path: '/memories/people/ana.md' })
    expect(fileViewerName(url)).toBe('ana.md')
    expect(internalTitle(url).crumbs).toEqual(['File', 'ana.md'])
    const lib = fileViewerUrl({ kind: 'library', id: '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e' }, { name: 'Plan.md' })
    expect(internalTitle(lib).title).toBe('Plan.md')
    expect(internalTitle('atelier://library/files').crumbs).toEqual(['Library', 'Files'])
  })
})

describe('Viewer', () => {
  it('edits, renames and deletes a memory file, telling the delete hook', async () => {
    const root = join(dir, 'memory', 'memories')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'ana.md'), '---\nabout: Ana\n---\nLikes tea.')
    const trashed: string[] = []
    const v = viewer({ trash: async (p) => void trashed.push(p) })
    const deleted: string[] = []
    v.onDelete((d) => deleted.push(d.name))
    const doc = await v.open({ kind: 'memory', owner: 'shared', path: '/memories/ana.md' }, 't1')
    expect(doc).toMatchObject({ previewable: 'markdown', editable: true, frontmatter: { about: 'Ana' }, source: 'memory', artifactable: true })
    const saved = v.save(doc.token, 'Likes coffee.')
    expect(saved.text).toBe('Likes coffee.')
    expect(readFileSync(join(root, 'ana.md'), 'utf8')).toBe('Likes coffee.')
    const renamed = v.rename(doc.token, 'ana-notes.md')
    expect(renamed.name).toBe('ana-notes.md')
    expect(existsSync(join(root, 'ana-notes.md'))).toBe(true)
    await v.remove(doc.token)
    expect(trashed).toEqual([join(root, 'ana-notes.md')])
    expect(deleted).toEqual(['ana-notes.md'])
    expect(() => v.save(doc.token, 'x')).toThrow()
  })

  it('shows a missing file as missing, and refuses to save over it', async () => {
    const v = viewer()
    mkdirSync(join(dir, 'memory', 'memories'), { recursive: true })
    const doc = await v.open({ kind: 'memory', owner: 'shared', path: '/memories/gone.md' })
    expect(doc.state).toBe('missing')
    expect(doc.editable).toBe(false)
    expect(() => v.save(doc.token, 'x')).toThrow(/no longer there/)
    expect((await v.open({ kind: 'library', id: '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e' })).state).toBe('missing')
  })

  it('follows a report from writing to ready, and shows a failed one as an error', async () => {
    const lib = new LibraryStore(join(dir, 'library'))
    const v = new Viewer({ dataDir: dir, library: lib })
    const report = lib.beginReport({ chatId: '11111111-2222-4333-8444-555555555555', companionId: 'c', name: 'R.md', mediaType: 'text/markdown' })
    lib.updateReport(report.id, '# Half')
    const doc = await v.open({ kind: 'library', id: report.id })
    expect(doc).toMatchObject({ state: 'writing', text: '# Half', editable: false, deletable: false })
    lib.finishReport(report.id, '# Whole')
    expect(await v.reload(doc.token)).toMatchObject({ state: 'ready', text: '# Whole', editable: true })
    const failed = lib.beginReport({ chatId: '11111111-2222-4333-8444-555555555555', companionId: 'c', name: 'F.md', mediaType: 'text/markdown' })
    lib.fail(failed.id, 'Stopped.')
    expect(await v.open({ kind: 'library', id: failed.id })).toMatchObject({ state: 'error', error: 'Stopped.' })
  })

  it('reads sheets capped, and serves skills read-only with their front matter', async () => {
    const lib = new LibraryStore(join(dir, 'library'))
    const v = new Viewer({ dataDir: dir, library: lib })
    const rows = Array.from({ length: 250 }, (_, i) => `${i},b`).join('\n')
    const f = lib.addGenerated({ chatId: '11111111-2222-4333-8444-555555555555', companionId: 'c', name: 'big.csv', mediaType: 'text/csv', bytes: Buffer.from(rows) })
    const sheet = (await v.open({ kind: 'library', id: f.id })).sheet
    expect(sheet).toMatchObject({ totalRows: 250, truncated: true })
    expect(sheet?.rows).toHaveLength(200)
    writeFileSync(join(dir, 'skills.json'), JSON.stringify([{ id: 'sk1', name: 'weekly', description: 'Sums up the week', instructions: 'Do it.' }]))
    const skill = await v.open({ kind: 'skill', skillId: 'sk1' })
    expect(skill).toMatchObject({ name: 'weekly.md', editable: false, frontmatter: { name: 'weekly', description: 'Sums up the week' }, revealable: false })
    expect((await v.open({ kind: 'skill', skillId: 'nope' })).state).toBe('missing')
  })

  it('copies a file from elsewhere into the Library to open it as an artifact', async () => {
    const root = join(dir, 'companion-files', 'pip')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'page.html'), '<p>hi</p>')
    const lib = new LibraryStore(join(dir, 'library'))
    const v = new Viewer({ dataDir: dir, library: lib })
    const doc = await v.open({ kind: 'companion-file', companionId: 'pip', path: 'page.html' })
    const id = v.artifactIdFor(doc.token)
    expect(lib.get(id)).toMatchObject({ kind: 'artifact', artifact: true, name: 'page.html' })
    writeFileSync(join(root, 'a.txt'), 'x')
    const txt = await v.open({ kind: 'companion-file', companionId: 'pip', path: 'a.txt' })
    expect(() => v.artifactIdFor(txt.token)).toThrow()
  })
})

describe('atelier-file responses', () => {
  it('parses single byte ranges', () => {
    expect(parseRange(null, 100)).toBeNull()
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 })
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 })
    expect(parseRange('bytes=100-', 100)).toBe('invalid')
    expect(parseRange('bytes=5-1', 100)).toBe('invalid')
    expect(parseRange('items=0-1', 100)).toBe('invalid')
  })

  it('streams a range with 206, and refuses unknown tokens', async () => {
    const file = join(dir, 'clip.bin')
    writeFileSync(file, Buffer.from('0123456789'))
    const ranged = serveFile(new Request('atelier-file://x/clip', { headers: { range: 'bytes=2-4' } }), { path: file, text: null, mediaType: 'video/mp4' })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(Buffer.from(await ranged.arrayBuffer()).toString()).toBe('234')
    expect(serveFile(new Request('atelier-file://x/clip'), null).status).toBe(404)
    expect(serveFile(new Request('atelier-file://x/clip', { headers: { range: 'bytes=20-' } }), { path: file, text: null, mediaType: 'video/mp4' }).status).toBe(416)
    expect(fileTokenOf('atelier-file://0123456789abcdef0123456789abcdef/a.png')).toBe('0123456789abcdef0123456789abcdef')
    expect(fileTokenOf('atelier-file://../etc/passwd')).toBeNull()
  })
})
