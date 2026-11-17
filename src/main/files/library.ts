/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LibraryFileKind, LibraryFileRef, LibraryFilesFilter } from '@shared/files'
import { mediaTypeOf } from '@shared/fileKinds'
import { matchesName } from '@shared/filesLogic'
import { cleanFileName } from '../companionFiles'
import { mainT } from '../i18n/mainT'

// Library › Files' store: generated files, reports and artifacts under
// userData/library/<id>/<name>, listed in index.json. The index is a cache of
// the folders: a corrupt file, or a corrupt entry in it, falls back to what
// the folder holds, so one bad entry never hides the others.

export const LIBRARY_INDEX_VERSION = 1

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const KINDS: readonly LibraryFileKind[] = ['generated', 'report', 'artifact']
const STATES = ['writing', 'ready', 'failed'] as const

interface Entry extends LibraryFileRef {
  /** Why a report failed; shown by the viewer. */
  error: string | null
}

interface IndexFile {
  version: number
  /** When the first artifact was saved (ON-13 fires once, ever). */
  firstArtifactAt: number | null
  items: unknown[]
}

export interface LibraryStoreOptions {
  /** Moves a path to the Trash (Recently Deleted takes over when wired); without it, deletes. */
  trash?: (path: string) => Promise<void>
  now?: () => number
  /** Fires after any change, with the whole list. */
  onChange?: (items: LibraryFileRef[]) => void
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** One index entry, or null when it is malformed (it then comes back from its folder). */
export function readEntry(raw: unknown): Entry | null {
  if (!isObject(raw)) return null
  const { id, name, mediaType, size, kind, chatId, companionId, createdAt, state, artifact, error } = raw
  if (typeof id !== 'string' || !ID.test(id)) return null
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') return null
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null
  if (typeof state !== 'string' || !(STATES as readonly string[]).includes(state)) return null
  return {
    id,
    name,
    mediaType: typeof mediaType === 'string' && mediaType ? mediaType : mediaTypeOf(name),
    size: typeof size === 'number' && size >= 0 ? size : 0,
    kind: kind as LibraryFileKind,
    chatId: typeof chatId === 'string' ? chatId : null,
    companionId: typeof companionId === 'string' ? companionId : '',
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
    state: state as LibraryFileRef['state'],
    artifact: artifact === true,
    error: typeof error === 'string' ? error : null,
  }
}

export class LibraryStore {
  readonly root: string
  readonly #options: LibraryStoreOptions
  #entries: Map<string, Entry> | null = null
  #firstArtifactAt: number | null = null

  constructor(root: string, options: LibraryStoreOptions = {}) {
    this.root = root
    this.#options = options
  }

  get #now(): number {
    return (this.#options.now ?? Date.now)()
  }

  /** Loads lazily, so constructing the store touches nothing on disk. */
  #load(): Map<string, Entry> {
    if (this.#entries) return this.#entries
    const entries = new Map<string, Entry>()
    let file: IndexFile | null = null
    try {
      const parsed = JSON.parse(readFileSync(join(this.root, 'index.json'), 'utf8')) as unknown
      if (isObject(parsed) && Array.isArray(parsed.items)) file = parsed as unknown as IndexFile
    } catch {
      // Missing or unreadable: every entry comes back from its folder below.
    }
    this.#firstArtifactAt = typeof file?.firstArtifactAt === 'number' ? file.firstArtifactAt : null
    for (const raw of file?.items ?? []) {
      const entry = readEntry(raw)
      if (entry && existsSync(this.#pathFor(entry))) entries.set(entry.id, entry)
    }
    // Folders the index doesn't describe (a corrupt index or entry) come back as generated files.
    let recovered = false
    if (existsSync(this.root)) {
      for (const dir of readdirSync(this.root, { withFileTypes: true })) {
        if (!dir.isDirectory() || !ID.test(dir.name) || entries.has(dir.name)) continue
        const recoveredEntry = this.#recover(dir.name)
        if (recoveredEntry) {
          entries.set(recoveredEntry.id, recoveredEntry)
          recovered = true
        }
      }
    }
    this.#entries = entries
    if (recovered || (file !== null && file.items.length !== entries.size)) this.#save()
    return entries
  }

  #recover(id: string): Entry | null {
    const folder = join(this.root, id)
    const files = readdirSync(folder, { withFileTypes: true }).filter((f) => f.isFile() && !f.name.startsWith('.'))
    const first = files[0]
    if (!first) return null
    const stat = statSync(join(folder, first.name))
    return { id, name: first.name, mediaType: mediaTypeOf(first.name), size: stat.size, kind: 'generated', chatId: null, companionId: '', createdAt: Math.round(stat.mtimeMs), state: 'ready', artifact: false, error: null }
  }

  #pathFor(entry: { id: string; name: string }): string {
    return join(this.root, entry.id, entry.name)
  }

  #save(): void {
    if (!this.#entries) return
    mkdirSync(this.root, { recursive: true })
    const file: IndexFile = { version: LIBRARY_INDEX_VERSION, firstArtifactAt: this.#firstArtifactAt, items: [...this.#entries.values()] }
    const target = join(this.root, 'index.json')
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2))
    renameSync(tmp, target)
  }

  #changed(): void {
    this.#save()
    this.#options.onChange?.(this.list())
  }

  #ref(entry: Entry): LibraryFileRef {
    const { error: _error, ...ref } = entry
    return ref
  }

  #create(input: { chatId: string | null; companionId: string; name: string; mediaType?: string; kind: LibraryFileKind; state: LibraryFileRef['state']; artifact: boolean }, content: string | Buffer): Entry {
    const entries = this.#load()
    const id = randomUUID()
    const name = cleanFileName(input.name)
    mkdirSync(join(this.root, id), { recursive: true })
    const entry: Entry = {
      id,
      name,
      mediaType: input.mediaType || mediaTypeOf(name),
      size: Buffer.byteLength(content),
      kind: input.kind,
      chatId: input.chatId,
      companionId: input.companionId,
      createdAt: this.#now,
      state: input.state,
      artifact: input.artifact,
      error: null,
    }
    writeFileSync(this.#pathFor(entry), content)
    entries.set(id, entry)
    return entry
  }

  #get(id: string): Entry {
    const entry = this.#load().get(id)
    if (!entry) throw new Error(mainT('files.error.gone'))
    return entry
  }

  get(id: string): LibraryFileRef | null {
    const entry = this.#load().get(id)
    return entry ? this.#ref(entry) : null
  }

  /** Why a report failed, if it did. */
  errorOf(id: string): string | null {
    return this.#load().get(id)?.error ?? null
  }

  pathOf(id: string): string {
    return this.#pathFor(this.#get(id))
  }

  list(filter: LibraryFilesFilter = {}): LibraryFileRef[] {
    return [...this.#load().values()]
      .filter((e) => (!filter.kind || e.kind === filter.kind) && (!filter.chatId || e.chatId === filter.chatId) && (!filter.companionId || e.companionId === filter.companionId) && (!filter.query || matchesName(e.name, filter.query)))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((e) => this.#ref(e))
  }

  listByChat(chatId: string): LibraryFileRef[] {
    return this.list({ chatId })
  }

  addGenerated(input: { chatId: string; companionId: string; name: string; mediaType: string; bytes: Buffer }): LibraryFileRef {
    const entry = this.#create({ ...input, kind: 'generated', state: 'ready', artifact: false }, input.bytes)
    this.#changed()
    return this.#ref(entry)
  }

  /** Saves an artifact (save_artifact). HTML and SVG open as artifact tabs; Markdown and the rest open in the viewer. Returns whether it was the first artifact ever (ON-13). */
  saveArtifact(input: { chatId: string | null; companionId: string; name: string; mediaType?: string; content: string | Buffer }): { file: LibraryFileRef; first: boolean } {
    const mediaType = input.mediaType || mediaTypeOf(input.name)
    const artifact = mediaType === 'text/html' || mediaType === 'image/svg+xml'
    const entry = this.#create({ ...input, mediaType, kind: 'artifact', state: 'ready', artifact }, input.content)
    const first = this.#markArtifact()
    this.#changed()
    return { file: this.#ref(entry), first }
  }

  #markArtifact(): boolean {
    this.#load()
    if (this.#firstArtifactAt !== null) return false
    this.#firstArtifactAt = this.#now
    return true
  }

  beginReport(input: { chatId: string; companionId: string; name: string; mediaType: string; kind?: 'report' | 'artifact' }): LibraryFileRef {
    const kind = input.kind ?? 'report'
    const entry = this.#create({ ...input, kind, state: 'writing', artifact: kind === 'artifact' && (input.mediaType === 'text/html' || input.mediaType === 'image/svg+xml') }, '')
    this.#changed()
    return this.#ref(entry)
  }

  /** The report so far, while it is still being written. */
  updateReport(id: string, content: string | Buffer): LibraryFileRef {
    const entry = this.#get(id)
    if (entry.state !== 'writing') throw new Error(mainT('files.error.reportDone'))
    writeFileSync(this.#pathFor(entry), content)
    entry.size = Buffer.byteLength(content)
    this.#changed()
    return this.#ref(entry)
  }

  finishReport(id: string, content: string | Buffer): { file: LibraryFileRef; first: boolean } {
    const entry = this.#get(id)
    writeFileSync(this.#pathFor(entry), content)
    entry.size = Buffer.byteLength(content)
    entry.state = 'ready'
    entry.error = null
    const first = entry.kind === 'artifact' ? this.#markArtifact() : false
    this.#changed()
    return { file: this.#ref(entry), first }
  }

  fail(id: string, message: string): void {
    const entry = this.#load().get(id)
    if (!entry) return
    entry.state = 'failed'
    entry.error = message.slice(0, 500)
    this.#changed()
  }

  /** Text saved from the viewer; the size follows. */
  write(id: string, content: string | Buffer): LibraryFileRef {
    const entry = this.#get(id)
    if (entry.state === 'writing') throw new Error(mainT('files.error.stillWriting'))
    writeFileSync(this.#pathFor(entry), content)
    entry.size = Buffer.byteLength(content)
    this.#changed()
    return this.#ref(entry)
  }

  rename(id: string, name: string): LibraryFileRef {
    const entry = this.#get(id)
    const next = cleanFileName(name)
    if (next !== entry.name) {
      renameSync(this.#pathFor(entry), join(this.root, id, next))
      entry.name = next
      entry.mediaType = mediaTypeOf(next) === 'application/octet-stream' ? entry.mediaType : mediaTypeOf(next)
      this.#changed()
    }
    return this.#ref(entry)
  }

  /** Moves the file to the Trash and drops it from the list. Resolves to where it went (null when deleted outright). */
  async remove(id: string): Promise<{ file: LibraryFileRef; trashedPath: string | null }> {
    const entry = this.#get(id)
    const path = this.#pathFor(entry)
    const folder = join(this.root, id)
    let trashedPath: string | null = null
    if (this.#options.trash && existsSync(path)) {
      await this.#options.trash(path)
      trashedPath = path
    }
    rmSync(folder, { recursive: true, force: true })
    this.#load().delete(id)
    this.#changed()
    return { file: this.#ref(entry), trashedPath }
  }

  /** The chat was deleted: its files stay, with no chat. */
  forgetChat(chatId: string): void {
    let changed = false
    for (const entry of this.#load().values()) {
      if (entry.chatId === chatId) {
        entry.chatId = null
        changed = true
      }
    }
    if (changed) this.#changed()
  }

  sizes(): { libraryFiles: number } {
    let total = 0
    for (const entry of this.#load().values()) total += entry.size
    return { libraryFiles: total }
  }
}
