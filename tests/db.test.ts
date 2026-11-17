/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDb, transaction } from '../src/main/db'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-db-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('openDb', () => {
  it('creates the folder, turns on WAL and foreign keys', () => {
    const db = openDb(join(temp(), 'nested', 'a.sqlite'))
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1)
    db.close()
  })

  it('opens read-only connections that refuse writes', () => {
    const path = join(temp(), 'b.sqlite')
    const rw = openDb(path)
    rw.exec('CREATE TABLE t (x INTEGER)')
    rw.close()
    const ro = openDb(path, { readOnly: true })
    expect(() => ro.exec('INSERT INTO t VALUES (1)')).toThrow()
    ro.close()
  })

  it('has FTS5 with the porter tokenizer, bm25 and snippet', () => {
    const db = openDb(':memory:')
    db.exec("CREATE VIRTUAL TABLE f USING fts5(body, tokenize = 'porter unicode61')")
    db.prepare('INSERT INTO f (body) VALUES (?)').run('Running shoes for the marathon')
    const row = db.prepare("SELECT snippet(f, 0, '[', ']', '…', 8) AS s, bm25(f) AS r FROM f WHERE f MATCH ?").get('run') as { s: string; r: number }
    expect(row.s).toContain('[Running]')
    expect(typeof row.r).toBe('number')
    db.close()
  })
})

describe('migrate', () => {
  it('runs each step once, in order, and records it per name', () => {
    const path = join(temp(), 'm.sqlite')
    const steps = ['CREATE TABLE a (x INTEGER)', 'ALTER TABLE a ADD COLUMN y TEXT']
    let db = openDb(path)
    migrate(db, 'test', steps)
    migrate(db, 'test', steps)
    db.close()
    db = openDb(path)
    migrate(db, 'test', [...steps, 'CREATE TABLE b (z INTEGER)'])
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name)
    expect(names).toEqual(['_migrations', 'a', 'b'])
    expect((db.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = 'test'").get() as { n: number }).n).toBe(3)
    // Another name has its own steps.
    migrate(db, 'other', ['CREATE TABLE c (x INTEGER)'])
    expect((db.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = 'other'").get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('rolls back a failed step and leaves the earlier ones', () => {
    const db = openDb(':memory:')
    expect(() => migrate(db, 'bad', ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE a (x INTEGER)'])).toThrow('Migration bad step 1 failed')
    expect((db.prepare("SELECT COUNT(*) AS n FROM _migrations WHERE name = 'bad'").get() as { n: number }).n).toBe(1)
    db.close()
  })

  it('refuses a database migrated by a newer Atelier', () => {
    const db = openDb(':memory:')
    migrate(db, 'x', ['CREATE TABLE a (x INTEGER)', 'CREATE TABLE b (x INTEGER)'])
    expect(() => migrate(db, 'x', ['CREATE TABLE a (x INTEGER)'])).toThrow('newer')
    db.close()
  })
})

describe('transaction', () => {
  it('commits, rolls back on a throw, and joins an outer transaction', () => {
    const db = openDb(':memory:')
    db.exec('CREATE TABLE t (x INTEGER)')
    transaction(db, () => db.prepare('INSERT INTO t VALUES (1)').run())
    expect(() => transaction(db, () => {
      db.prepare('INSERT INTO t VALUES (2)').run()
      throw new Error('stop')
    })).toThrow('stop')
    transaction(db, () => transaction(db, () => db.prepare('INSERT INTO t VALUES (3)').run()))
    expect((db.prepare('SELECT GROUP_CONCAT(x) AS v FROM t').get() as { v: string }).v).toBe('1,3')
    db.close()
  })
})
