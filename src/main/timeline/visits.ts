/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The per-profile visits log behind the timeline:
// <profile dataDir>/activity/visits.sqlite. Written for every visit in a
// normal window, like history, whether or not activity memory is on, and
// pruned with history: removing a page from history removes its visits,
// clearing history clears them all.
import { migrate, openDb, type DatabaseSync } from '../db'
import type { Visit } from './sessions'

const STEPS = [
  `CREATE TABLE visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    origin TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL,
    dwell_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX visits_by_time ON visits (at);
  CREATE INDEX visits_by_url ON visits (url);`,
]

/** scheme://host of an http(s) address, or null. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

interface Row {
  id: number
  url: string
  origin: string
  title: string
  at: number
  dwell_ms: number
}

export class VisitsLog {
  readonly #path: string
  #db: DatabaseSync | null = null

  constructor(path: string) {
    this.#path = path
  }

  #open(): DatabaseSync {
    if (!this.#db) {
      const db = openDb(this.#path)
      migrate(db, 'visits', STEPS)
      this.#db = db
    }
    return this.#db
  }

  /** Records a visit; returns its id, or null for an address that isn't a website. */
  record(v: { url: string; title: string; at: number }): number | null {
    const origin = originOf(v.url)
    if (!origin) return null
    const result = this.#open().prepare('INSERT INTO visits (url, origin, title, at) VALUES (?, ?, ?, ?)').run(v.url, origin, v.title.slice(0, 500), v.at)
    return Number(result.lastInsertRowid)
  }

  setDwell(id: number, dwellMs: number): void {
    this.#open().prepare('UPDATE visits SET dwell_ms = ? WHERE id = ?').run(Math.max(0, Math.round(dwellMs)), id)
  }

  setTitle(id: number, title: string): void {
    if (title) this.#open().prepare('UPDATE visits SET title = ? WHERE id = ?').run(title.slice(0, 500), id)
  }

  /** Visits from `from` through `to`, oldest first. */
  range(from: number, to: number): Visit[] {
    const rows = this.#open().prepare('SELECT id, url, origin, title, at, dwell_ms FROM visits WHERE at >= ? AND at <= ? ORDER BY at ASC, id ASC LIMIT 50000').all(from, to) as unknown as Row[]
    return rows.map((r) => ({ id: r.id, url: r.url, origin: r.origin, title: r.title, at: r.at, dwellMs: r.dwell_ms }))
  }

  /** History removed a page: its visits go too. */
  removeUrl(url: string): number {
    return Number(this.#open().prepare('DELETE FROM visits WHERE url = ?').run(url).changes)
  }

  /** History was cleared. */
  clear(): number {
    return Number(this.#open().prepare('DELETE FROM visits').run().changes)
  }

  close(): void {
    this.#db?.close()
    this.#db = null
  }
}
