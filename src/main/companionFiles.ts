/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { CompanionFileEntry } from '@shared/services'

// Each companion's own folder of files (the card's Files tab), under
// userData/companion-files/<companion id>/. Paths from the chrome are
// relative, '/'-separated, and confined to the folder, including through
// symlinks. Files are added one at a time from a drop; folders can't be.

export const FOLDER_FILE_MAX_BYTES = 25 * 1024 * 1024
const OWNER_ID = /^[A-Za-z0-9-]{1,64}$/
const NAME_MAX = 120

/** Types Atelier can read as text or show as an image or PDF. Other files are listed but view-only. */
const READABLE = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm', '.log', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp'])

export function isReadableFile(name: string): boolean {
  return READABLE.has(extname(name).toLowerCase())
}

/** A file name safe to create: no separators or control characters, not hidden, not too long. */
export function cleanFileName(name: string): string {
  // Path parts like '..' are dropped rather than kept as text.
  const parts = name
    .split(/[\\/:]+/)
    // eslint-disable-next-line no-control-regex
    .map((part) => part.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim())
    .filter((part) => part && part !== '.' && part !== '..')
  const cleaned = parts.join(' ').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '')
  if (!cleaned) throw new Error('That file name can’t be used.')
  if (cleaned.length <= NAME_MAX) return cleaned
  const ext = extname(cleaned).slice(0, 12)
  return `${cleaned.slice(0, NAME_MAX - ext.length).trimEnd()}${ext}`
}

/** `name`, or "name 2.ext", "name 3.ext"… when the folder already has it. */
export function uniqueFileName(name: string, taken: ReadonlySet<string>): string {
  const lower = new Set([...taken].map((t) => t.toLowerCase()))
  if (!lower.has(name.toLowerCase())) return name
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}${ext}`
    if (!lower.has(candidate.toLowerCase())) return candidate
  }
}

export interface CompanionFilesOptions {
  /** Moves a path to the Trash; without it, deletes it. */
  trash?: (path: string) => Promise<void>
}

// 'changed' carries the path that changed ('' for the whole folder).
export class CompanionFiles extends EventEmitter<{ changed: [companionId: string, path: string] }> {
  readonly #root: string
  readonly #trash: ((path: string) => Promise<void>) | undefined
  /** When set, deletes go to Atelier's Recently Deleted instead of the system Trash. */
  #recycle: ((companionId: string, path: string) => void) | null = null

  constructor(dataDir: string, options: CompanionFilesOptions = {}) {
    super()
    this.#root = join(dataDir, 'companion-files')
    this.#trash = options.trash
  }

  /** The companion's folder (it may not exist yet). */
  folderFor(companionId: string): string {
    if (!OWNER_ID.test(companionId)) throw new Error('Unknown companion.')
    return join(this.#root, companionId)
  }

  /** Maps a relative path to an absolute one inside the companion's folder, or throws. '' is the folder itself. */
  resolve(companionId: string, path: string): string {
    const base = resolve(this.folderFor(companionId))
    if (path.includes('\0') || path.split(/[\\/]/).includes('..') || /^[\\/]/.test(path)) throw new Error('Invalid file path.')
    const target = resolve(base, path)
    if (target !== base && !target.startsWith(base + sep)) throw new Error('Invalid file path.')
    // A symlink in an existing parent must not lead out of the folder.
    let existing = target
    while (!existsSync(existing) && existing !== base) existing = dirname(existing)
    if (existsSync(base)) {
      const real = realpathSync(existing)
      const realBase = realpathSync(base)
      if (real !== realBase && !real.startsWith(realBase + sep)) throw new Error('Invalid file path.')
    }
    return target
  }

  /** One folder's entries, folders first, then by name. A missing folder is empty. */
  list(companionId: string, folder = ''): CompanionFileEntry[] {
    const dir = this.resolve(companionId, folder)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
    const base = resolve(this.folderFor(companionId))
    const entries: CompanionFileEntry[] = []
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.')) continue
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      const isFolder = stat.isDirectory()
      if (!isFolder && !stat.isFile()) continue
      entries.push({
        path: relative(base, full).split(sep).join('/'),
        name,
        kind: isFolder ? 'folder' : 'file',
        size: isFolder ? 0 : stat.size,
        modifiedAt: stat.mtimeMs,
        readable: !isFolder && isReadableFile(name),
      })
    }
    return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1))
  }

  /** Saves a dropped file into `folder`; a name already there gets a number. */
  add(companionId: string, folder: string, name: string, data: Buffer): CompanionFileEntry {
    if (data.byteLength > FOLDER_FILE_MAX_BYTES) throw new Error('Files are limited to 25 MB.')
    const dir = this.resolve(companionId, folder)
    if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error('That folder no longer exists.')
    mkdirSync(dir, { recursive: true })
    const taken = new Set(readdirSync(dir))
    const finalName = uniqueFileName(cleanFileName(name), taken)
    const target = this.resolve(companionId, folder ? `${folder}/${finalName}` : finalName)
    writeFileSync(target, data, { flag: 'wx' })
    this.emit('changed', companionId, folder ? `${folder}/${finalName}` : finalName)
    const entry = this.list(companionId, folder).find((e) => e.name === finalName)
    if (!entry) throw new Error('The file could not be saved.')
    return entry
  }

  /**
   * Moves a file or subfolder to Recently Deleted or, without it, to
   * the Trash (or deletes it). The folder itself can't be removed this way.
   */
  async remove(companionId: string, path: string): Promise<void> {
    const target = this.resolve(companionId, path)
    if (target === resolve(this.folderFor(companionId))) throw new Error('Choose a file to delete.')
    if (!existsSync(target)) throw new Error('That file no longer exists.')
    if (this.#recycle) this.#recycle(companionId, path)
    else await this.#discard(target)
    this.emit('changed', companionId, path)
  }

  /** Routes deletes to Recently Deleted (the workspace calls this at start-up); null goes back to the Trash. */
  useRecentlyDeleted(recycle: ((companionId: string, path: string) => void) | null): void {
    this.#recycle = recycle
  }

  /** Copies a companion's folder to another (duplicate). Nothing happens when there is none. */
  copyOwner(fromId: string, toId: string): void {
    const from = this.folderFor(fromId)
    if (!existsSync(from)) return
    cpSync(from, this.folderFor(toId), { recursive: true, errorOnExist: false, force: false })
    this.emit('changed', toId, '')
  }

  /** Removes a deleted companion's folder (to the Trash when possible). */
  async removeOwner(companionId: string): Promise<void> {
    const folder = this.folderFor(companionId)
    if (!existsSync(folder)) return
    await this.#discard(folder)
    this.emit('changed', companionId, '')
  }

  async #discard(path: string): Promise<void> {
    if (this.#trash) {
      try {
        await this.#trash(path)
        return
      } catch {
        // Fall through and delete it.
      }
    }
    rmSync(path, { recursive: true, force: true })
  }
}
