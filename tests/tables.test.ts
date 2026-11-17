/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync, truncateSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {},
}))

import { SHARED_OWNER } from '../src/shared/chats'
import { TABLE_LIMITS, columnIdentifiers, sqlIdentifier } from '../src/shared/tables'
import type { AgentRequestResponse } from '../src/shared/agentTools'
import { openDb } from '../src/main/db'
import { formatRead, runRead } from '../src/main/tables/query'
import { inProcessReader, workerReader } from '../src/main/tables/queryClient'
import { TableStore } from '../src/main/tables/store'
import { registerTableTools, resetTableGrantsForTests } from '../src/main/tables/tools'
import { clientTool, resetClientToolsForTests, type ClientToolContext } from '../src/main/agent/tools/registry'

// CSV import into per-owner SQLite files, the grid's
// reads, and the agent's tools with read-only enforcement.

let dir: string
let store: TableStore

const csv = (name: string, text: string): string => {
  const path = join(dir, name)
  writeFileSync(path, text, 'utf8')
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atelier-tables-'))
  store = new TableStore(dir, openDb)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('names', () => {
  it('turns any header into a plain SQL name', () => {
    expect(sqlIdentifier('Order date')).toBe('order_date')
    expect(sqlIdentifier('Prix (€)')).toBe('prix')
    expect(sqlIdentifier('Café')).toBe('cafe')
    expect(sqlIdentifier('2024')).toBe('column_2024')
    expect(sqlIdentifier('select')).toBe('select_')
    expect(sqlIdentifier('')).toBe('column')
    expect(sqlIdentifier('sqlite_x')).toBe('sqlite_x_')
  })

  it('makes repeated headers unique', () => {
    expect(columnIdentifiers(['Name', 'name', 'NAME', ''])).toEqual(['name', 'name_2', 'name_3', 'column_4'])
  })
})

describe('import', () => {
  it('previews delimiter, header, types and a sample, then imports typed rows', async () => {
    const path = csv('sales.csv', 'Region;Units;Price;Code\nNorth;12;3.5;007\nSouth;8;4;010\n\nEast;;2.25;100\n')
    const preview = await store.preview(path, SHARED_OWNER)
    expect(preview).toMatchObject({ fileName: 'sales.csv', delimiter: ';', hasHeader: true, rowCount: 3 })
    expect(preview.columns).toEqual([
      { name: 'region', type: 'TEXT' },
      { name: 'units', type: 'INTEGER' },
      { name: 'price', type: 'REAL' },
      { name: 'code', type: 'TEXT' },
    ])
    expect(preview.sample[0]).toEqual(['North', '12', '3.5', '007'])

    const table = await store.confirm(preview.token, { name: 'Q3 sales', columns: preview.columns })
    expect(table).toMatchObject({ name: 'q3_sales', owner: SHARED_OWNER, rowCount: 3 })
    const page = store.rows(table.id, { offset: 0, limit: 10 })
    expect(page.columns).toEqual(['region', 'units', 'price', 'code'])
    expect(page.rows[0]).toEqual(['North', 12, 3.5, '007'])
    // An empty cell is NULL, and a postcode-like code keeps its zeros.
    expect(page.rows[2]).toEqual(['East', null, 2.25, '100'])
  })

  it('lets the person rename and retype columns, and read the first row as data', async () => {
    const path = csv('nums.csv', '1,2\n3,4\n')
    const preview = await store.preview(path, SHARED_OWNER)
    expect(preview.hasHeader).toBe(false)
    expect(preview.columns.map((c) => c.type)).toEqual(['INTEGER', 'INTEGER'])
    expect(store.columnsFor(preview.token, false).map((c) => c.name)).toEqual(['column_1', 'column_2'])
    const table = await store.confirm(preview.token, { name: 'nums', columns: [{ name: 'Left', type: 'TEXT' }, { name: 'right', type: 'REAL' }] })
    expect(table.columns).toEqual([
      { name: 'left', type: 'TEXT' },
      { name: 'right', type: 'REAL' },
    ])
    expect(table.rowCount).toBe(2)
    expect(store.rows(table.id, { offset: 0, limit: 5 }).rows).toEqual([
      ['1', 2],
      ['3', 4],
    ])
  })

  it('refuses a column count that no longer matches, and a used token', async () => {
    const preview = await store.preview(csv('a.csv', 'a,b\n1,2\n'), SHARED_OWNER)
    await expect(store.confirm(preview.token, { name: 'x', columns: [{ name: 'a', type: 'TEXT' }] })).rejects.toThrow(/no longer match/)
    await expect(store.confirm(preview.token, { name: 'x', columns: preview.columns })).rejects.toThrow(/expired/)
  })

  it('refuses empty files and files over 50 MB', async () => {
    await expect(store.preview(csv('empty.csv', ''), SHARED_OWNER)).rejects.toThrow(/no rows/)
    const big = csv('big.csv', 'a\n')
    truncateSync(big, TABLE_LIMITS.fileBytes + 1)
    await expect(store.preview(big, SHARED_OWNER)).rejects.toThrow(/50 MB/)
  })

  it('gives a second table with the same name a suffix', async () => {
    const one = await store.preview(csv('a.csv', 'a\nx\n'), SHARED_OWNER)
    const two = await store.preview(csv('b.csv', 'a\ny\n'), SHARED_OWNER)
    expect((await store.confirm(one.token, { name: 'list', columns: one.columns })).name).toBe('list')
    expect((await store.confirm(two.token, { name: 'list', columns: two.columns })).name).toBe('list_2')
  })
})

describe('the grid and the table actions', () => {
  it('sorts by a known column only, and pages', async () => {
    const p = await store.preview(csv('s.csv', 'name,n\nb,2\na,3\nc,1\n'), SHARED_OWNER)
    const t = await store.confirm(p.token, { name: 's', columns: p.columns })
    expect(store.rows(t.id, { offset: 0, limit: 10, sort: 'n' }).rows.map((r) => r[0])).toEqual(['c', 'b', 'a'])
    expect(store.rows(t.id, { offset: 0, limit: 10, sort: 'name', desc: true }).rows.map((r) => r[0])).toEqual(['c', 'b', 'a'])
    expect(store.rows(t.id, { offset: 1, limit: 1 })).toMatchObject({ rows: [['a', 3]], total: 3 })
    expect(() => store.rows(t.id, { offset: 0, limit: 10, sort: 'name; DROP TABLE s' })).toThrow(/no column/)
  })

  it('renames, exports CSV and restores from that CSV after a drop', async () => {
    const p = await store.preview(csv('r.csv', 'city,note\nGhent,"a, b"\n'), SHARED_OWNER)
    const t = await store.confirm(p.token, { name: 'r', columns: p.columns })
    expect(store.rename(t.id, 'Cities').name).toBe('cities')
    const out = join(dir, 'out.csv')
    store.writeCsv(t.id, out)
    expect(readFileSync(out, 'utf8')).toBe('city,note\r\nGhent,"a, b"\r\n')
    store.drop(t.id)
    expect(store.list()).toEqual([])
    expect(() => store.get(t.id)).toThrow(/no longer exists/)
    const name = store.restoreFrom(SHARED_OWNER, 'cities', t.columns, out)
    expect(name).toBe('cities')
    expect(store.list()[0]).toMatchObject({ name: 'cities', rowCount: 1 })
  })

  it('keeps each owner in its own file', async () => {
    const p = await store.preview(csv('o.csv', 'a\n1\n'), 'companion-1')
    await store.confirm(p.token, { name: 'mine', columns: p.columns })
    expect(store.list('companion-1').map((t) => t.name)).toEqual(['mine'])
    expect(store.list(SHARED_OWNER)).toEqual([])
    expect(store.pathOf('companion-1')).toBe(join(dir, 'tables', 'companion-1.sqlite'))
    expect(() => store.pathOf('../etc')).toThrow(/not valid/)
  })
})

describe('the read connection', () => {
  it('reads with the shared file attached as shared, and refuses writes in SQLite itself', async () => {
    const shared = await store.preview(csv('p.csv', 'item,price\ntea,3\n'), SHARED_OWNER)
    await store.confirm(shared.token, { name: 'prices', columns: shared.columns })
    const own = await store.preview(csv('m.csv', 'item\ntea\n'), 'companion-1')
    await store.confirm(own.token, { name: 'mine', columns: own.columns })

    const req = { dbPath: store.pathOf('companion-1'), sharedPath: store.pathOf(SHARED_OWNER) }
    const joined = runRead({ ...req, statement: 'SELECT m.item, p.price FROM mine m JOIN shared.prices p USING (item)' })
    expect(joined).toEqual({ ok: true, columns: ['item', 'price'], rows: [['tea', 3]], truncated: false })
    // Even a write that got past the guard fails on the read-only connection.
    const write = runRead({ ...req, statement: 'DELETE FROM mine' })
    expect(write.ok).toBe(false)
    expect(store.list('companion-1')[0]?.rowCount).toBe(1)
  })

  it('answers on this thread when the worker file is missing', async () => {
    const result = await workerReader(() => join(dir, 'missing-worker.js'))({ dbPath: join(dir, 'none.sqlite'), sharedPath: null, statement: 'SELECT 2 AS two' })
    expect(result).toEqual({ ok: true, columns: ['two'], rows: [[2]], truncated: false })
  })

  it('stops at the row cap and the character cap', () => {
    const many = runRead({ dbPath: join(dir, 'none.sqlite'), sharedPath: null, statement: 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 600) SELECT i FROM n' })
    expect(many.ok && many.rows.length).toBe(TABLE_LIMITS.queryRows)
    expect(many.ok && many.truncated).toBe(true)
    if (!many.ok) return
    const text = formatRead(many, 400)
    expect(text.length).toBeLessThanOrEqual(400)
    expect(() => JSON.parse(text)).not.toThrow()
  })
})

describe('the agent tools', () => {
  const asked: unknown[] = []
  let answer: AgentRequestResponse = { kind: 'table-write', allowed: true, scope: 'once' }
  const ctx = (chatId = 'chat-1'): ClientToolContext => ({
    chatId,
    companionId: 'companion-1',
    isPrivate: false,
    isRoutine: false,
    signal: new AbortController().signal,
    emit: () => undefined,
    ask: async <R extends AgentRequestResponse>(event: unknown) => {
      asked.push(event)
      return answer as R
    },
  })
  const run = (name: string, input: unknown, c = ctx()) => clientTool(name)!.run(input as never, c)

  beforeAll(() => {
    resetClientToolsForTests()
    // The store is new per test; the tools reach the current one through this proxy.
    const current = new Proxy({} as TableStore, {
      get: (_t, key) => {
        const value = (store as unknown as Record<string | symbol, unknown>)[key]
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(store) : value
      },
    })
    registerTableTools({ store: current, read: inProcessReader, changed: () => undefined })
  })
  afterAll(() => resetClientToolsForTests())
  beforeEach(() => {
    asked.length = 0
    answer = { kind: 'table-write', allowed: true, scope: 'once' }
    resetTableGrantsForTests()
  })

  it('lists own and shared tables, shared ones prefixed', async () => {
    const p = await store.preview(csv('p.csv', 'a\n1\n'), SHARED_OWNER)
    await store.confirm(p.token, { name: 'prices', columns: p.columns })
    const out = JSON.parse((await run('list_tables', {})).content) as { tables: Array<{ table: string }> }
    expect(out.tables.map((t) => t.table)).toEqual(['shared.prices'])
  })

  it('query_table refuses writes and reads with caps', async () => {
    expect((await run('query_table', { sql: 'DELETE FROM x' })).isError).toBe(true)
    expect((await run('query_table', { sql: 'ATTACH DATABASE "x" AS y' })).isError).toBe(true)
    const ok = await run('query_table', { sql: 'SELECT 1 AS one' })
    expect(ok.isError).toBeFalsy()
    expect(JSON.parse(ok.content)).toMatchObject({ columns: ['one'] })
  })

  it('write_table asks with the statement and scope, and allow-for-chat covers later plain writes', async () => {
    answer = { kind: 'table-write', allowed: true, scope: 'chat' }
    expect((await run('write_table', { sql: 'CREATE TABLE notes (t TEXT)' })).isError).toBeFalsy()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ type: 'table-write', table: 'notes', sql: 'CREATE TABLE notes (t TEXT)', destructive: false })
    expect((await run('write_table', { sql: `INSERT INTO notes VALUES ('hi')` })).isError).toBeFalsy()
    expect(asked).toHaveLength(1)
    // Destructive changes always ask, even after "for this chat".
    expect((await run('write_table', { sql: 'DELETE FROM notes' })).isError).toBeFalsy()
    expect(asked).toHaveLength(2)
    expect(asked[1]).toMatchObject({ destructive: true })
    // Another chat asks again.
    await run('write_table', { sql: `INSERT INTO notes VALUES ('x')` }, ctx('chat-2'))
    expect(asked).toHaveLength(3)
  })

  it('a declined write changes nothing; refused statements never ask', async () => {
    answer = { kind: 'table-write', allowed: false, scope: 'once' }
    const declined = await run('write_table', { sql: 'CREATE TABLE nope (a)' })
    expect(declined.isError).toBe(true)
    expect(store.list('companion-1')).toEqual([])
    expect((await run('write_table', { sql: 'PRAGMA writable_schema = 1' })).isError).toBe(true)
    expect((await run('write_table', { sql: 'SELECT 1' })).isError).toBe(true)
    expect((await run('write_table', { sql: 'DROP TABLE shared.prices' })).isError).toBe(true)
    expect(asked).toHaveLength(1)
  })
})
