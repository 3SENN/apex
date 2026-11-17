/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Watched folders (CH-43): local folders you let Apex read, or
// read and edit, for all chats or one chat, optionally for one companion.
// Grants live in workspace.sqlite. Every path is confined twice: the
// relative path may not climb out, and the realpath of the nearest existing
// part must stay inside the realpath of the grant, so a symlink can't lead
// out either. fs.watch (FSEvents on macOS) reports changes for the index;
// a volume that can't be watched just isn't kept fresh.
import { BRAND_NAME } from '@shared/branding'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { FOLDER_INDEX_MAX_FILES, TEXT_FILE_MAX_BYTES, WRITE_FILE_MAX_BYTES, isTextFileName, type FileRef, type FolderEntry, type WatchedFolder } from '@shared/workspace'
import { migrate, type DatabaseSync } from '../db'
import { looksBinary, writeAtomic } from './fsutil'

export const FOLDER_STEPS = [
  `CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    mode TEXT NOT NULL,
    scope TEXT NOT NULL,
    companion_id TEXT,
    added_at INTEGER NOT NULL,
    file_count INTEGER
  );`,
]

/** Names never listed, indexed or offered to the agent. */
const SKIPPED_DIRS = new Set(['node_modules', '.git'])
const VIEWABLE = /\.(pdf|png|jpe?g|gif|webp|svg)$/i

const OUTSIDE = 'That path is outside the folder.'

/** The parts of a relative path, or a throw for anything that could climb out. */
export function relativeParts(rel: string): string[] {
  if (rel.includes('\0') || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || /^[\\/]/.test(rel)) throw new Error(OUTSIDE)
  const parts = rel.split(/[\\/]+/).filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw new Error(OUTSIDE)
  return parts
}

/**
 * The absolute path `rel` names inside `root`, or a throw. `root` is
 * resolved through realpath, and so is the nearest part of the target that
 * exists, so symlinks inside the folder can't point out of it.
 */
export function confine(root: string, rel: string): string {
  const realRoot = realpathSync(root)
  const target = resolve(realRoot, ...relativeParts(rel))
  if (target !== realRoot && !target.startsWith(realRoot + sep)) throw new Error(OUTSIDE)
  let existing = target
  while (existing !== realRoot && !exists(existing)) existing = dirname(existing)
  const real = realpathSync(existing)
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error(OUTSIDE)
  return target
}

/** lstat-based: a dangling symlink still "exists" and is then refused by realpath. */
function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

const toPosix = (p: string): string => p.split(sep).join('/')

interface Row {
  id: string
  path: string
  name: string
  mode: WatchedFolder['mode']
  scope: string
  companion_id: string | null
  added_at: number
  file_count: number | null
}

const toFolder = (r: Row): WatchedFolder => ({
  id: r.id,
  path: r.path,
  name: r.name,
  mode: r.mode,
  scope: JSON.parse(r.scope) as WatchedFolder['scope'],
  companionId: r.companion_id,
  addedAt: r.added_at,
  fileCount: r.file_count,
})

export interface FolderFile {
  path: string
  size: number
  modifiedAt: number
}

export interface FolderStoreOptions {
  db: DatabaseSync
  now?: () => number
  /** Folders that may never be granted (Apex's own data folder). */
  blocked?: string[]
  /** Before a write: records the text about to be saved (versions.snapshot). */
  snapshot?(ref: FileRef, text: string, label: 'saved'): void
  onChange?(folders: WatchedFolder[]): void
  /** A file changed inside a folder (null: something changed, rescan). */
  onFiles?(folderId: string, path: string | null): void
  /** Watch folders for changes; off in tests. */
  watch?: boolean
}

export class FolderStore {
  readonly #db: DatabaseSync
  readonly #options: FolderStoreOptions
  readonly #now: () => number
  readonly #watchers = new Map<string, FSWatcher>()

  constructor(options: FolderStoreOptions) {
    this.#options = options
    this.#db = options.db
    this.#now = options.now ?? Date.now
    migrate(this.#db, 'folders', FOLDER_STEPS)
    if (options.watch) for (const f of this.list()) this.#watch(f)
  }

  list(): WatchedFolder[] {
    return (this.#db.prepare('SELECT * FROM folders ORDER BY added_at').all() as unknown as Row[]).map(toFolder)
  }

  get(id: string): WatchedFolder {
    const row = this.#db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error(`${BRAND_NAME} no longer has access to that folder.`)
    return toFolder(row)
  }

  grant(input: { path: string; mode: WatchedFolder['mode']; scope: WatchedFolder['scope']; companionId?: string | null }): WatchedFolder {
    let real: string
    try {
      real = realpathSync(input.path)
    } catch {
      throw new Error('That folder can’t be found.')
    }
    if (!statSync(real).isDirectory()) throw new Error('Choose a folder, not a file.')
    if (parse(real).root === real) throw new Error('Choose a folder inside your disk, not the whole disk.')
    for (const blocked of this.#options.blocked ?? []) {
      const b = existsSync(blocked) ? realpathSync(blocked) : resolve(blocked)
      if (real === b || real.startsWith(b + sep) || b.startsWith(real + sep)) throw new Error(`${BRAND_NAME} keeps its own data there, so that folder can’t be shared.`)
    }
    const companionId = input.companionId ?? null
    const scope = JSON.stringify(input.scope)
    const same = (this.#db.prepare('SELECT * FROM folders WHERE path = ? AND scope = ? AND companion_id IS ?').get(real, scope, companionId) as Row | undefined) ?? null
    if (same) {
      this.#db.prepare('UPDATE folders SET mode = ? WHERE id = ?').run(input.mode, same.id)
      this.#changed()
      return this.get(same.id)
    }
    const id = randomUUID()
    this.#db.prepare('INSERT INTO folders (id, path, name, mode, scope, companion_id, added_at, file_count) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(id, real, basename(real) || real, input.mode, scope, companionId, this.#now())
    const folder = this.get(id)
    if (this.#options.watch) this.#watch(folder)
    this.#changed()
    void this.recount(id)
    return folder
  }

  update(id: string, patch: { mode?: WatchedFolder['mode']; scope?: WatchedFolder['scope'] }): WatchedFolder {
    const folder = this.get(id)
    this.#db.prepare('UPDATE folders SET mode = ?, scope = ? WHERE id = ?').run(patch.mode ?? folder.mode, JSON.stringify(patch.scope ?? folder.scope), id)
    this.#changed()
    return this.get(id)
  }

  revoke(id: string): void {
    this.get(id)
    this.#watchers.get(id)?.close()
    this.#watchers.delete(id)
    this.#db.prepare('DELETE FROM folders WHERE id = ?').run(id)
    this.#changed()
  }

  /** Removes the grants made for one chat (the chat was deleted). */
  revokeChat(chatId: string): void {
    for (const f of this.list()) if (typeof f.scope === 'object' && f.scope.chatId === chatId) this.revoke(f.id)
  }

  /** Folders a chat may use: for all chats or this one, and for its companion or any. */
  accessible(chatId: string | null, companionId: string | null): WatchedFolder[] {
    return this.list().filter((f) => (f.scope === 'all-chats' || (chatId !== null && f.scope.chatId === chatId)) && (f.companionId === null || f.companionId === companionId))
  }

  /** The absolute path of `rel` inside folder `id`, confined. */
  resolve(id: string, rel: string): string {
    const folder = this.get(id)
    if (!existsSync(folder.path)) throw new Error(`“${folder.name}” can’t be found. It may have been moved or renamed.`)
    return confine(folder.path, rel)
  }

  /** The grant an absolute path is inside, or null. */
  folderFor(absolutePath: string): WatchedFolder | null {
    let real: string
    try {
      real = realpathSync(absolutePath)
    } catch {
      return null
    }
    return this.list().find((f) => real === f.path || real.startsWith(f.path + sep)) ?? null
  }

  /** One folder level: folders first, then by name. Hidden entries are left out. */
  entries(id: string, sub: string): FolderEntry[] {
    const dir = this.resolve(id, sub)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('That folder no longer exists.')
    const root = realpathSync(this.get(id).path)
    const out: FolderEntry[] = []
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || SKIPPED_DIRS.has(name)) continue
      const full = join(dir, name)
      let info
      try {
        // Symlinks are followed only when they stay inside the folder.
        info = statSync(confine(root, toPosix(relative(root, full))))
      } catch {
        continue
      }
      const folder = info.isDirectory()
      if (!folder && !info.isFile()) continue
      out.push({ path: toPosix(relative(root, full)), name, kind: folder ? 'folder' : 'file', size: folder ? 0 : info.size, modifiedAt: info.mtimeMs, readable: !folder && (isTextFileName(name) || VIEWABLE.test(name)) })
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'folder' ? -1 : 1))
  }

  /** A text file's content, up to `maxBytes`; binaries and other types are refused. */
  readText(id: string, path: string, maxBytes = TEXT_FILE_MAX_BYTES): string {
    const file = this.resolve(id, path)
    let info
    try {
      info = statSync(file)
    } catch {
      throw new Error('That file no longer exists.')
    }
    if (!info.isFile()) throw new Error('That is a folder, not a file.')
    if (!isTextFileName(file)) throw new Error(`${BRAND_NAME} can only read text files here.`)
    if (info.size > maxBytes) throw new Error(`That file is too large to read (over ${Math.round(maxBytes / 1024 / 1024)} MB).`)
    const data = readFileSync(file)
    if (looksBinary(data)) throw new Error('That file isn’t text.')
    return data.toString('utf8')
  }

  /** The raw bytes of a file inside a grant (version history reads them). */
  readBytes(id: string, path: string): Buffer | null {
    try {
      const file = this.resolve(id, path)
      return statSync(file).isFile() ? readFileSync(file) : null
    } catch {
      return null
    }
  }

  /**
   * Writes a text file inside a read-and-edit grant: text types only, up to
   * WRITE_FILE_MAX_BYTES, and a version is recorded first.
   */
  writeText(id: string, path: string, text: string): { created: boolean; path: string } {
    const folder = this.get(id)
    if (folder.mode !== 'read-write') throw new Error(`${BRAND_NAME} can only read “${folder.name}”. Give read and edit access to change files there.`)
    const file = this.resolve(id, path)
    const rel = toPosix(relative(realpathSync(folder.path), file))
    if (!rel) throw new Error('Name a file to write.')
    if (!isTextFileName(file)) throw new Error(`${BRAND_NAME} only writes text files.`)
    if (Buffer.byteLength(text, 'utf8') > WRITE_FILE_MAX_BYTES) throw new Error('That is too much text for one file write (1 MB at most).')
    const created = !existsSync(file)
    if (!created) {
      if (!statSync(file).isFile()) throw new Error('That is a folder, not a file.')
      if (looksBinary(readFileSync(file))) throw new Error(`That file isn’t text, so ${BRAND_NAME} won’t overwrite it.`)
    }
    this.#options.snapshot?.({ kind: 'folder', folderId: id, path: rel }, text, 'saved')
    writeAtomic(file, text)
    this.#options.onFiles?.(id, rel)
    return { created, path: rel }
  }

  /** Writes bytes back in place (restoring a version); still needs a read-and-edit grant. */
  writeBytes(id: string, path: string, data: Buffer): void {
    const folder = this.get(id)
    if (folder.mode !== 'read-write') throw new Error(`${BRAND_NAME} can only read “${folder.name}”.`)
    writeAtomic(this.resolve(id, path), data)
    this.#options.onFiles?.(id, path)
  }

  /** Every file in a folder (hidden ones and node_modules skipped), up to `max`; symlinks are not followed. */
  async files(id: string, max = FOLDER_INDEX_MAX_FILES): Promise<FolderFile[]> {
    const folder = this.get(id)
    const root = folder.path
    const out: FolderFile[] = []
    const walk = async (dir: string): Promise<void> => {
      let names
      try {
        names = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of names) {
        if (out.length >= max) return
        if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) {
          try {
            const info = await stat(full)
            out.push({ path: toPosix(relative(root, full)), size: info.size, modifiedAt: info.mtimeMs })
          } catch {
            // Gone while walking.
          }
        }
      }
    }
    if (existsSync(root)) await walk(root)
    return out
  }

  /** Counts a folder's files in the background (up to the index cap) and saves the count. */
  async recount(id: string): Promise<number | null> {
    try {
      const count = (await this.files(id)).length
      this.#db.prepare('UPDATE folders SET file_count = ? WHERE id = ?').run(count, id)
      this.#changed()
      return count
    } catch {
      return null
    }
  }

  dispose(): void {
    for (const w of this.#watchers.values()) w.close()
    this.#watchers.clear()
  }

  #watch(folder: WatchedFolder): void {
    if (this.#watchers.has(folder.id) || !existsSync(folder.path)) return
    try {
      const watcher = watch(folder.path, { recursive: true, persistent: false }, (_event, name) => {
        const rel = typeof name === 'string' ? toPosix(name) : null
        if (rel && rel.split('/').some((p) => p.startsWith('.') || SKIPPED_DIRS.has(p))) return
        this.#options.onFiles?.(folder.id, rel)
      })
      // An unwatchable volume (network, removed disk) just isn't kept fresh.
      watcher.on('error', () => {
        watcher.close()
        this.#watchers.delete(folder.id)
      })
      this.#watchers.set(folder.id, watcher)
    } catch {
      // Same: degrade to no live updates.
    }
  }

  #changed(): void {
    this.#options.onChange?.(this.list())
  }
}
