/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// One profile's activity memory on disk: settings.json,
// state.json and activity.sqlite under <profile dataDir>/activity/.
// Visits, captured page text, thumbnails (small JPEG blobs) and the hourly
// notes are rows of one table, so clearing, retention and the inspector
// work the same for every kind. Nothing here leaves the device.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeActivitySettings, type ActivityItem, type ActivityItemKind, type ActivitySettings } from '@shared/activity'
import { migrate, openDb, transaction, type DatabaseSync } from '../db'
import { writeAtomic } from '../settings'
import { readJson } from '../stores'

const STEPS = [
  `CREATE TABLE items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    url TEXT,
    title TEXT NOT NULL DEFAULT '',
    text TEXT,
    media BLOB,
    dwell_ms INTEGER
  );
  CREATE INDEX items_by_time ON items (at);
  CREATE INDEX items_by_kind ON items (kind, at);`,
]

/** The inspector and the tool see at most this much of one capture's text. */
export const ITEM_TEXT_PREVIEW = 2_000
/** How much of one capture the hourly notes and the search tool read. */
export const CAPTURE_EXCERPT = 4_000

interface Row {
  id: string
  kind: ActivityItemKind
  at: number
  url: string | null
  title: string
  text: string | null
  media: Uint8Array | null
}

/** Internal bookkeeping that is not a setting: how far hourly notes and cleanup got. */
export interface ActivityState {
  notesThrough: number | null
  lastCleanup: number | null
  /** CH-21: chats whose + menu switch turned activity memory off, oldest first. */
  excludedChats: string[]
}

/** How many per-chat choices are kept; the oldest drop first. */
export const EXCLUDED_CHATS_MAX = 2_000

export interface ItemQuery {
  from?: number
  to?: number
  query?: string
  kind?: ActivityItemKind
  offset?: number
  limit?: number
}

/** `%` and `_` match themselves in a LIKE pattern. */
function likePattern(word: string): string {
  return `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

function toItem(row: Row, textMax = ITEM_TEXT_PREVIEW): ActivityItem {
  return {
    id: row.id,
    kind: row.kind,
    at: row.at,
    url: row.url,
    title: row.title,
    text: row.text === null ? null : row.text.slice(0, textMax),
    media: row.media ? `data:image/jpeg;base64,${Buffer.from(row.media).toString('base64')}` : null,
  }
}

export class ActivityStore {
  readonly dir: string
  #db: DatabaseSync | null = null
  #settings: ActivitySettings | null = null

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  // ── settings and state ──

  settings(): ActivitySettings {
    this.#settings ??= normalizeActivitySettings(readJson(join(this.dir, 'settings.json')))
    return this.#settings
  }

  saveSettings(next: ActivitySettings): ActivitySettings {
    const clean = normalizeActivitySettings(next)
    writeAtomic(join(this.dir, 'settings.json'), JSON.stringify(clean, null, 2))
    this.#settings = clean
    return clean
  }

  state(): ActivityState {
    const raw = readJson(join(this.dir, 'state.json')) as Partial<ActivityState> | undefined
    const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const chats = Array.isArray(raw?.excludedChats) ? raw.excludedChats.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128) : []
    return { notesThrough: time(raw?.notesThrough), lastCleanup: time(raw?.lastCleanup), excludedChats: chats.slice(-EXCLUDED_CHATS_MAX) }
  }

  saveState(patch: Partial<ActivityState>): void {
    writeAtomic(join(this.dir, 'state.json'), JSON.stringify({ ...this.state(), ...patch }))
  }

  // ── items ──

  #open(): DatabaseSync {
    if (!this.#db) {
      const db = openDb(join(this.dir, 'activity.sqlite'))
      migrate(db, 'activity', STEPS)
      this.#db = db
    }
    return this.#db
  }

  #insert(kind: ActivityItemKind, at: number, url: string | null, title: string, text: string | null, media: Buffer | null): string {
    const id = randomUUID()
    this.#open()
      .prepare('INSERT INTO items (id, kind, at, url, title, text, media) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, kind, at, url, title.slice(0, 500), text, media)
    return id
  }

  addVisit(v: { url: string; title: string; at: number }): string {
    return this.#insert('visit', v.at, v.url, v.title, null, null)
  }

  setDwell(id: string, dwellMs: number): void {
    this.#open().prepare('UPDATE items SET dwell_ms = ? WHERE id = ?').run(Math.max(0, Math.round(dwellMs)), id)
  }

  /** Fills in a title that arrived after the visit was recorded. */
  setTitle(id: string, title: string): void {
    if (title) this.#open().prepare('UPDATE items SET title = ? WHERE id = ?').run(title.slice(0, 500), id)
  }

  addCapture(c: { url: string; title: string; at: number; text: string }): string {
    return this.#insert('capture', c.at, c.url, c.title, c.text, null)
  }

  addScreenshot(s: { url: string; title: string; at: number; jpeg: Buffer }): string {
    return this.#insert('screenshot', s.at, s.url, s.title, null, s.jpeg)
  }

  addNote(n: { at: number; title: string; text: string }): string {
    return this.#insert('note', n.at, null, n.title, n.text, null)
  }

  #where(q: ItemQuery): { sql: string; args: Array<string | number> } {
    const parts: string[] = []
    const args: Array<string | number> = []
    if (q.from !== undefined) {
      parts.push('at >= ?')
      args.push(q.from)
    }
    if (q.to !== undefined) {
      parts.push('at <= ?')
      args.push(q.to)
    }
    if (q.kind) {
      parts.push('kind = ?')
      args.push(q.kind)
    }
    for (const word of (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      parts.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(coalesce(url, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(text, '')) LIKE ? ESCAPE '\\')")
      const p = likePattern(word)
      args.push(p, p, p)
    }
    return { sql: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', args }
  }

  /** Newest first, a page at a time. */
  items(q: ItemQuery = {}, textMax = ITEM_TEXT_PREVIEW): { items: ActivityItem[]; total: number } {
    const db = this.#open()
    const { sql, args } = this.#where(q)
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM items ${sql}`).get(...args) as { n: number }).n
    const limit = Math.min(Math.max(1, q.limit ?? 100), 1000)
    const rows = db.prepare(`SELECT id, kind, at, url, title, text, media FROM items ${sql} ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...args, limit, Math.max(0, q.offset ?? 0)) as unknown as Row[]
    return { items: rows.map((r) => toItem(r, textMax)), total }
  }

  /** Oldest first, for the hourly notes: what was captured in (from, to]. */
  between(from: number, to: number, kinds: ActivityItemKind[]): ActivityItem[] {
    const marks = kinds.map(() => '?').join(', ')
    const rows = this.#open()
      .prepare(`SELECT id, kind, at, url, title, text, NULL AS media FROM items WHERE at > ? AND at <= ? AND kind IN (${marks}) ORDER BY at ASC LIMIT 2000`)
      .all(from, to, ...kinds) as unknown as Row[]
    return rows.map((r) => toItem(r, CAPTURE_EXCERPT))
  }

  remove(ids: readonly string[]): number {
    const db = this.#open()
    const statement = db.prepare('DELETE FROM items WHERE id = ?')
    return transaction(db, () => ids.reduce((n, id) => n + Number(statement.run(id).changes), 0))
  }

  /** Deletes every item from `from` (null: the beginning) through `to`; returns how many. */
  clear(from: number | null, to: number): number {
    const db = this.#open()
    const result = from === null ? db.prepare('DELETE FROM items WHERE at <= ?').run(to) : db.prepare('DELETE FROM items WHERE at >= ? AND at <= ?').run(from, to)
    return Number(result.changes)
  }

  /** Applies retention: each kind older than its cutoff goes. Returns how many were deleted. */
  cleanup(cutoffs: Record<ActivityItemKind, number | null>): number {
    const db = this.#open()
    const statement = db.prepare('DELETE FROM items WHERE kind = ? AND at < ?')
    return transaction(db, () => {
      let deleted = 0
      for (const [kind, cutoff] of Object.entries(cutoffs)) if (cutoff !== null) deleted += Number(statement.run(kind, cutoff).changes)
      return deleted
    })
  }

  /** Bytes on disk, for Settings › Your data. */
  size(): number {
    try {
      const db = this.#open()
      const row = db.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get() as { bytes: number } | undefined
      return row?.bytes ?? 0
    } catch {
      return 0
    }
  }

  close(): void {
    this.#db?.close()
    this.#db = null
  }
}
