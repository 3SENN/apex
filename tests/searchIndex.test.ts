/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS, type ChatSummary } from '@shared/chats'
import { HIT_OPEN, plainSnippet, snippetParts } from '@shared/workspace'
import { openDb } from '../src/main/db'
import { FolderStore } from '../src/main/workspace/folders'
import { Indexer, bookmarkSource, chatSource, fileSource, historySource, memorySource } from '../src/main/workspace/indexer'
import { SearchIndex, ftsQuery } from '../src/main/workspace/search'

const DAY = 86_400_000
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const chat = (id: string, title: string, patch: Partial<ChatSummary> = {}): ChatSummary => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  lastActiveAt: 1,
  routineId: null,
  companionId: 'pip',
  model: 'm',
  status: 'idle',
  unread: false,
  pinned: false,
  archived: false,
  needsInput: false,
  draft: false,
  ...CHAT_SUMMARY_FLAG_DEFAULTS,
  ...CHAT_SUMMARY_LINK_DEFAULTS,
  ...patch,
})

function world(now = 100 * DAY) {
  const chats = new Map<string, ChatSummary>()
  const texts = new Map<string, string>()
  const memory = new Map<string, Map<string, { text: string; modifiedAt: number }>>([['shared', new Map()], ['pip', new Map()]])
  const history: Array<{ url: string; title: string; lastVisit: number }> = []
  const bookmarks: Array<{ id: string; url: string; title: string; createdAt: number }> = []
  const index = new SearchIndex(openDb(':memory:'), () => now)
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'apex-search-')))
  dirs.push(base)
  const folders = new FolderStore({ db: openDb(':memory:') })
  const indexer = new Indexer({
    index,
    debounceMs: 0,
    sources: [
      chatSource({ list: () => [...chats.values()], summary: (id) => chats.get(id), searchText: (id) => texts.get(id) ?? '' }),
      memorySource({
        owners: () => [...memory.keys()],
        list: (owner) => [...(memory.get(owner) ?? new Map()).entries()].map(([path, f]) => ({ path, size: f.text.length, modifiedAt: f.modifiedAt })),
        read: (path, owner) => memory.get(owner)?.get(path)?.text ?? '',
      }),
      historySource({ profile: 'default', entries: () => history }),
      bookmarkSource({ profile: 'default', list: () => bookmarks }),
      bookmarkSource({ profile: 'work', list: () => [{ id: 'w1', url: 'https://intranet.example/okr', title: 'Quarterly OKR board', createdAt: 1 }] }),
      fileSource('folder:', {
        roots: () => folders.list().map((f) => ({ id: f.id, ref: (path: string) => ({ kind: 'folder' as const, folderId: f.id, path }) })),
        files: (id) => folders.files(id),
        stat: (id, path) => {
          const bytes = folders.readBytes(id, path)
          return bytes ? { size: bytes.byteLength, modifiedAt: 1 } : null
        },
        read: (id, path) => folders.readBytes(id, path),
      }),
    ],
  })
  return { chats, texts, memory, history, bookmarks, index, indexer, folders, base }
}

describe('ftsQuery', () => {
  it('quotes words, prefix-matches them and ignores operators', () => {
    expect(ftsQuery('kyoto trip')).toBe('"kyoto"* "trip"*')
    expect(ftsQuery('NOT a OR "b"')).toBe('"NOT"* "a"* "OR"* "b"*')
    expect(ftsQuery('  ...  ')).toBeNull()
  })
})

describe('search everything', () => {
  it('finds a chat, a memory note, a history entry, a bookmark and a folder file', async () => {
    const w = world()
    w.chats.set('c1', chat('c1', 'Planning the Kyoto trip', { updatedAt: 2, lastActiveAt: 2 }))
    w.texts.set('c1', 'We compared ryokan prices near Gion.')
    w.memory.get('pip')!.set('/memories/travel.md', { text: 'Prefers trains over flights', modifiedAt: 3 })
    w.history.push({ url: 'https://www.example.com/sourdough', title: 'Sourdough starter guide', lastVisit: 4 })
    w.bookmarks.push({ id: 'b1', url: 'https://maps.example/route', title: 'Cycling route map', createdAt: 5 })
    mkdirSync(join(w.base, 'Notes'))
    writeFileSync(join(w.base, 'Notes', 'budget.md'), 'Quarterly budget for the garden project')
    w.folders.grant({ path: join(w.base, 'Notes'), mode: 'read', scope: 'all-chats' })
    await w.indexer.build()
    expect(w.indexer.state()).toMatchObject({ building: false, done: 6, total: 6 })
    expect(w.index.query('ryokan').hits[0]).toMatchObject({ source: 'chats', title: 'Planning the Kyoto trip', url: 'apex://chat/c1' })
    expect(w.index.query('ryokan').hits[0]?.snippet).toContain(`${HIT_OPEN}ryokan`)
    expect(w.index.query('trains').hits[0]).toMatchObject({ source: 'memory', ref: { kind: 'memory', owner: 'pip', path: '/memories/travel.md' } })
    expect(w.index.query('sourdough').hits[0]).toMatchObject({ source: 'history', url: 'https://www.example.com/sourdough' })
    expect(w.index.query('cycling').hits[0]).toMatchObject({ source: 'bookmarks' })
    expect(w.index.query('garden').hits[0]).toMatchObject({ source: 'files', title: 'budget.md', ref: { kind: 'folder', path: 'budget.md' } })
    // Stemming: "plans" finds "Planning".
    expect(w.index.query('plans').total).toBe(1)
    expect(w.index.query('garden', { sources: ['chats'] }).total).toBe(0)
  })

  it('never indexes private chats or drafts, and drops deleted chats', async () => {
    const w = world()
    w.chats.set('c1', chat('c1', 'Secret surprise party', { private: true }))
    w.chats.set('c2', chat('c2', 'Surprise draft', { draft: true }))
    w.chats.set('c3', chat('c3', 'Surprise gift ideas'))
    await w.indexer.build()
    expect(w.index.query('surprise').hits.map((h) => h.id)).toEqual(['chat:c3'])
    w.chats.delete('c3')
    w.indexer.touch('chat:c3')
    await w.indexer.flush()
    expect(w.index.query('surprise').total).toBe(0)
  })

  it('indexes children of delegated chats', async () => {
    const w = world()
    w.chats.set('k1', chat('k1', 'Compare flight prices', { parentChatId: 'c1' }))
    await w.indexer.build()
    expect(w.index.query('flight').total).toBe(1)
  })

  it('filters history and bookmarks to the window’s profile', async () => {
    const w = world()
    await w.indexer.build()
    expect(w.index.query('okr', { profile: 'default' }).total).toBe(0)
    expect(w.index.query('okr', { profile: 'work' }).total).toBe(1)
  })

  it('ranks title matches and recent items higher', async () => {
    const now = 100 * DAY
    const w = world(now)
    w.chats.set('old', chat('old', 'Notes', { updatedAt: 1, lastActiveAt: now - 90 * DAY }))
    w.texts.set('old', 'tomato harvest tomato soup')
    w.chats.set('title', chat('title', 'Tomato harvest', { updatedAt: 1, lastActiveAt: now - 90 * DAY }))
    await w.indexer.build()
    expect(w.index.query('tomato').hits[0]?.id).toBe('chat:title')
    w.chats.set('new', chat('new', 'Notes', { updatedAt: 2, lastActiveAt: now }))
    w.texts.set('new', 'tomato harvest tomato soup')
    await w.indexer.build()
    const order = w.index.query('tomato soup').hits.map((h) => h.id)
    expect(order.indexOf('chat:new')).toBeLessThan(order.indexOf('chat:old'))
  })

  it('is incremental: unchanged items are not re-read, changed ones are', async () => {
    const w = world()
    w.chats.set('c1', chat('c1', 'Alpha'))
    let reads = 0
    w.texts.set('c1', 'first words')
    const original = w.texts.get.bind(w.texts)
    w.texts.get = (k: string) => {
      reads++
      return original(k)
    }
    await w.indexer.build()
    await w.indexer.build()
    expect(reads).toBe(1)
    w.chats.set('c1', chat('c1', 'Alpha', { updatedAt: 9 }))
    w.texts.set('c1', 'second words')
    w.indexer.touchSource('chat:')
    await w.indexer.flush()
    expect(w.index.query('second').total).toBe(1)
    expect(w.index.query('first').total).toBe(0)
  })

  it('rebuilds from nothing, and pages with limit and offset', async () => {
    const w = world()
    for (let i = 0; i < 5; i++) w.chats.set(`c${i}`, chat(`c${i}`, `Meeting notes ${i}`))
    await w.indexer.build()
    expect(w.index.count()).toBe(6)
    w.index.clear()
    expect(w.index.query('meeting').total).toBe(0)
    await w.indexer.rebuild()
    const page = w.index.query('meeting', { limit: 2, offset: 2 })
    expect(page.total).toBe(5)
    expect(page.hits).toHaveLength(2)
  })
})

describe('snippets', () => {
  it('splits highlights and strips them for plain text', () => {
    const s = `a ${HIT_OPEN}word\u0003 b`
    expect(snippetParts(s)).toEqual([{ text: 'a ', hit: false }, { text: 'word', hit: true }, { text: ' b', hit: false }])
    expect(plainSnippet(s)).toBe('a word b')
  })
})

describe('recent items (Home, the project file picker)', () => {
  it('lists the newest items of the chosen sources for the profile, without snippets', () => {
    const index = new SearchIndex(openDb(':memory:'), () => 100 * DAY)
    const doc = (key: string, source: 'files' | 'memory' | 'history', at: number, profile: string | null = null) =>
      index.upsert({ key, source, title: key, body: `${key} body`, url: null, ref: source === 'history' ? null : { kind: 'library', id: key.replace(/\W/g, '') }, at, profile, stamp: String(at) })
    doc('files:a', 'files', 10)
    doc('files:b', 'files', 30)
    doc('memory:c', 'memory', 20)
    doc('history:work:d', 'history', 40, 'work')
    doc('history:default:e', 'history', 50, 'default')
    expect(index.recent({ sources: ['files', 'memory'] }).map((h) => h.id)).toEqual(['files:b', 'memory:c', 'files:a'])
    expect(index.recent({ sources: ['files'], limit: 1 }).map((h) => h.id)).toEqual(['files:b'])
    expect(index.recent({ sources: ['history'] }).map((h) => h.id)).toEqual(['history:default:e'])
    expect(index.recent({ sources: ['history'], profile: 'work' }).map((h) => h.id)).toEqual(['history:work:d'])
    const [first] = index.recent({ sources: ['files'] })
    expect(first?.snippet).toBe('')
    expect(first?.ref).toEqual({ kind: 'library', id: 'filesb' })
  })
})
