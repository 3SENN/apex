/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { checkRead, classifySql, maskSql, targetTable } from '../src/main/tables/sqlGuard'

// CH-43: what query_table and write_table accept.

const verdict = (sql: string) => classifySql(sql)
const refused = (sql: string): string => {
  const v = classifySql(sql)
  if (v.ok) throw new Error(`expected a refusal for ${sql}`)
  return v.reason
}

describe('maskSql', () => {
  it('blanks strings, quoted names and comments but keeps positions', () => {
    const sql = `SELECT 'a;b', "x" -- DROP\nFROM t /* ATTACH */`
    const masked = maskSql(sql)
    expect(masked).not.toBeNull()
    expect(masked).not.toMatch(/DROP|ATTACH|a;b/)
    expect(masked?.indexOf('FROM')).toBe(sql.indexOf('FROM'))
  })

  it('returns null for an unterminated string or comment', () => {
    expect(maskSql(`SELECT 'open`)).toBeNull()
    expect(maskSql('SELECT 1 /* open')).toBeNull()
  })
})

describe('reads', () => {
  it('accepts one SELECT, WITH or VALUES statement, with a trailing semicolon', () => {
    expect(checkRead('SELECT * FROM sales')).toEqual({ ok: true, statement: 'SELECT * FROM sales' })
    expect(checkRead('select count(*) from sales;')).toEqual({ ok: true, statement: 'select count(*) from sales' })
    expect(checkRead('WITH t AS (SELECT 1 AS n) SELECT n FROM t').ok).toBe(true)
    expect(checkRead('SELECT * FROM shared.prices').ok).toBe(true)
  })

  it('reads keywords inside strings and comments as text, not SQL', () => {
    expect(checkRead(`SELECT 'DROP TABLE x; ATTACH' AS note`).ok).toBe(true)
    expect(checkRead('SELECT 1 -- ; DELETE FROM t').ok).toBe(true)
  })

  it('refuses writes, and a WITH that ends in a write', () => {
    expect(checkRead('DELETE FROM sales').ok).toBe(false)
    expect(checkRead('WITH t AS (SELECT 1) DELETE FROM sales').ok).toBe(false)
    expect(checkRead('INSERT INTO sales VALUES (1)').ok).toBe(false)
  })
})

describe('refused everywhere', () => {
  it('refuses a second statement after a semicolon', () => {
    expect(refused('SELECT 1; DROP TABLE sales')).toMatch(/one statement/)
    expect(refused('SELECT 1;;SELECT 2')).toMatch(/one statement/)
  })

  it('never runs ATTACH, DETACH, PRAGMA, VACUUM or load_extension', () => {
    expect(refused(`ATTACH DATABASE '/etc/x' AS x`)).toMatch(/ATTACH/)
    expect(refused('DETACH shared')).toMatch(/DETACH/)
    expect(refused('PRAGMA table_info(sales)')).toMatch(/PRAGMA/)
    expect(refused('VACUUM')).toMatch(/VACUUM/)
    expect(refused(`SELECT load_extension('evil')`)).toMatch(/load_extension/)
    expect(refused(`SELECT LOAD_EXTENSION ('evil')`)).toMatch(/load_extension/)
  })

  it('refuses transactions, triggers and Atelier bookkeeping', () => {
    expect(refused('BEGIN')).toMatch(/BEGIN/)
    expect(refused('CREATE TRIGGER t AFTER INSERT ON s BEGIN SELECT 1; END')).toBeTruthy()
    expect(refused('SELECT * FROM _atelier_tables')).toMatch(/bookkeeping/)
    expect(refused('DELETE FROM sqlite_master')).toMatch(/SQLite/)
  })

  it('refuses empty, unclosed and unknown statements', () => {
    expect(refused('   ')).toMatch(/empty/)
    expect(refused(`SELECT 'x`)).toMatch(/not closed/)
    expect(refused('EXPLAIN SELECT 1')).toMatch(/Only SELECT/)
  })
})

describe('writes and destructive classification', () => {
  it('treats INSERT, CREATE and UPDATE with WHERE as plain writes', () => {
    expect(verdict('INSERT INTO sales (a) VALUES (1)')).toMatchObject({ ok: true, kind: 'write', destructive: false, table: 'sales' })
    expect(verdict('CREATE TABLE notes (id INTEGER, text TEXT)')).toMatchObject({ ok: true, kind: 'write', destructive: false, table: 'notes' })
    expect(verdict('UPDATE sales SET a = 2 WHERE id = 1')).toMatchObject({ ok: true, destructive: false, table: 'sales' })
  })

  it('marks DELETE, DROP, ALTER, REPLACE and UPDATE without WHERE destructive', () => {
    expect(verdict('DELETE FROM sales WHERE id = 1')).toMatchObject({ ok: true, destructive: true })
    expect(verdict('DELETE FROM sales')).toMatchObject({ ok: true, destructive: true })
    expect(verdict('DROP TABLE IF EXISTS sales')).toMatchObject({ ok: true, destructive: true, table: 'sales' })
    expect(verdict('ALTER TABLE sales ADD COLUMN b TEXT')).toMatchObject({ ok: true, destructive: true, table: 'sales' })
    expect(verdict('REPLACE INTO sales VALUES (1)')).toMatchObject({ ok: true, destructive: true, table: 'sales' })
    expect(verdict('INSERT OR REPLACE INTO sales VALUES (1)')).toMatchObject({ ok: true, destructive: true })
    expect(verdict('UPDATE sales SET a = 0')).toMatchObject({ ok: true, destructive: true })
  })

  it("doesn't count a WHERE inside a string", () => {
    expect(verdict(`UPDATE sales SET note = 'where'`)).toMatchObject({ ok: true, destructive: true })
  })

  it('reads the target name from quoted identifiers', () => {
    expect(targetTable('INSERT INTO "my table" VALUES (1)')).toBe('my table')
    expect(targetTable('DELETE FROM [orders]')).toBe('orders')
    expect(targetTable('SELECT 1')).toBeNull()
  })
})
