/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import { WORKSPACE_TABS, breadcrumbs, fileRefFromViewerTarget, joinPath, parentPath, searchPageUrl, sortEntries, viewerTargetOf, workspaceTabOf, type FileRef } from '@shared/workspace'
import { rootRows } from '../src/renderer/src/chat/logic/addMenu'
import type { ClientToolContext, ToolSetup } from '../src/main/agent/tools/registry'
import { openDb } from '../src/main/db'
import { FolderStore, confine } from '../src/main/workspace/folders'
import { workspaceTools } from '../src/main/workspace/tools'
import { linkFile, linkFolder } from './helpers/links'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'apex-folders-')))
  dirs.push(base)
  const root = join(base, 'Projects')
  const outside = join(base, 'Secret')
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'docs', 'plan.md'), '# Plan\nShip it.')
  writeFileSync(join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))
  writeFileSync(join(root, '.hidden'), 'no')
  writeFileSync(join(outside, 'keys.txt'), 'secret')
  const snapshots: Array<{ ref: FileRef; text: string }> = []
  const store = new FolderStore({ db: openDb(':memory:'), blocked: [join(base, 'AppData')], snapshot: (ref, text) => void snapshots.push({ ref, text }) })
  return { base, root, outside, store, snapshots }
}

describe('confinement', () => {
  it('refuses .. and absolute paths', () => {
    const s = setup()
    expect(() => confine(s.root, '../Secret/keys.txt')).toThrow('outside')
    expect(() => confine(s.root, 'docs/../../Secret')).toThrow('outside')
    expect(() => confine(s.root, '/etc/passwd')).toThrow('outside')
    expect(() => confine(s.root, 'a\0b')).toThrow('outside')
    expect(confine(s.root, 'docs/plan.md')).toBe(join(s.root, 'docs', 'plan.md'))
    expect(confine(s.root, '')).toBe(s.root)
  })

  it('refuses symlinks that lead out, and allows ones that stay in', () => {
    const s = setup()
    linkFolder(s.outside, join(s.root, 'escape'))
    const linked = linkFile(join(s.outside, 'keys.txt'), join(s.root, 'keys-link.txt'))
    linkFolder(join(s.root, 'docs'), join(s.root, 'docs-link'))
    expect(() => confine(s.root, 'escape/keys.txt')).toThrow('outside')
    expect(() => confine(s.root, 'escape/new.txt')).toThrow('outside')
    if (linked) expect(() => confine(s.root, 'keys-link.txt')).toThrow('outside')
    expect(confine(s.root, 'docs-link/plan.md')).toBe(join(s.root, 'docs-link', 'plan.md'))
  })
})

describe('folder grants', () => {
  it('grants, lists, updates and revokes; the same folder and scope updates the mode', () => {
    const s = setup()
    const f = s.store.grant({ path: s.root, mode: 'read', scope: 'all-chats' })
    expect(f).toMatchObject({ name: 'Projects', mode: 'read', scope: 'all-chats', companionId: null })
    const again = s.store.grant({ path: s.root, mode: 'read-write', scope: 'all-chats' })
    expect(again.id).toBe(f.id)
    expect(s.store.list()).toHaveLength(1)
    s.store.grant({ path: s.root, mode: 'read', scope: { chatId: 'c1' } })
    expect(s.store.list()).toHaveLength(2)
    expect(s.store.update(f.id, { scope: { chatId: 'c2' } }).scope).toEqual({ chatId: 'c2' })
    s.store.revoke(f.id)
    expect(s.store.list()).toHaveLength(1)
    s.store.revokeChat('c1')
    expect(s.store.list()).toEqual([])
  })

  it('refuses files, missing paths, the disk root and Apex’s own data', () => {
    const s = setup()
    mkdirSync(join(s.base, 'AppData'))
    expect(() => s.store.grant({ path: join(s.root, 'docs', 'plan.md'), mode: 'read', scope: 'all-chats' })).toThrow('not a file')
    expect(() => s.store.grant({ path: join(s.base, 'nope'), mode: 'read', scope: 'all-chats' })).toThrow('can’t be found')
    expect(() => s.store.grant({ path: '/', mode: 'read', scope: 'all-chats' })).toThrow('whole disk')
    expect(() => s.store.grant({ path: join(s.base, 'AppData'), mode: 'read', scope: 'all-chats' })).toThrow('own data')
    expect(() => s.store.grant({ path: s.base, mode: 'read', scope: 'all-chats' })).toThrow('own data')
  })

  it('scopes access to all chats or one chat, and to a companion', () => {
    const s = setup()
    const all = s.store.grant({ path: s.root, mode: 'read', scope: 'all-chats' })
    const one = s.store.grant({ path: s.outside, mode: 'read', scope: { chatId: 'c1' } })
    const pip = s.store.grant({ path: join(s.root, 'docs'), mode: 'read', scope: 'all-chats', companionId: 'pip' })
    expect(s.store.accessible('c1', 'pip').map((f) => f.id).sort()).toEqual([all.id, one.id, pip.id].sort())
    expect(s.store.accessible('c2', 'max').map((f) => f.id)).toEqual([all.id])
    expect(s.store.folderFor(join(s.outside, 'keys.txt'))?.id).toBe(one.id)
    expect(s.store.folderFor(join(s.base, 'elsewhere'))).toBeNull()
  })

  it('lists entries folders first, without hidden files, and reads only text', () => {
    const s = setup()
    const f = s.store.grant({ path: s.root, mode: 'read', scope: 'all-chats' })
    expect(s.store.entries(f.id, '').map((e) => [e.name, e.kind, e.readable])).toEqual([['docs', 'folder', false], ['photo.png', 'file', true]])
    expect(s.store.readText(f.id, 'docs/plan.md')).toContain('Ship it.')
    expect(() => s.store.readText(f.id, 'photo.png')).toThrow('text files')
    expect(() => s.store.readText(f.id, '../Secret/keys.txt')).toThrow()
  })

  it('writes only with a read-and-edit grant, snapshots first, and refuses binaries', () => {
    const s = setup()
    const f = s.store.grant({ path: s.root, mode: 'read', scope: 'all-chats' })
    expect(() => s.store.writeText(f.id, 'docs/plan.md', 'x')).toThrow('only read')
    s.store.update(f.id, { mode: 'read-write' })
    expect(s.store.writeText(f.id, 'docs/plan.md', '# Plan v2')).toEqual({ created: false, path: 'docs/plan.md' })
    expect(readFileSync(join(s.root, 'docs', 'plan.md'), 'utf8')).toBe('# Plan v2')
    expect(s.snapshots).toEqual([{ ref: { kind: 'folder', folderId: f.id, path: 'docs/plan.md' }, text: '# Plan v2' }])
    expect(s.store.writeText(f.id, 'new/notes.txt', 'hi').created).toBe(true)
    writeFileSync(join(s.root, 'data.json'), Buffer.from([0x7b, 0, 0x7d]))
    expect(() => s.store.writeText(f.id, 'data.json', '{}')).toThrow('isn’t text')
    expect(() => s.store.writeText(f.id, 'tool.exe', 'MZ')).toThrow('text files')
    expect(() => s.store.writeText(f.id, 'big.md', 'x'.repeat(1024 * 1024 + 1))).toThrow('1 MB')
  })

  it('walks files for the index, skipping hidden ones, up to a cap', async () => {
    const s = setup()
    const f = s.store.grant({ path: s.root, mode: 'read', scope: 'all-chats' })
    expect((await s.store.files(f.id)).map((x) => x.path).sort()).toEqual(['docs/plan.md', 'photo.png'])
    expect(await s.store.files(f.id, 1)).toHaveLength(1)
    expect(await s.store.recount(f.id)).toBe(2)
    expect(s.store.get(f.id).fileCount).toBe(2)
  })
})

describe('folder tools', () => {
  const setupTools = () => {
    const s = setup()
    const companionDir = join(s.base, 'companion-files', 'pip')
    mkdirSync(companionDir, { recursive: true })
    writeFileSync(join(companionDir, 'trip.md'), 'Kyoto in spring')
    const tools = new Map(
      workspaceTools({
        folders: s.store,
        companionFiles: {
          files: (id) => (id === 'pip' ? [{ path: 'trip.md', size: 15, modifiedAt: 1 }] : []),
          entries: () => [{ path: 'trip.md', name: 'trip.md', kind: 'file', size: 15, modifiedAt: 1 }],
          resolve: (_id, p) => confine(companionDir, p),
          read: (_id, p) => readFileSync(confine(companionDir, p)),
        },
        companionName: () => 'Pip',
        search: () => ({ hits: [], total: 0 }),
      }).map((t) => [t.name, t]),
    )
    const events: AgentEvent[] = []
    const ctx = (chatId = 'c1', companionId = 'pip'): ClientToolContext => ({
      chatId,
      companionId,
      isPrivate: false,
      isRoutine: false,
      signal: new AbortController().signal,
      emit: (e) => void events.push(e),
      ask: () => Promise.reject(new Error('no')),
    })
    const run = async (name: string, input: unknown, c = ctx()) => {
      const tool = tools.get(name)!
      return tool.run(tool.parse.parse(input), c)
    }
    return { ...s, tools, run, events, ctx }
  }
  const setup0: ToolSetup = { companionId: 'max', browser: true, memory: true, routine: false, private: false, flags: {}, workspace: { folders: false, tables: false, apps: false, calendar: false, activity: false } }

  it('is offered only with a grant or companion files', () => {
    const t = setupTools()
    expect(t.tools.get('read_file')!.enabled(setup0)).toBe(false)
    expect(t.tools.get('read_file')!.enabled({ ...setup0, companionId: 'pip' })).toBe(true)
    expect(t.tools.get('read_file')!.enabled({ ...setup0, workspace: { ...setup0.workspace, folders: true } })).toBe(true)
    t.store.grant({ path: t.root, mode: 'read', scope: 'all-chats' })
    expect(t.tools.get('read_file')!.enabled(setup0)).toBe(true)
    expect(t.tools.get('search_everything')!.enabled(setup0)).toBe(true)
  })

  it('lists folders, reads files, and reads the companion’s own files (CO-08)', async () => {
    const t = setupTools()
    const f = t.store.grant({ path: t.root, mode: 'read', scope: 'all-chats' })
    const roots = JSON.parse((await t.run('list_folder', {})).content) as { folders: Array<{ id: string; name: string; access: string }> }
    expect(roots.folders).toEqual([{ id: f.id, name: 'Projects', access: 'read only' }, { id: 'companion', name: 'Pip’s files', access: 'read only' }])
    expect((await t.run('read_file', { folder: 'Projects', path: 'docs/plan.md' })).content).toContain('Ship it.')
    expect((await t.run('read_file', { folder: 'companion', path: 'trip.md' })).content).toBe('Kyoto in spring')
    const escape = await t.run('read_file', { folder: f.id, path: 'docs/../../Secret/keys.txt' }).catch((e: Error) => ({ content: e.message, isError: true }))
    expect(escape.isError).toBe(true)
  })

  it('writes with read-and-edit grants only, and logs file-written', async () => {
    const t = setupTools()
    const f = t.store.grant({ path: t.root, mode: 'read', scope: { chatId: 'c1' } })
    const refused = await t.run('write_file', { folder: f.id, path: 'docs/plan.md', content: 'x' })
    expect(refused.isError).toBe(true)
    expect((await t.run('write_file', { folder: 'companion', path: 'trip.md', content: 'x' })).isError).toBe(true)
    t.store.update(f.id, { mode: 'read-write' })
    const ok = await t.run('write_file', { folder: f.id, path: 'docs/plan.md', content: 'v2' })
    expect(ok.content).toContain('Saved docs/plan.md')
    expect(t.events).toEqual([{ type: 'file-written', turnId: '', ref: { kind: 'folder', folderId: f.id, path: 'docs/plan.md' }, name: 'plan.md' }])
    // Another chat can't see a grant made for c1.
    const other = await t.run('read_file', { folder: f.id, path: 'docs/plan.md' }, t.ctx('c2', 'max'))
    expect(other.isError).toBe(true)
  })
})

describe('the Files section and the + menu', () => {
  const entry = (name: string, kind: 'file' | 'folder', modifiedAt = 0, size = 0) => ({ path: name, name, kind, size, modifiedAt, readable: kind === 'file' })
  const folder = { id: 'f1', path: '/Users/me/Kitchen', name: 'Kitchen', mode: 'read' as const, scope: 'all-chats' as const, companionId: null, addedAt: 1, fileCount: 2 }

  it('builds breadcrumbs and parents', () => {
    expect(breadcrumbs('quotes/2026')).toEqual([{ name: '', path: '' }, { name: 'quotes', path: 'quotes' }, { name: '2026', path: 'quotes/2026' }])
    expect(parentPath('quotes/2026')).toBe('quotes')
    expect(parentPath('quotes')).toBe('')
  })

  it('sorts folders first, names naturally, and filters by name', () => {
    const list = [entry('file 10.md', 'file', 5, 10), entry('file 2.md', 'file', 9, 300), entry('zeta', 'folder', 1)]
    expect(sortEntries(list, 'name').map((e) => e.name)).toEqual(['zeta', 'file 2.md', 'file 10.md'])
    expect(sortEntries(list, 'modified').map((e) => e.name)).toEqual(['zeta', 'file 2.md', 'file 10.md'])
    expect(sortEntries(list, 'size').map((e) => e.name)).toEqual(['zeta', 'file 2.md', 'file 10.md'])
    expect(sortEntries(list, 'name', '10').map((e) => e.name)).toEqual(['file 10.md'])
  })

  it('maps file refs onto the file viewer’s targets, folder files through their grant', () => {
    const ref: FileRef = { kind: 'folder', folderId: 'f1', path: 'quotes/tiles.txt' }
    expect(viewerTargetOf(ref, [folder])).toEqual({ kind: 'local', path: '/Users/me/Kitchen/quotes/tiles.txt' })
    expect(viewerTargetOf(ref, [])).toBeNull()
    expect(viewerTargetOf({ kind: 'companion', companionId: 'c1', path: 'a.md' }, [])).toEqual({ kind: 'companion-file', companionId: 'c1', path: 'a.md' })
    expect(viewerTargetOf({ kind: 'skill', skillId: 's1', path: 'SKILL.md' }, [])).toEqual({ kind: 'skill', skillId: 's1' })
    expect(viewerTargetOf({ kind: 'app', appId: 'a1' }, [])).toBeNull()
    expect(joinPath('/Users/me/Kitchen/', './a//b')).toBe('/Users/me/Kitchen/a/b')
    expect(fileRefFromViewerTarget({ kind: 'local', path: '/x' })).toBeNull()
  })

  it('adds the local folder row to the + menu only when given (CH-21)', () => {
    const labels = { files: 'Files…', skills: 'Skills', meetings: 'Meetings', connectors: 'Connectors', tabs: 'Tabs', recent: 'Recent tabs' }
    expect(rootRows(labels, []).some((r) => r.id === 'folder')).toBe(false)
    const rows = rootRows(labels, [], { label: 'Folder…', detail: 'Let this chat read a folder' })
    expect(rows.map((r) => r.id).slice(0, 3)).toEqual(['files', 'folder', 'sep-attach'])
    expect(rows[1]).toMatchObject({ kind: 'item', label: 'Folder…', detail: 'Let this chat read a folder' })
    expect(searchPageUrl(' oak worktop ')).toBe('apex://workspace/search?q=oak%20worktop')
    expect(searchPageUrl('')).toBe('apex://workspace/search')
  })

  it('the hub has four tabs: Tables shows under Files, Search, Recently deleted and the old Timeline under none', () => {
    expect(WORKSPACE_TABS).toEqual(['home', 'projects', 'files', 'apps'])
    expect(workspaceTabOf('home')).toBe('home')
    expect(workspaceTabOf('apps')).toBe('apps')
    expect(workspaceTabOf('tables')).toBe('files')
    expect(workspaceTabOf('search')).toBeNull()
    expect(workspaceTabOf('trash')).toBeNull()
    expect(workspaceTabOf('timeline')).toBeNull()
  })
})
