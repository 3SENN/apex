/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Keeps the search index in step with Atelier's stores. A background build
// walks every source and indexes what changed since last time (stamps make
// it incremental), reporting progress as IndexState; after that, store
// events touch single items or whole sources, debounced. Private chats and
// drafts are never indexed.
import type { ChatSummary } from '@shared/chats'
import type { LibraryFileRef } from '@shared/files'
import { TEXT_FILE_MAX_BYTES, isTextFileName, type IndexState } from '@shared/workspace'
import { looksBinary } from './fsutil'
import type { FolderFile } from './folders'
import type { IndexDoc, SearchIndex } from './search'

/** One kind of item the index holds. Keys start with `prefix`. */
export interface SourceAdapter {
  prefix: string
  /** Every current item and its stamp. */
  list(): Promise<Map<string, string>>
  /** The item to index, or null when it is gone (or must never be indexed). */
  load(key: string): Promise<IndexDoc | null>
}

const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const BATCH = 40

export interface IndexerOptions {
  index: SearchIndex
  sources: SourceAdapter[]
  onState?(state: IndexState): void
  now?: () => number
  debounceMs?: number
}

export class Indexer {
  readonly #options: IndexerOptions
  readonly #now: () => number
  #state: IndexState = { building: false, done: 0, total: 0, updatedAt: null }
  #building: Promise<void> | null = null
  #again = false
  readonly #pendingKeys = new Set<string>()
  readonly #pendingSources = new Set<string>()
  #timer: NodeJS.Timeout | null = null
  #disposed = false

  constructor(options: IndexerOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  state(): IndexState {
    return { ...this.#state }
  }

  /** Indexes what changed since the last build. A second call while building runs once more afterwards. */
  build(): Promise<void> {
    if (this.#building) {
      this.#again = true
      return this.#building
    }
    this.#building = this.#run().finally(() => {
      this.#building = null
      if (this.#again && !this.#disposed) {
        this.#again = false
        void this.build()
      }
    })
    return this.#building
  }

  /** Empties the index and builds it again. */
  async rebuild(): Promise<void> {
    if (this.#building) await this.#building
    this.#options.index.clear()
    await this.build()
  }

  /** One item changed (or went); it is re-indexed shortly. */
  touch(key: string): void {
    this.#pendingKeys.add(key)
    this.#schedule()
  }

  /** Something changed somewhere in a source; it is synced shortly. */
  touchSource(prefix: string): void {
    this.#pendingSources.add(prefix)
    this.#schedule()
  }

  /** Runs the pending touches now (tests and smoke). */
  async flush(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    const keys = [...this.#pendingKeys]
    const prefixes = [...this.#pendingSources]
    this.#pendingKeys.clear()
    this.#pendingSources.clear()
    for (const prefix of prefixes) {
      const source = this.#options.sources.find((s) => s.prefix === prefix)
      if (source) await this.#sync(source, false)
    }
    for (const key of keys) {
      const source = this.#sourceOf(key)
      if (!source) continue
      try {
        const doc = await source.load(key)
        if (doc) this.#options.index.upsert(doc)
        else this.#options.index.remove(key)
      } catch {
        this.#options.index.remove(key)
      }
    }
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  #schedule(): void {
    if (this.#disposed || this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, this.#options.debounceMs ?? 500)
    this.#timer.unref?.()
  }

  #sourceOf(key: string): SourceAdapter | undefined {
    // The longest matching prefix wins ('folder:abc:' before 'folder:').
    return this.#options.sources.filter((s) => key.startsWith(s.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0]
  }

  async #run(): Promise<void> {
    this.#set({ building: true, done: 0, total: 0 })
    for (const source of this.#options.sources) {
      if (this.#disposed) break
      await this.#sync(source, true)
    }
    this.#set({ building: false, updatedAt: this.#now() })
  }

  async #sync(source: SourceAdapter, progress: boolean): Promise<void> {
    let listing: Map<string, string>
    try {
      listing = await source.list()
    } catch {
      return
    }
    const indexed = this.#options.index.keys(source.prefix)
    if (progress) this.#set({ total: this.#state.total + listing.size })
    let n = 0
    for (const [key, stamp] of listing) {
      if (this.#disposed) return
      if (indexed.get(key) !== stamp) {
        try {
          const doc = await source.load(key)
          if (doc) this.#options.index.upsert(doc)
          else this.#options.index.remove(key)
        } catch {
          // An unreadable item is left out; the next change retries it.
        }
      }
      if (progress) this.#state.done++
      if (++n % BATCH === 0) {
        if (progress) this.#emit()
        await yieldNow()
      }
    }
    for (const key of indexed.keys()) if (!listing.has(key) && this.#sourceOf(key) === source) this.#options.index.remove(key)
    if (progress) this.#emit()
  }

  #set(patch: Partial<IndexState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#emit()
  }

  #emit(): void {
    this.#options.onState?.(this.state())
  }
}

// ── Sources ──

const textOf = (data: Buffer | null, name: string): string => {
  if (!data || !isTextFileName(name) || data.byteLength > TEXT_FILE_MAX_BYTES || looksBinary(data)) return ''
  return data.toString('utf8')
}

const lastPart = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

export function chatSource(chats: { list(): ChatSummary[]; summary(id: string): ChatSummary | undefined; searchText(id: string): string }): SourceAdapter {
  // Private chats and drafts are never indexed; delegated children are.
  const indexable = (c: ChatSummary): boolean => !c.private && !c.draft
  return {
    prefix: 'chat:',
    async list() {
      return new Map(chats.list().filter(indexable).map((c) => [`chat:${c.id}`, `${c.updatedAt}:${c.title}`]))
    },
    async load(key) {
      const id = key.slice('chat:'.length)
      const c = chats.summary(id)
      if (!c || !indexable(c)) return null
      return { key, source: 'chats', title: c.title || 'Untitled chat', body: chats.searchText(id), url: `atelier://chat/${id}`, ref: null, at: c.lastActiveAt, profile: null, stamp: `${c.updatedAt}:${c.title}` }
    },
  }
}

export interface MemoryReader {
  owners(): string[]
  list(owner: string): Array<{ path: string; size: number; modifiedAt: number }>
  read(path: string, owner: string): string
}

export function memorySource(memory: MemoryReader): SourceAdapter {
  const split = (key: string): { owner: string; path: string } => {
    const rest = key.slice('memory:'.length)
    const at = rest.indexOf(':')
    return { owner: rest.slice(0, at), path: rest.slice(at + 1) }
  }
  return {
    prefix: 'memory:',
    async list() {
      const out = new Map<string, string>()
      for (const owner of memory.owners()) {
        try {
          for (const f of memory.list(owner)) out.set(`memory:${owner}:${f.path}`, `${f.modifiedAt}:${f.size}`)
        } catch {
          // A companion whose folder can't be read is skipped.
        }
      }
      return out
    },
    async load(key) {
      const { owner, path } = split(key)
      const file = memory.list(owner).find((f) => f.path === path)
      if (!file || file.size > TEXT_FILE_MAX_BYTES) return null
      const body = memory.read(path, owner)
      return { key, source: 'memory', title: lastPart(path), body, url: null, ref: { kind: 'memory', owner, path }, at: file.modifiedAt, profile: null, stamp: `${file.modifiedAt}:${file.size}` }
    },
  }
}

export interface HistoryReader {
  profile: string
  entries(): Array<{ url: string; title: string; lastVisit: number }>
}

export function historySource(history: HistoryReader): SourceAdapter {
  const prefix = `history:${history.profile}:`
  return {
    prefix,
    async list() {
      return new Map(history.entries().map((e) => [`${prefix}${e.url}`, `${e.lastVisit}:${e.title}`]))
    },
    async load(key) {
      const url = key.slice(prefix.length)
      const e = history.entries().find((x) => x.url === url)
      if (!e) return null
      return { key, source: 'history', title: e.title || url, body: url.replace(/^https?:\/\/(www\.)?/i, ''), url, ref: null, at: e.lastVisit, profile: history.profile, stamp: `${e.lastVisit}:${e.title}` }
    },
  }
}

export interface BookmarkReader {
  profile: string
  list(): Array<{ id: string; url: string; title: string; createdAt: number }>
}

export function bookmarkSource(bookmarks: BookmarkReader): SourceAdapter {
  const prefix = `bookmark:${bookmarks.profile}:`
  return {
    prefix,
    async list() {
      return new Map(bookmarks.list().map((b) => [`${prefix}${b.id}`, `${b.title}:${b.url}`]))
    },
    async load(key) {
      const id = key.slice(prefix.length)
      const b = bookmarks.list().find((x) => x.id === id)
      if (!b) return null
      return { key, source: 'bookmarks', title: b.title || b.url, body: b.url.replace(/^https?:\/\/(www\.)?/i, ''), url: b.url, ref: null, at: b.createdAt, profile: bookmarks.profile, stamp: `${b.title}:${b.url}` }
    },
  }
}

/** Files in a set of roots (watched folders, companion folders): names always, text bodies up to 2 MB. */
export interface FileRootReader {
  /** The roots right now: an id, a display name, and how a ref to one of its files looks. */
  roots(): Array<{ id: string; ref(path: string): IndexDoc['ref'] }>
  files(rootId: string): Promise<FolderFile[]>
  stat(rootId: string, path: string): { size: number; modifiedAt: number } | null
  read(rootId: string, path: string): Buffer | null
}

export function fileSource(prefix: 'folder:' | 'companion:', reader: FileRootReader): SourceAdapter {
  const split = (key: string): { root: string; path: string } => {
    const rest = key.slice(prefix.length)
    const at = rest.indexOf(':')
    return { root: rest.slice(0, at), path: rest.slice(at + 1) }
  }
  return {
    prefix,
    async list() {
      const out = new Map<string, string>()
      for (const root of reader.roots()) {
        for (const f of await reader.files(root.id)) out.set(`${prefix}${root.id}:${f.path}`, `${f.modifiedAt}:${f.size}`)
      }
      return out
    },
    async load(key) {
      const { root, path } = split(key)
      const known = reader.roots().find((r) => r.id === root)
      if (!known) return null
      const info = reader.stat(root, path)
      if (!info) return null
      // Binaries and large files are found by name only.
      const body = isTextFileName(path) && info.size <= TEXT_FILE_MAX_BYTES ? textOf(reader.read(root, path), path) : ''
      return { key, source: 'files', title: lastPart(path), body: body || path, url: null, ref: known.ref(path), at: info.modifiedAt, profile: null, stamp: `${info.modifiedAt}:${info.size}` }
    },
  }
}

export function librarySource(library: { list(): LibraryFileRef[] }): SourceAdapter {
  return {
    prefix: 'library:',
    async list() {
      return new Map(library.list().filter((f) => f.state === 'ready').map((f) => [`library:${f.id}`, `${f.size}:${f.name}`]))
    },
    async load(key) {
      const id = key.slice('library:'.length)
      const f = library.list().find((x) => x.id === id)
      if (!f || f.state !== 'ready') return null
      return { key, source: 'files', title: f.name, body: `${f.name} ${f.mediaType}`, url: null, ref: { kind: 'library', id: f.id }, at: f.createdAt, profile: null, stamp: `${f.size}:${f.name}` }
    },
  }
}
