/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// SQLite for Atelier's stores:
// one small wrapper over node:sqlite, the same module importer.ts already
// uses. `migrate` applies numbered steps once, in order, inside a
// transaction, and records them per `name`. Only the API common to
// Electron's Node 24 and the Node 22 vitest runs on is used.
import { BRAND_NAME } from '@shared/branding'
import './workspace/sqliteWarning'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type { DatabaseSync } from 'node:sqlite'

/** How long a write waits for another connection's lock before failing. */
export const BUSY_TIMEOUT_MS = 5000

/** Opens (and creates, unless read-only) a database with WAL and foreign keys on. */
export function openDb(path: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  const readOnly = options.readOnly === true
  if (!readOnly && path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path, { readOnly })
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  if (!readOnly) {
    // WAL lets readers run while a writer works; an in-memory database keeps its own mode.
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

/** Runs the steps of `name` that this database has not run yet. Steps are append-only: never edit a shipped one. */
export function migrate(db: DatabaseSync, name: string, steps: string[]): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT NOT NULL, step INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (name, step))')
  const row = db.prepare('SELECT MAX(step) AS done FROM _migrations WHERE name = ?').get(name) as { done: number | null } | undefined
  const done = row?.done ?? -1
  if (done >= steps.length) throw new Error(`The ${name} database is newer than this version of ${BRAND_NAME}.`)
  const record = db.prepare('INSERT INTO _migrations (name, step, at) VALUES (?, ?, ?)')
  for (let step = done + 1; step < steps.length; step++) {
    // Each step and its record land together, or not at all.
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(steps[step] ?? '')
      record.run(name, step, Date.now())
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`Migration ${name} step ${step} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** Runs `fn` in one transaction; a throw rolls it back. Nested calls join the outer one. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
