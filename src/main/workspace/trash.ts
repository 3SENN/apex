/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Recently Deleted (OV-32). A delete that should be undoable
// calls trash.put(kind, id): the kind's adapter describes the item (a JSON
// payload plus the files to keep), the files move into userData/trash/<item>,
// and the item stays restorable for 30 days. Restore hands the payload and
// the kept files back to the adapter, which puts them back (a name clash
// gets a suffix). Chats are never here: they keep their own deletes (CH-48).
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { TRASH_RETENTION_DAYS, type TrashItem, type TrashKind } from '@shared/workspace'
import { migrate, type DatabaseSync } from '../db'
import { movePath, pathSize } from './fsutil'

const DAY_MS = 86_400_000

export interface TrashAdapter {
  kind: TrashKind
  title(id: string): string
  /** What restoring needs: a JSON payload plus files to move into the trash folder. */
  snapshot(id: string): { payload: unknown; files?: string[] }
  /** Puts it back; returns the restored title (a clash gets a suffix). */
  restore(payload: unknown, files: string[]): string
  purge?(payload: unknown): void
}

export const TRASH_STEPS = [
  `CREATE TABLE trash (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    size INTEGER,
    payload TEXT NOT NULL,
    files TEXT NOT NULL
  );
  CREATE INDEX trash_by_time ON trash (deleted_at);`,
]

interface Row {
  id: string
  kind: TrashKind
  title: string
  deleted_at: number
  expires_at: number
  size: number | null
  payload: string
  files: string
}

const toItem = (r: Row): TrashItem => ({ id: r.id, kind: r.kind, title: r.title, deletedAt: r.deleted_at, expiresAt: r.expires_at, size: r.size })

export interface TrashStoreOptions {
  db: DatabaseSync
  /** userData/trash */
  dir: string
  adapter(kind: TrashKind): TrashAdapter | undefined
  now?: () => number
  onChange?(count: number): void
}

export class TrashStore {
  readonly #db: DatabaseSync
  readonly #options: TrashStoreOptions
  readonly #now: () => number

  constructor(options: TrashStoreOptions) {
    this.#options = options
    this.#db = options.db
    this.#now = options.now ?? Date.now
    migrate(this.#db, 'trash', TRASH_STEPS)
    mkdirSync(options.dir, { recursive: true })
  }

  /** Moves an item into Recently Deleted. The caller removes its own record afterwards. */
  put(kind: TrashKind, id: string): TrashItem {
    const adapter = this.#adapter(kind)
    const title = adapter.title(id)
    const { payload, files = [] } = adapter.snapshot(id)
    const itemId = randomUUID()
    const folder = join(this.#options.dir, itemId)
    const stored: string[] = []
    const moved: Array<[string, string]> = []
    try {
      files.forEach((file, i) => {
        const name = `${i}-${basename(file)}`
        const to = join(folder, name)
        movePath(file, to)
        moved.push([file, to])
        stored.push(name)
      })
    } catch (err) {
      // Put back whatever already moved, so a failed delete changes nothing.
      for (const [from, to] of moved.reverse()) {
        try {
          movePath(to, from)
        } catch {
          // Leave it in the trash folder rather than lose it.
        }
      }
      throw err
    }
    const size = stored.length > 0 ? pathSize(folder) : null
    const now = this.#now()
    const row: Row = { id: itemId, kind, title, deleted_at: now, expires_at: now + TRASH_RETENTION_DAYS * DAY_MS, size, payload: JSON.stringify(payload ?? null), files: JSON.stringify(stored) }
    this.#db
      .prepare('INSERT INTO trash (id, kind, title, deleted_at, expires_at, size, payload, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.kind, row.title, row.deleted_at, row.expires_at, row.size, row.payload, row.files)
    this.#changed()
    return toItem(row)
  }

  /** Newest first; `query` matches titles, ignoring case. */
  list(q: { kind?: TrashKind; query?: string } = {}): TrashItem[] {
    const rows = this.#db.prepare('SELECT * FROM trash ORDER BY deleted_at DESC, rowid DESC').all() as unknown as Row[]
    const query = q.query?.trim().toLowerCase() ?? ''
    return rows.filter((r) => (!q.kind || r.kind === q.kind) && (!query || r.title.toLowerCase().includes(query))).map(toItem)
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM trash').get() as { n: number }).n
  }

  /** Restores each item; `renamed` lists the titles that changed to avoid a clash. */
  restore(ids: string[]): { restored: number; renamed: string[] } {
    let restored = 0
    const renamed: string[] = []
    let failure: Error | null = null
    for (const id of ids) {
      const row = this.#row(id)
      if (!row) continue
      try {
        const adapter = this.#adapter(row.kind)
        const folder = join(this.#options.dir, row.id)
        const files = (JSON.parse(row.files) as string[]).map((name) => join(folder, name))
        const missing = files.find((f) => !existsSync(f))
        if (missing) throw new Error(`“${row.title}” can’t be restored: its saved copy is missing.`)
        const title = adapter.restore(JSON.parse(row.payload), files)
        if (title !== row.title) renamed.push(title)
        this.#db.prepare('DELETE FROM trash WHERE id = ?').run(row.id)
        rmSync(folder, { recursive: true, force: true })
        restored++
      } catch (err) {
        failure ??= err instanceof Error ? err : new Error(String(err))
      }
    }
    if (restored > 0 || failure) this.#changed()
    if (failure && restored === 0) throw failure
    return { restored, renamed }
  }

  /** Deletes items for good; returns how many went. */
  purge(ids: string[]): number {
    let purged = 0
    for (const id of ids) {
      const row = this.#row(id)
      if (!row) continue
      try {
        this.#options.adapter(row.kind)?.purge?.(JSON.parse(row.payload))
      } catch {
        // The adapter's own clean-up is best effort; the item still goes.
      }
      rmSync(join(this.#options.dir, row.id), { recursive: true, force: true })
      this.#db.prepare('DELETE FROM trash WHERE id = ?').run(row.id)
      purged++
    }
    if (purged > 0) this.#changed()
    return purged
  }

  empty(): number {
    return this.purge(this.list().map((i) => i.id))
  }

  /** The daily clean-up: items past their 30 days. */
  purgeExpired(): number {
    const rows = this.#db.prepare('SELECT id FROM trash WHERE expires_at <= ?').all(this.#now()) as Array<{ id: string }>
    return this.purge(rows.map((r) => r.id))
  }

  /** Bytes kept, for Settings › Storage. */
  size(): number {
    return (this.#db.prepare('SELECT SUM(size) AS n FROM trash').get() as { n: number | null }).n ?? 0
  }

  #row(id: string): Row | undefined {
    return this.#db.prepare('SELECT * FROM trash WHERE id = ?').get(id) as Row | undefined
  }

  #adapter(kind: TrashKind): TrashAdapter {
    const adapter = this.#options.adapter(kind)
    if (!adapter) throw new Error('Recently Deleted can’t handle this kind of item yet.')
    return adapter
  }

  #changed(): void {
    this.#options.onChange?.(this.count())
  }
}
