/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Search everything: one SQLite FTS5 index over chats,
// memory, history, bookmarks and files, in userData/search.sqlite. The index
// is disposable: rebuild() empties it and the indexer fills it again. Rows
// for history and bookmarks carry the profile they belong to, and a query
// sees only its own profile's rows plus the app-wide ones. Ranking is bm25
// (titles weigh four times the body) with extra weight for recent items.
import { HIT_CLOSE, HIT_OPEN, SEARCH_SOURCES, type FileRef, type SearchHit, type SearchSource } from '@shared/workspace'
import { migrate, transaction, type DatabaseSync } from '../db'

export const SEARCH_STEPS = [
  `CREATE TABLE docs (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT,
    ref TEXT,
    at INTEGER NOT NULL,
    profile TEXT,
    stamp TEXT NOT NULL
  );
  CREATE INDEX docs_by_source ON docs (source);
  CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, tokenize = 'porter unicode61');`,
]

/** Bodies are cut here; a 2 MB file's first part is what gets found. */
export const BODY_MAX_CHARS = 200_000
const TOKENS_MAX = 12
const DAY_MS = 86_400_000

export interface IndexDoc {
  /** Unique per item, prefixed with its source ('chat:', 'memory:', 'history:', …). */
  key: string
  source: SearchSource
  title: string
  body: string
  url: string | null
  ref: FileRef | null
  at: number
  /** The browsing profile for history and bookmarks; null for app-wide items. */
  profile: string | null
  /** Changes whenever the item does (updatedAt, mtime); equal stamps skip re-indexing. */
  stamp: string
}

/**
 * The FTS5 query for what someone typed: each word quoted (so operators and
 * punctuation are just text) and prefix-matched, all words required. Null
 * when nothing searchable is left.
 */
export function ftsQuery(text: string): string | null {
  const words = text.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? []
  const picked = words.slice(0, TOKENS_MAX)
  if (picked.length === 0) return null
  return picked.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ')
}

export class SearchIndex {
  readonly #db: DatabaseSync
  readonly #now: () => number

  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.#db = db
    this.#now = now
    migrate(db, 'search', SEARCH_STEPS)
  }

  /** The stamp an item was indexed with, or null when it isn't. */
  stamp(key: string): string | null {
    return (this.#db.prepare('SELECT stamp FROM docs WHERE key = ?').get(key) as { stamp: string } | undefined)?.stamp ?? null
  }

  /** Every key with this prefix (and its stamp), for spotting removed items. */
  keys(prefix: string): Map<string, string> {
    const rows = this.#db.prepare("SELECT key, stamp FROM docs WHERE key >= ? AND key < ? || char(1114111)").all(prefix, prefix) as Array<{ key: string; stamp: string }>
    return new Map(rows.map((r) => [r.key, r.stamp]))
  }

  upsert(doc: IndexDoc): void {
    transaction(this.#db, () => {
      const existing = this.#db.prepare('SELECT id FROM docs WHERE key = ?').get(doc.key) as { id: number } | undefined
      if (existing) {
        this.#db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(existing.id)
        this.#db.prepare('UPDATE docs SET source = ?, title = ?, url = ?, ref = ?, at = ?, profile = ?, stamp = ? WHERE id = ?').run(doc.source, doc.title, doc.url, doc.ref ? JSON.stringify(doc.ref) : null, doc.at, doc.profile, doc.stamp, existing.id)
      } else {
        this.#db.prepare('INSERT INTO docs (key, source, title, url, ref, at, profile, stamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(doc.key, doc.source, doc.title, doc.url, doc.ref ? JSON.stringify(doc.ref) : null, doc.at, doc.profile, doc.stamp)
      }
      const id = existing?.id ?? (this.#db.prepare('SELECT id FROM docs WHERE key = ?').get(doc.key) as { id: number }).id
      this.#db.prepare('INSERT INTO docs_fts (rowid, title, body) VALUES (?, ?, ?)').run(id, doc.title, doc.body.slice(0, BODY_MAX_CHARS))
    })
  }

  remove(key: string): void {
    transaction(this.#db, () => {
      const row = this.#db.prepare('SELECT id FROM docs WHERE key = ?').get(key) as { id: number } | undefined
      if (!row) return
      this.#db.prepare('DELETE FROM docs_fts WHERE rowid = ?').run(row.id)
      this.#db.prepare('DELETE FROM docs WHERE id = ?').run(row.id)
    })
  }

  /** Removes every item whose key starts with `prefix` (a folder was revoked, history cleared). */
  removePrefix(prefix: string): number {
    const keys = [...this.keys(prefix).keys()]
    transaction(this.#db, () => {
      for (const key of keys) this.remove(key)
    })
    return keys.length
  }

  clear(): void {
    transaction(this.#db, () => {
      this.#db.exec('DELETE FROM docs_fts')
      this.#db.exec('DELETE FROM docs')
    })
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number }).n
  }

  /** The newest items of some sources, newest first (the hub's recent files, the project file picker). No snippets. */
  recent(options: { sources?: readonly SearchSource[]; limit?: number; profile?: string } = {}): SearchHit[] {
    const sources = options.sources && options.sources.length > 0 ? options.sources : SEARCH_SOURCES
    const placeholders = sources.map(() => '?').join(', ')
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200))
    const rows = this.#db
      .prepare(`SELECT key, source, title, url, ref, at FROM docs WHERE source IN (${placeholders}) AND (profile IS NULL OR profile = ?) ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...sources, options.profile ?? 'default', limit) as Array<{ key: string; source: SearchSource; title: string; url: string | null; ref: string | null; at: number }>
    return rows.map((r) => ({ source: r.source, id: r.key, title: r.title, snippet: '', url: r.url, ref: r.ref ? (JSON.parse(r.ref) as FileRef) : null, at: r.at, score: 0 }))
  }

  query(text: string, options: { sources?: readonly SearchSource[]; limit?: number; offset?: number; profile?: string } = {}): { hits: SearchHit[]; total: number } {
    const match = ftsQuery(text)
    if (!match) return { hits: [], total: 0 }
    const sources = options.sources && options.sources.length > 0 ? options.sources : SEARCH_SOURCES
    const placeholders = sources.map(() => '?').join(', ')
    const profile = options.profile ?? 'default'
    const where = `docs_fts MATCH ? AND d.source IN (${placeholders}) AND (d.profile IS NULL OR d.profile = ?)`
    const args = [match, ...sources, profile]
    const total = (this.#db.prepare(`SELECT COUNT(*) AS n FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid WHERE ${where}`).get(...args) as { n: number }).n
    const limit = Math.max(1, Math.min(options.limit ?? 20, 200))
    const offset = Math.max(0, options.offset ?? 0)
    // bm25 is negative (lower is better); multiplying by up to 1.5 for fresh items ranks them higher.
    const rows = this.#db
      .prepare(
        `SELECT d.key, d.source, d.title, d.url, d.ref, d.at,
          snippet(docs_fts, 1, ?, ?, '…', 14) AS body_snip,
          snippet(docs_fts, 0, ?, ?, '…', 14) AS title_snip,
          bm25(docs_fts, 4.0, 1.0) * (1.0 + 0.5 / (1.0 + MAX(0, ? - d.at) / ?)) AS rank
        FROM docs_fts JOIN docs d ON d.id = docs_fts.rowid
        WHERE ${where}
        ORDER BY rank LIMIT ? OFFSET ?`,
      )
      .all(HIT_OPEN, HIT_CLOSE, HIT_OPEN, HIT_CLOSE, this.#now(), 7 * DAY_MS, ...args, limit, offset) as Array<{
      key: string
      source: SearchSource
      title: string
      url: string | null
      ref: string | null
      at: number
      body_snip: string | null
      title_snip: string | null
      rank: number
    }>
    const hits = rows.map((r) => {
      const bodyHit = r.body_snip?.includes(HIT_OPEN)
      return {
        source: r.source,
        id: r.key,
        title: r.title,
        snippet: (bodyHit ? r.body_snip : r.body_snip || r.title_snip) ?? '',
        url: r.url,
        ref: r.ref ? (JSON.parse(r.ref) as FileRef) : null,
        at: r.at,
        score: -r.rank,
      }
    })
    return { hits, total }
  }
}
