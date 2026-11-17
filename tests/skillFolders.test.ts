/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SHARED_OWNER } from '@shared/chats'
import { SKILL_FILES_MAX, SKILL_FILE_MAX_BYTES, isTextSkillFile } from '@shared/skills'
import { BUILTIN_SOURCES } from '../src/main/skills/builtin'
import { parseSkillDocument, serializeSkillDocument, skillBlock } from '../src/main/skills/format'
import { SkillStore, expandSkill } from '../src/main/skills/store'

const FIXTURE = join(__dirname, 'fixtures', 'skills', 'legacy-skills.json')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-skills-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('SKILL.md front matter', () => {
  const doc = (head: string, body = 'Do the work.'): string => `---\n${head}\n---\n\n${body}\n`

  it('reads name, description and the body', () => {
    expect(parseSkillDocument(doc('name: trip-plan\ndescription: Plans a trip'))).toMatchObject({ name: 'trip-plan', description: 'Plans a trip', instructions: 'Do the work.', steps: [] })
  })

  it('validates the name and the description with a reason', () => {
    expect(() => parseSkillDocument(doc('name: Trip Plan\ndescription: x'))).toThrow(/lowercase letters/)
    expect(() => parseSkillDocument(doc(`name: ${'a'.repeat(41)}\ndescription: x`))).toThrow(/lowercase letters/)
    expect(() => parseSkillDocument(doc('name: trip-plan'))).toThrow(/description/)
    expect(() => parseSkillDocument(doc(`name: trip-plan\ndescription: ${'x'.repeat(501)}`))).toThrow(/500/)
    expect(() => parseSkillDocument('')).toThrow(/empty/)
    expect(() => parseSkillDocument(doc('name: trip-plan\ndescription: x', ''))).toThrow(/no instructions/)
    expect(() => parseSkillDocument('---\nname: a\n\nbody')).toThrow(/isn’t closed/)
  })

  it('keeps unknown keys through a round trip', () => {
    const parsed = parseSkillDocument(doc('name: trip-plan\ndescription: Plans a trip\nlicense: MIT\ntags: [travel]'))
    expect(parsed.extra).toEqual(['license: MIT', 'tags: [travel]'])
    const again = parseSkillDocument(serializeSkillDocument(parsed))
    expect(again).toEqual(parsed)
  })

  it('keeps ordered steps and numbers them when a chat expands the skill', () => {
    const steps = [
      { id: 's1', title: 'Gather', instructions: 'Collect the pages.' },
      { id: 's2', title: 'Write', instructions: 'Write the brief.' },
    ]
    const text = serializeSkillDocument({ name: 'research-brief', description: 'Brief', instructions: 'Research a topic.', steps })
    expect(parseSkillDocument(text).steps).toEqual(steps)
    const block = skillBlock({ name: 'research-brief', instructions: 'Research a topic.', steps })
    expect(block).toMatch(/1\.[^\n]*Gather/)
    expect(block).toMatch(/2\.[^\n]*Write/)
    expect(block.indexOf('Gather')).toBeLessThan(block.indexOf('Write'))
    const expanded = expandSkill('/research-brief solar panels', (n) => (n === 'research-brief' ? { name: n, instructions: 'Research a topic.', steps } : undefined))
    expect(expanded.text).toContain('solar panels')
    expect(expanded.text).toContain('Gather')
  })

  it('derives a name and description for imports', () => {
    expect(parseSkillDocument('# Weekly digest\nSum up the week.', { fileName: 'Weekly Digest.md', deriveDescription: true })).toMatchObject({ name: 'weekly-digest', description: 'Weekly digest' })
  })
})

describe('the legacy migration', () => {
  it('moves skills.json rows into folders, keeping ids, owners and dates', () => {
    copyFileSync(FIXTURE, join(dir, 'skills.json'))
    const store = new SkillStore(dir, { builtins: [] })
    expect(existsSync(join(dir, 'skills.json'))).toBe(false)
    expect(existsSync(join(dir, 'skills.json.bak'))).toBe(true)
    const report = store.get('a0-skill-1')!
    expect(report).toMatchObject({ name: 'weekly-report', owner: SHARED_OWNER, updatedAt: 1700000000000, lastUsedAt: 1700000500000, source: 'user' })
    expect(readFileSync(join(dir, 'skills', SHARED_OWNER, 'weekly-report', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: weekly-report\ndescription: Turns my notes/)
    // A missing description comes from the first line; an unusable name gets a usable one.
    expect(store.get('a0-skill-2')).toMatchObject({ owner: 'companion-ava', description: 'Check the tone of the draft.' })
    expect(store.get('a0-skill-3')!.name).toMatch(/^skill/)
    expect(store.list()).toHaveLength(3)
  })

  it('is idempotent: a second run, or the same file again, adds nothing', () => {
    copyFileSync(FIXTURE, join(dir, 'skills.json'))
    const first = new SkillStore(dir, { builtins: [] })
    const ids = first.list().map((s) => s.id).sort()
    copyFileSync(FIXTURE, join(dir, 'skills.json'))
    const second = new SkillStore(dir, { builtins: [] })
    expect(second.migrateLegacy()).toBe(0)
    expect(second.list().map((s) => s.id).sort()).toEqual(ids)
    expect(second.list()).toHaveLength(3)
  })

  it('picks up a folder dropped in by hand', () => {
    const store = new SkillStore(dir, { builtins: [] })
    const folder = join(dir, 'skills', SHARED_OWNER, 'by-hand')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), '---\nname: by-hand\ndescription: Made in Finder\n---\n\nHello.\n')
    expect(store.rescan().map((s) => s.name)).toContain('by-hand')
  })
})

describe('built-in skills', () => {
  it('ships 8 to 12 built-ins, each readable', () => {
    const store = new SkillStore(dir)
    const builtins = store.all().filter((s) => s.source === 'builtin')
    expect(builtins.length).toBe(BUILTIN_SOURCES.length)
    expect(builtins.length).toBeGreaterThanOrEqual(8)
    expect(builtins.length).toBeLessThanOrEqual(12)
    for (const b of builtins) {
      expect(b.description.length).toBeGreaterThan(0)
      expect(b.builtinVersion).toBeTruthy()
      expect(b.files).toEqual([])
    }
  })

  it('refuses edits, files and deletes, and duplicates into an editable copy', () => {
    const store = new SkillStore(dir)
    const builtin = store.all().find((s) => s.source === 'builtin' && s.name === 'trip-plan')!
    expect(() => store.save({ id: builtin.id, name: 'trip-plan', description: 'x', instructions: 'y' })).toThrow(/read-only/)
    expect(() => store.remove(builtin.id)).toThrow(/can’t be deleted/)
    expect(() => store.writeFile(builtin.id, 'notes.md', 'x')).toThrow(/read-only/)
    expect(() => store.addFile(builtin.id, 'a.txt', 'eA==')).toThrow(/read-only/)
    const copy = store.duplicate(builtin.id)
    expect(copy).toMatchObject({ source: 'user', name: 'trip-plan', instructions: builtin.instructions })
    expect(store.folderOf(copy.id)).toBeTruthy()
  })
})

describe('supporting files', () => {
  const make = (store: SkillStore): string => store.save({ name: 'notes', description: 'Notes', instructions: 'Use the files.' }).id

  it('adds, edits, lists and removes files; text types are editable, the rest view-only', () => {
    const store = new SkillStore(dir, { builtins: [] })
    const id = make(store)
    store.addFile(id, 'guide.md', Buffer.from('# Guide').toString('base64'))
    store.addFile(id, 'logo.png', Buffer.from([1, 2, 3]).toString('base64'))
    const again = store.addFile(id, 'guide.md', Buffer.from('two').toString('base64'))
    expect(again.path).toBe('guide 2.md')
    expect(store.files(id).map((f) => [f.path, f.editable])).toEqual([
      ['guide 2.md', true],
      ['guide.md', true],
      ['logo.png', false],
    ])
    store.writeFile(id, 'guide.md', '# Better guide')
    expect(store.readFile(id, 'guide.md')).toBe('# Better guide')
    expect(() => store.readFile(id, 'logo.png')).toThrow(/can’t be shown/)
    expect(() => store.writeFile(id, 'logo.png', 'x')).toThrow(/Only text files/)
    store.removeFile(id, 'guide 2.md')
    expect(store.files(id)).toHaveLength(2)
    expect(() => store.removeFile(id, 'SKILL.md')).toThrow(/delete the skill/)
  })

  it('keeps files inside the folder', () => {
    const store = new SkillStore(dir, { builtins: [] })
    const id = make(store)
    expect(() => store.readFile(id, '../../skills.json')).toThrow(/isn’t in this skill/)
    expect(() => store.writeFile(id, '.hidden.md', 'x')).toThrow(/isn’t in this skill/)
  })

  it(`allows up to ${SKILL_FILES_MAX} files of at most 5 MB`, () => {
    const store = new SkillStore(dir, { builtins: [] })
    const id = make(store)
    const big = Buffer.alloc(SKILL_FILE_MAX_BYTES + 1).toString('base64')
    expect(() => store.addFile(id, 'big.txt', big)).toThrow(/5 MB/)
    const folder = store.folderOf(id)!
    for (let i = 0; i < SKILL_FILES_MAX; i++) writeFileSync(join(folder, `f${i}.txt`), 'x')
    expect(() => store.addFile(id, 'one-more.txt', 'eA==')).toThrow(new RegExp(`${SKILL_FILES_MAX} files`))
    expect(() => store.writeFile(id, 'new.md', 'x')).toThrow(new RegExp(`${SKILL_FILES_MAX} files`))
    // Editing an existing file is still fine.
    expect(store.writeFile(id, 'f0.txt', 'y').size).toBe(1)
  })

  it('snapshots a file before it is overwritten or removed', () => {
    const store = new SkillStore(dir, { builtins: [] })
    const snaps: Array<{ path: string; label: string }> = []
    store.bind({ snapshot: (ref, _text, label) => void snaps.push({ path: 'path' in ref ? String(ref.path) : '', label }) })
    const id = make(store)
    store.writeFile(id, 'a.md', 'one')
    store.writeFile(id, 'a.md', 'two')
    store.removeFile(id, 'a.md')
    store.save({ id, name: 'notes', description: 'Notes', instructions: 'Changed.' })
    expect(snaps).toEqual([
      { path: 'a.md', label: 'saved' },
      { path: 'a.md', label: 'deleted' },
      { path: 'SKILL.md', label: 'saved' },
    ])
  })

  it('knows which types are text', () => {
    expect(isTextSkillFile('a.md')).toBe(true)
    expect(isTextSkillFile('a.JSON')).toBe(true)
    expect(isTextSkillFile('a.pdf')).toBe(false)
    expect(isTextSkillFile('Makefile')).toBe(false)
  })

  it('moves the folder on a rename, keeping the id and the files', () => {
    const store = new SkillStore(dir, { builtins: [] })
    const id = make(store)
    store.writeFile(id, 'a.md', 'one')
    const renamed = store.save({ id, name: 'notes-two', description: 'Notes', instructions: 'Use the files.' })
    expect(renamed.id).toBe(id)
    expect(store.folderOf(id)).toMatch(/notes-two$/)
    expect(store.readFile(id, 'a.md')).toBe('one')
    expect(() => store.save({ name: 'notes-two', description: 'x', instructions: 'y' })).toThrow(/already exists/)
  })
})
