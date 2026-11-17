/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Version history (OV-33). Every Apex-initiated write, delete, move and
// restore of a text file records a version here first, so an earlier save
// can be previewed and restored from the viewer. Metadata lives in
// workspace.sqlite; contents live under userData/versions/<file>/<content
// hash>, shared by versions with the same text. Each file keeps its last 50
// versions within 30 days (the newest always stays).
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { VERSION_LIMITS, fileRefKey, type FileRef, type FileVersion } from '@shared/workspace'
import { migrate, type DatabaseSync } from '../db'
import { writeAtomic } from './fsutil'

/** Larger files are not versioned (they are rarely text Apex edits). */
export const VERSION_MAX_BYTES = 5 * 1024 * 1024
const DAY_MS = 86_400_000

/** How a file kind is read and written live: restore writes through it, and `current` compares against it. */
export interface VersionTarget {
  /** The file's current content, or null when it is missing or unreadable. */
  read(ref: FileRef): Buffer | null
  /** Writes restored content in place. Kinds without a writer can be previewed but not restored. */
  write?(ref: FileRef, data: Buffer): void
}

export const VERSION_STEPS = [
  `CREATE TABLE versions (
    id TEXT PRIMARY KEY,
    ref_key TEXT NOT NULL,
    ref TEXT NOT NULL,
    at INTEGER NOT NULL,
    label TEXT NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX versions_by_file ON versions (ref_key, at);`,
]

interface Row {
  id: string
  ref_key: string
  at: number
  label: FileVersion['label']
  size: number
  hash: string
}

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

export interface VersionStoreOptions {
  db: DatabaseSync
  /** userData/versions */
  dir: string
  target(kind: FileRef['kind']): VersionTarget | undefined
  now?: () => number
  onChange?(ref: FileRef): void
}

export class VersionStore {
  readonly #db: DatabaseSync
  readonly #dir: string
  readonly #options: VersionStoreOptions
  readonly #now: () => number

  constructor(options: VersionStoreOptions) {
    this.#options = options
    this.#db = options.db
    this.#dir = options.dir
    this.#now = options.now ?? Date.now
    migrate(this.#db, 'versions', VERSION_STEPS)
  }

  /**
   * Records `data` as a version of `ref`. Call it before every write (with
   * the text about to be saved), and before a delete or move (with the text
   * the file held). When the live file holds text no version has yet, that
   * text is kept first, so nothing a write replaces is ever lost.
   */
  snapshot(ref: FileRef, data: string | Buffer, label: FileVersion['label']): void {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    if (buf.byteLength > VERSION_MAX_BYTES) return
    const hash = sha(buf)
    const key = fileRefKey(ref)
    let newest = this.#rows(key)[0]
    const now = this.#now()
    if (label === 'saved' || label === 'restored') {
      const live = this.#live(ref)
      if (live && live.byteLength <= VERSION_MAX_BYTES) {
        const liveHash = sha(live)
        if (liveHash !== hash && liveHash !== newest?.hash) {
          this.#insert(ref, key, live, liveHash, 'saved', now - 1)
          newest = this.#rows(key)[0]
        }
      }
    }
    // A save of unchanged text is not a new version.
    if (label === 'saved' && newest?.hash === hash) return
    this.#insert(ref, key, buf, hash, label, now)
    this.#prune(key)
    this.#options.onChange?.(ref)
  }

  /** Newest first; the version whose text the file holds now is marked current. */
  list(ref: FileRef): FileVersion[] {
    const rows = this.#rows(fileRefKey(ref))
    if (rows.length === 0) return []
    const live = this.#options.target(ref.kind) ? this.#live(ref) : undefined
    let currentId: string | null = null
    if (live === undefined) currentId = rows[0]?.label === 'deleted' ? null : (rows[0]?.id ?? null)
    else if (live !== null) currentId = rows.find((r) => r.hash === sha(live))?.id ?? null
    return rows.map((r) => ({ id: r.id, at: r.at, label: r.label, size: r.size, current: r.id === currentId }))
  }

  read(ref: FileRef, versionId: string): string {
    return this.#blob(ref, versionId).toString('utf8')
  }

  /** Writes an earlier version back in place and records it as 'restored'. */
  restore(ref: FileRef, versionId: string): FileVersion {
    const target = this.#options.target(ref.kind)
    if (!target?.write) throw new Error('This file can’t be restored from here.')
    const data = this.#blob(ref, versionId)
    this.snapshot(ref, data, 'restored')
    target.write(ref, data)
    const version = this.list(ref)[0]
    if (!version) throw new Error('The version could not be restored.')
    return version
  }

  /** Drops every version of a file (its trash entry was purged). */
  forget(ref: FileRef): void {
    const key = fileRefKey(ref)
    this.#db.prepare('DELETE FROM versions WHERE ref_key = ?').run(key)
    rmSync(this.#folder(key), { recursive: true, force: true })
  }

  /** Total bytes kept, for Settings › Storage. */
  size(): number {
    const row = this.#db.prepare('SELECT SUM(size) AS n FROM (SELECT DISTINCT ref_key, hash, size FROM versions)').get() as { n: number | null } | undefined
    return row?.n ?? 0
  }

  #live(ref: FileRef): Buffer | null {
    try {
      return this.#options.target(ref.kind)?.read(ref) ?? null
    } catch {
      return null
    }
  }

  #rows(key: string): Row[] {
    return this.#db.prepare('SELECT id, ref_key, at, label, size, hash FROM versions WHERE ref_key = ? ORDER BY at DESC, rowid DESC').all(key) as unknown as Row[]
  }

  #insert(ref: FileRef, key: string, data: Buffer, hash: string, label: FileVersion['label'], at: number): void {
    const folder = this.#folder(key)
    const file = join(folder, hash)
    if (!existsSync(file)) {
      mkdirSync(folder, { recursive: true })
      writeAtomic(file, data)
    }
    this.#db.prepare('INSERT INTO versions (id, ref_key, ref, at, label, size, hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), key, JSON.stringify(ref), at, label, data.byteLength, hash)
  }

  #blob(ref: FileRef, versionId: string): Buffer {
    const key = fileRefKey(ref)
    const row = this.#db.prepare('SELECT hash FROM versions WHERE id = ? AND ref_key = ?').get(versionId, key) as { hash: string } | undefined
    if (!row) throw new Error('That version no longer exists.')
    try {
      return readFileSync(join(this.#folder(key), row.hash))
    } catch {
      throw new Error('That version could not be read.')
    }
  }

  #prune(key: string): void {
    const rows = this.#rows(key)
    const cutoff = this.#now() - VERSION_LIMITS.days * DAY_MS
    const drop = rows.filter((r, i) => i > 0 && (i >= VERSION_LIMITS.count || r.at < cutoff))
    if (drop.length === 0) return
    const del = this.#db.prepare('DELETE FROM versions WHERE id = ?')
    for (const r of drop) del.run(r.id)
    const kept = new Set(rows.filter((r) => !drop.includes(r)).map((r) => r.hash))
    for (const r of drop) if (!kept.has(r.hash)) rmSync(join(this.#folder(key), r.hash), { force: true })
  }

  #folder(key: string): string {
    const id = sha(key)
    return join(this.#dir, id.slice(0, 2), id)
  }
}
