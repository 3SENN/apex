/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryFileRef } from '@shared/files'
import { LIBRARY_VIEW_DEFAULT, chatsWithFiles, filterLibrary, groupLibrary, matchesName } from '@shared/filesLogic'
import { LibraryStore, readEntry } from '../src/main/files/library'
import { artifactFileName, setupFiles } from '../src/main/files/service'

// Library › Files: the store under userData/library, its
// index fallback, reports, artifacts and the ON-13 signal.

const CHAT = '11111111-2222-4333-8444-555555555555'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apex-library-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('LibraryStore', () => {
  it('stores generated files under <id>/<name> and lists them newest first', () => {
    let now = 1000
    const store = new LibraryStore(dir, { now: () => now++ })
    const a = store.addGenerated({ chatId: CHAT, companionId: 'c1', name: 'chart.png', mediaType: 'image/png', bytes: Buffer.from([1, 2, 3]) })
    const b = store.addGenerated({ chatId: CHAT, companionId: 'c1', name: '../escape/notes.md', mediaType: '', bytes: Buffer.from('# hi') })
    expect(readFileSync(join(dir, a.id, 'chart.png'))).toEqual(Buffer.from([1, 2, 3]))
    // Path parts never survive into the stored name.
    expect(b.name).toBe('escape notes.md')
    expect(b.mediaType).toBe('text/markdown')
    expect(store.list().map((f) => f.id)).toEqual([b.id, a.id])
    expect(store.listByChat(CHAT)).toHaveLength(2)
    expect(store.sizes().libraryFiles).toBe(3 + 4)
  })

  it('streams a report: writing, updated, then ready; or failed with a reason', () => {
    const store = new LibraryStore(dir)
    const report = store.beginReport({ chatId: CHAT, companionId: 'c1', name: 'Report.md', mediaType: 'text/markdown' })
    expect(report.state).toBe('writing')
    expect(report.kind).toBe('report')
    store.updateReport(report.id, '# Draft')
    expect(readFileSync(store.pathOf(report.id), 'utf8')).toBe('# Draft')
    const done = store.finishReport(report.id, '# Final')
    expect(done.file.state).toBe('ready')
    expect(done.file.size).toBe(7)
    expect(() => store.updateReport(report.id, 'late')).toThrow()

    const other = store.beginReport({ chatId: CHAT, companionId: 'c1', name: 'Other.md', mediaType: 'text/markdown' })
    store.fail(other.id, 'The run stopped.')
    expect(store.get(other.id)?.state).toBe('failed')
    expect(store.errorOf(other.id)).toBe('The run stopped.')
  })

  it('marks only the first artifact ever as the first (ON-13), across restarts', () => {
    const store = new LibraryStore(dir)
    const first = store.saveArtifact({ chatId: CHAT, companionId: 'c1', name: 'Page.html', content: '<p>hi</p>' })
    expect(first.first).toBe(true)
    expect(first.file).toMatchObject({ kind: 'artifact', artifact: true, mediaType: 'text/html' })
    expect(store.saveArtifact({ chatId: CHAT, companionId: 'c1', name: 'Notes.md', content: '# x' }).first).toBe(false)
    const reopened = new LibraryStore(dir)
    expect(reopened.saveArtifact({ chatId: null, companionId: '', name: 'More.svg', content: '<svg/>' })).toMatchObject({ first: false, file: { artifact: true } })
    expect(reopened.list({ kind: 'artifact' })).toHaveLength(3)
  })

  it('renames on disk and keeps a known media type', () => {
    const store = new LibraryStore(dir)
    const f = store.addGenerated({ chatId: CHAT, companionId: 'c1', name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from('x') })
    const renamed = store.rename(f.id, 'b.md')
    expect(renamed.name).toBe('b.md')
    expect(renamed.mediaType).toBe('text/markdown')
    expect(existsSync(join(dir, f.id, 'b.md'))).toBe(true)
    expect(existsSync(join(dir, f.id, 'a.txt'))).toBe(false)
  })

  it('moves deleted files to the Trash, then forgets them', async () => {
    const trashed: string[] = []
    const store = new LibraryStore(dir, { trash: async (p) => void trashed.push(p) })
    const f = store.addGenerated({ chatId: CHAT, companionId: 'c1', name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from('x') })
    const { trashedPath } = await store.remove(f.id)
    expect(trashed).toEqual([join(dir, f.id, 'a.txt')])
    expect(trashedPath).toBe(trashed[0])
    expect(store.get(f.id)).toBeNull()
    expect(existsSync(join(dir, f.id))).toBe(false)
  })

  it('keeps files of a deleted chat, with no chat', () => {
    const store = new LibraryStore(dir)
    const f = store.addGenerated({ chatId: CHAT, companionId: 'c1', name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from('x') })
    store.forgetChat(CHAT)
    expect(store.get(f.id)?.chatId).toBeNull()
  })

  it('falls back to the folders when the index is corrupt', () => {
    const store = new LibraryStore(dir)
    const a = store.addGenerated({ chatId: CHAT, companionId: 'c1', name: 'a.md', mediaType: 'text/markdown', bytes: Buffer.from('# a') })
    writeFileSync(join(dir, 'index.json'), '{ not json')
    const reopened = new LibraryStore(dir)
    expect(reopened.list()).toEqual([expect.objectContaining({ id: a.id, name: 'a.md', kind: 'generated', state: 'ready', size: 3 })])
    // The rebuilt index is written back.
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).items).toHaveLength(1)
  })

  it('falls back per entry: one bad entry comes back from its folder, the others keep their details', () => {
    const store = new LibraryStore(dir)
    const good = store.saveArtifact({ chatId: CHAT, companionId: 'c1', name: 'good.html', content: '<p/>' }).file
    const bad = store.addGenerated({ chatId: CHAT, companionId: 'c2', name: 'bad.csv', mediaType: 'text/csv', bytes: Buffer.from('a,b') })
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { items: Record<string, unknown>[] }
    index.items = index.items.map((e) => (e.id === bad.id ? { ...e, kind: 42 } : e))
    index.items.push({ id: 'not-an-id', name: 'x' }, 'junk' as unknown as Record<string, unknown>)
    writeFileSync(join(dir, 'index.json'), JSON.stringify(index))
    const reopened = new LibraryStore(dir)
    expect(reopened.get(good.id)).toMatchObject({ kind: 'artifact', chatId: CHAT, companionId: 'c1' })
    expect(reopened.get(bad.id)).toMatchObject({ name: 'bad.csv', kind: 'generated', chatId: null })
    expect(reopened.list()).toHaveLength(2)
  })

  it('drops index entries whose files are gone, and ignores stray folders', () => {
    const store = new LibraryStore(dir)
    const f = store.addGenerated({ chatId: CHAT, companionId: 'c1', name: 'a.txt', mediaType: 'text/plain', bytes: Buffer.from('x') })
    rmSync(join(dir, f.id), { recursive: true })
    mkdirSync(join(dir, 'not-a-uuid'))
    expect(new LibraryStore(dir).list()).toEqual([])
  })

  it('reads entries strictly', () => {
    expect(readEntry({ id: '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e', name: 'a/b', kind: 'generated', state: 'ready' })).toBeNull()
    expect(readEntry({ id: '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e', name: 'a.md', kind: 'report', state: 'writing' })).toMatchObject({ mediaType: 'text/markdown', size: 0, chatId: null })
  })
})

describe('setupFiles', () => {
  it('broadcasts the list once per burst of changes and fires ON-13 once', async () => {
    vi.useFakeTimers()
    try {
      const events: LibraryFileRef[][] = []
      const files = setupFiles({ dataDir: dir, broadcast: (e) => events.push(e.items) })
      const built = vi.fn()
      files.library.onArtifactBuilt(built)
      files.library.saveArtifact({ chatId: CHAT, companionId: 'c1', title: 'Q3 plan', format: 'markdown', content: '# Plan' })
      files.library.saveArtifact({ chatId: CHAT, companionId: 'c1', title: 'Chart', format: 'svg', content: '<svg/>' })
      vi.advanceTimersByTime(100)
      expect(events).toHaveLength(1)
      expect(events[0]?.map((f) => f.name).sort()).toEqual(['Chart.svg', 'Q3 plan.md'])
      expect(built).toHaveBeenCalledTimes(1)
      expect(built.mock.calls[0]?.[0]).toMatchObject({ name: 'Q3 plan.md' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to open non-artifact kinds or unfinished files as artifact tabs', () => {
    const opened: string[] = []
    const files = setupFiles({ dataDir: dir, broadcast: () => {}, openArtifact: (id) => opened.push(id) })
    const csv = files.library.saveArtifact({ chatId: CHAT, companionId: 'c1', title: 'Data', format: 'csv', content: 'a,b' })
    const html = files.library.saveArtifact({ chatId: CHAT, companionId: 'c1', title: 'Page', format: 'html', content: '<p/>' })
    const report = files.library.beginReport({ chatId: CHAT, companionId: 'c1', name: 'Live.html', mediaType: 'text/html', kind: 'artifact' })
    expect(() => files.services.files.openArtifact(csv.id)).toThrow(/HTML, SVG and Markdown/)
    expect(() => files.services.files.openArtifact(report.id)).toThrow(/still writing/)
    files.services.files.openArtifact(html.id)
    expect(opened).toEqual([html.id])
  })

  it('names artifacts from their titles', () => {
    expect(artifactFileName('Q3 / plan: draft', 'markdown')).toBe('Q3 plan draft.md')
    expect(artifactFileName('   ', 'html')).toBe('Artifact.html')
  })
})

describe('Files page filters', () => {
  const file = (over: Partial<LibraryFileRef>): LibraryFileRef => ({ id: 'x', name: 'a', mediaType: 'text/plain', size: 1, kind: 'generated', chatId: null, companionId: 'c1', createdAt: 0, state: 'ready', artifact: false, ...over })
  const items = [
    file({ id: '1', name: 'Quarterly report.md', kind: 'report', createdAt: 3, size: 10, chatId: 'a' }),
    file({ id: '2', name: 'chart.png', kind: 'generated', createdAt: 1, size: 50, companionId: 'c2', chatId: 'b' }),
    file({ id: '3', name: 'Résumé.html', kind: 'artifact', createdAt: 2, size: 5, chatId: 'a' }),
  ]

  it('filters by kind, companion, chat and words (accents ignored), and sorts', () => {
    expect(filterLibrary(items, LIBRARY_VIEW_DEFAULT).map((f) => f.id)).toEqual(['1', '3', '2'])
    expect(filterLibrary(items, { ...LIBRARY_VIEW_DEFAULT, kind: 'artifact' }).map((f) => f.id)).toEqual(['3'])
    expect(filterLibrary(items, { ...LIBRARY_VIEW_DEFAULT, companionId: 'c2' }).map((f) => f.id)).toEqual(['2'])
    expect(filterLibrary(items, { ...LIBRARY_VIEW_DEFAULT, chatId: 'a', sort: 'oldest' }).map((f) => f.id)).toEqual(['3', '1'])
    expect(filterLibrary(items, { ...LIBRARY_VIEW_DEFAULT, query: 'resume' }).map((f) => f.id)).toEqual(['3'])
    expect(filterLibrary(items, { ...LIBRARY_VIEW_DEFAULT, sort: 'size' }).map((f) => f.id)).toEqual(['2', '1', '3'])
    expect(filterLibrary(items, { ...LIBRARY_VIEW_DEFAULT, sort: 'name' }).map((f) => f.id)).toEqual(['2', '1', '3'])
    expect(matchesName('Quarterly report', 'report quart')).toBe(true)
  })

  it('groups Generated, Reports, then Artifacts, and lists chats newest first', () => {
    expect(groupLibrary(items).map((g) => g.kind)).toEqual(['generated', 'report', 'artifact'])
    expect(groupLibrary([items[0] as LibraryFileRef]).map((g) => g.kind)).toEqual(['report'])
    expect(chatsWithFiles(items)).toEqual(['a', 'b'])
  })
})
