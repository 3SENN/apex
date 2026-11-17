/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// CSV tables in SQLite: one file per owner,
// userData/tables/<owner>.sqlite, each real table registered in a small
// _apex_tables list (id, name, dates). Apex reads and changes its own
// tables through this store; the agent goes through the guard (sqlGuard.ts)
// and, for reads, a separate read-only connection (query.ts).
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CsvStreamParser, csvField, detectDelimiter, detectHeader, parseCsv, widenType, type CsvDelimiter, type CsvValueType } from '@shared/csv'
import { SHARED_OWNER } from '@shared/chats'
import { TABLE_LIMITS, columnIdentifiers, sqlIdentifier, type CsvPreview, type TableColumn, type TableSummary } from '@shared/tables'
import type { DatabaseSync } from '../db'

export type DbOpener = (path: string, options?: { readOnly?: boolean }) => DatabaseSync

const OWNER = /^[A-Za-z0-9-]{1,64}$/
const META = '_apex_tables'

/** A quoted identifier (names are sanitised already; quoting keeps SQLite's own words safe). */
export const q = (name: string): string => `"${name.replace(/"/g, '""')}"`

interface MetaRow {
  id: string
  name: string
  updated_at: number
}

/** A parsed CSV waiting for confirmation (the token in CsvPreview). */
interface PendingImport {
  path: string
  owner: string
  fileName: string
  delimiter: CsvDelimiter
  width: number
  /** Types with and without the first row, so switching the header needs no second pass. */
  typesWithFirst: CsvValueType[]
  typesWithoutFirst: CsvValueType[]
  firstRow: string[]
  rowCount: number
  at: number
}

const PENDING_TTL_MS = 30 * 60_000

export class TableStore {
  readonly #dir: string
  readonly #open: DbOpener
  readonly #dbs = new Map<string, DatabaseSync>()
  readonly #pending = new Map<string, PendingImport>()

  constructor(dataDir: string, open: DbOpener) {
    this.#dir = join(dataDir, 'tables')
    this.#open = open
  }

  /** The file an owner's tables live in. */
  pathOf(owner: string): string {
    if (!OWNER.test(owner)) throw new Error('That owner is not valid.')
    return join(this.#dir, `${owner}.sqlite`)
  }

  db(owner: string): DatabaseSync {
    const existing = this.#dbs.get(owner)
    if (existing) return existing
    mkdirSync(this.#dir, { recursive: true })
    const db = this.#open(this.pathOf(owner))
    db.exec(`CREATE TABLE IF NOT EXISTS ${META} (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    this.#dbs.set(owner, db)
    return db
  }

  owners(): string[] {
    if (!existsSync(this.#dir)) return []
    return readdirSync(this.#dir)
      .filter((f) => f.endsWith('.sqlite'))
      .map((f) => f.slice(0, -'.sqlite'.length))
      .filter((o) => OWNER.test(o))
  }

  #summary(owner: string, row: MetaRow): TableSummary | null {
    const db = this.db(owner)
    const info = db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(row.name) as Array<{ name: string; type: string }>
    // A table the agent dropped outside the store is forgotten.
    if (info.length === 0) {
      db.prepare(`DELETE FROM ${META} WHERE id = ?`).run(row.id)
      return null
    }
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${q(row.name)}`).get() as { n: number }
    return {
      id: row.id,
      name: row.name,
      owner,
      rowCount: Number(count.n),
      columns: info.map((c) => ({ name: c.name, type: normalizeType(c.type) })),
      updatedAt: row.updated_at,
    }
  }

  list(owner?: string): TableSummary[] {
    const owners = owner ? [owner] : this.owners()
    const out: TableSummary[] = []
    for (const o of owners) {
      if (!existsSync(this.pathOf(o)) && !this.#dbs.has(o)) continue
      this.reconcile(o)
      for (const row of this.db(o).prepare(`SELECT id, name, updated_at FROM ${META} ORDER BY updated_at DESC`).all() as unknown as MetaRow[]) {
        const summary = this.#summary(o, row)
        if (summary) out.push(summary)
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** The table and its owner, or a clear error. */
  find(id: string): { owner: string; row: MetaRow } {
    for (const owner of this.owners()) {
      const row = this.db(owner).prepare(`SELECT id, name, updated_at FROM ${META} WHERE id = ?`).get(id) as MetaRow | undefined
      if (row) return { owner, row }
    }
    throw new Error('This table no longer exists.')
  }

  get(id: string): TableSummary {
    const { owner, row } = this.find(id)
    const summary = this.#summary(owner, row)
    if (!summary) throw new Error('This table no longer exists.')
    return summary
  }

  /** A name nobody in this file uses yet: the sanitised name, then name_2, name_3… */
  uniqueName(owner: string, wanted: string, except?: string): string {
    const base = sqlIdentifier(wanted, 'table')
    const db = this.db(owner)
    const taken = (name: string): boolean => {
      const row = db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND lower(name) = lower(?)`).get(name) as { name: string } | undefined
      return row !== undefined && row.name !== except
    }
    let name = base
    for (let n = 2; taken(name); n++) name = `${base}_${n}`
    return name
  }

  /** Lists tables the agent created with write_table, and forgets ones it dropped. */
  reconcile(owner: string): void {
    const db = this.db(owner)
    const now = Date.now()
    const real = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_apex%' ESCAPE '\\'`).all() as Array<{ name: string }>
    const known = new Set((db.prepare(`SELECT name FROM ${META}`).all() as Array<{ name: string }>).map((r) => r.name))
    const names = new Set(real.map((r) => r.name))
    for (const name of names) if (!known.has(name)) db.prepare(`INSERT INTO ${META} (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(randomUUID(), name, now, now)
    for (const name of known) if (!names.has(name)) db.prepare(`DELETE FROM ${META} WHERE name = ?`).run(name)
  }

  touch(owner: string, name: string | null): void {
    if (name) this.db(owner).prepare(`UPDATE ${META} SET updated_at = ? WHERE lower(name) = lower(?)`).run(Date.now(), name.replace(/^shared\./i, ''))
  }


  /** Reads the whole file once: delimiter, header, types over every row, the row count and a sample. */
  async preview(path: string, owner: string): Promise<CsvPreview> {
    const size = statSync(path).size
    if (size > TABLE_LIMITS.fileBytes) throw new Error('That file is larger than 50 MB. Split it, or remove columns you don’t need.')
    const head = await readHead(path, 64 * 1024)
    const delimiter = detectDelimiter(head)
    const parser = new CsvStreamParser(delimiter)
    const sample: string[][] = []
    let width = 0
    let rowCount = 0
    let first: string[] | null = null
    let withFirst: (CsvValueType | null)[] = []
    let withoutFirst: (CsvValueType | null)[] = []
    const take = (rows: string[][]): void => {
      for (const row of rows) {
        // A blank line between rows is not a row.
        if (row.length === 1 && row[0] === '') continue
        rowCount++
        if (rowCount > TABLE_LIMITS.rows + 1) throw new Error('That file has more than a million rows.')
        if (row.length > TABLE_LIMITS.columns) throw new Error('That file has more than 200 columns.')
        width = Math.max(width, row.length)
        if (sample.length < TABLE_LIMITS.sampleRows + 1) sample.push(row)
        for (let i = 0; i < row.length; i++) {
          const value = row[i] ?? ''
          withFirst[i] = widenType(withFirst[i] ?? null, value)
          if (first !== null) withoutFirst[i] = widenType(withoutFirst[i] ?? null, value)
        }
        if (first === null) first = row
      }
    }
    for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 256 * 1024 })) take(parser.push(chunk as string))
    take(parser.end())
    if (rowCount === 0 || first === null) throw new Error('That file has no rows.')
    const hasHeader = detectHeader(sample)
    const fill = (types: (CsvValueType | null)[]): CsvValueType[] => Array.from({ length: width }, (_, i) => types[i] ?? 'TEXT')
    const pending: PendingImport = {
      path,
      owner,
      fileName: basename(path),
      delimiter,
      width,
      typesWithFirst: fill(withFirst),
      typesWithoutFirst: fill(withoutFirst),
      firstRow: first,
      rowCount,
      at: Date.now(),
    }
    if (pending.rowCount - (hasHeader ? 1 : 0) > TABLE_LIMITS.rows) throw new Error('That file has more than a million rows.')
    this.#prune()
    const token = randomUUID()
    this.#pending.set(token, pending)
    return {
      token,
      fileName: pending.fileName,
      delimiter,
      columns: proposedColumns(pending, hasHeader),
      sample: (hasHeader ? sample.slice(1) : sample).slice(0, TABLE_LIMITS.sampleRows),
      rowCount: rowCount - (hasHeader ? 1 : 0),
      hasHeader,
    }
  }

  /** The columns a header choice gives, before any edits (for the preview's header switch). */
  columnsFor(token: string, hasHeader: boolean): TableColumn[] {
    return proposedColumns(this.#take(token, false), hasHeader)
  }

  async confirm(token: string, input: { name: string; columns: TableColumn[]; hasHeader?: boolean }): Promise<TableSummary> {
    const pending = this.#take(token, true)
    if (input.columns.length !== pending.width) throw new Error('The columns no longer match the file. Pick it again.')
    const hasHeader = input.hasHeader ?? detectHeader([pending.firstRow])
    const owner = pending.owner
    const db = this.db(owner)
    const name = this.uniqueName(owner, input.name)
    const columns = columnIdentifiers(input.columns.map((c) => c.name)).map((id, i) => ({ name: id, type: input.columns[i]?.type ?? 'TEXT' }))
    const parser = new CsvStreamParser(pending.delimiter)
    const id = randomUUID()
    const now = Date.now()
    db.exec('BEGIN')
    try {
      db.exec(`CREATE TABLE ${q(name)} (${columns.map((c) => `${q(c.name)} ${c.type}`).join(', ')})`)
      const insert = db.prepare(`INSERT INTO ${q(name)} VALUES (${columns.map(() => '?').join(', ')})`)
      let skipped = !hasHeader
      const put = (rows: string[][]): void => {
        for (const row of rows) {
          if (row.length === 1 && row[0] === '') continue
          if (!skipped) {
            skipped = true
            continue
          }
          insert.run(...columns.map((_, i) => cell(row[i])))
        }
      }
      for await (const chunk of createReadStream(pending.path, { encoding: 'utf8', highWaterMark: 256 * 1024 })) put(parser.push(chunk as string))
      put(parser.end())
      db.prepare(`INSERT INTO ${META} (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, name, now, now)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return this.get(id)
  }

  #take(token: string, consume: boolean): PendingImport {
    const pending = this.#pending.get(token)
    if (!pending || Date.now() - pending.at > PENDING_TTL_MS) throw new Error('That import has expired. Pick the file again.')
    if (consume) this.#pending.delete(token)
    return pending
  }

  #prune(): void {
    const now = Date.now()
    for (const [token, p] of this.#pending) if (now - p.at > PENDING_TTL_MS) this.#pending.delete(token)
  }

  // ── Reading and changing ──

  rows(id: string, query: { offset: number; limit: number; sort?: string; desc?: boolean }): { columns: string[]; rows: unknown[][]; total: number } {
    const table = this.get(id)
    const columns = table.columns.map((c) => c.name)
    if (query.sort !== undefined && !columns.includes(query.sort)) throw new Error(`There is no column called ${query.sort}.`)
    const order = query.sort ? ` ORDER BY ${q(query.sort)} ${query.desc ? 'DESC' : 'ASC'}, rowid` : ' ORDER BY rowid'
    const stmt = this.db(table.owner).prepare(`SELECT * FROM ${q(table.name)}${order} LIMIT ? OFFSET ?`)
    stmt.setReturnArrays(true)
    const rows = (stmt.all(Math.min(query.limit, 1000), query.offset) as unknown as unknown[][]).map((r) => r.map(plainValue))
    return { columns, rows, total: table.rowCount }
  }

  rename(id: string, wanted: string): TableSummary {
    const { owner, row } = this.find(id)
    const name = this.uniqueName(owner, wanted, row.name)
    if (name !== row.name) {
      const db = this.db(owner)
      db.exec(`ALTER TABLE ${q(row.name)} RENAME TO ${q(name)}`)
      db.prepare(`UPDATE ${META} SET name = ?, updated_at = ? WHERE id = ?`).run(name, Date.now(), id)
    }
    return this.get(id)
  }

  /** Drops the table for good (after Recently Deleted took its snapshot). */
  drop(id: string): void {
    const { owner, row } = this.find(id)
    const db = this.db(owner)
    db.exec(`DROP TABLE IF EXISTS ${q(row.name)}`)
    db.prepare(`DELETE FROM ${META} WHERE id = ?`).run(id)
  }

  /** Writes the table as CSV, header first, in batches. */
  writeCsv(id: string, path: string): void {
    const table = this.get(id)
    const stmt = this.db(table.owner).prepare(`SELECT * FROM ${q(table.name)} ORDER BY rowid`)
    stmt.setReturnArrays(true)
    const lines = [table.columns.map((c) => csvField(c.name)).join(',')]
    for (const row of stmt.iterate() as Iterable<unknown[]>) lines.push(row.map((v) => csvField(v === null || v === undefined ? '' : String(plainValue(v)))).join(','))
    writeFileSync(path, lines.join('\r\n') + '\r\n', 'utf8')
  }

  /** Recreates a table from its CSV snapshot (Recently Deleted's restore); a taken name gets a suffix. */
  restoreFrom(owner: string, wanted: string, columns: TableColumn[], csvPath: string): string {
    const { rows } = parseCsv(readFileSync(csvPath, 'utf8'), { delimiter: ',' })
    const db = this.db(owner)
    const name = this.uniqueName(owner, wanted)
    const cols = columns.length > 0 ? columns : (rows[0] ?? []).map((n) => ({ name: sqlIdentifier(n), type: 'TEXT' as const }))
    const now = Date.now()
    db.exec('BEGIN')
    try {
      db.exec(`CREATE TABLE ${q(name)} (${cols.map((c) => `${q(c.name)} ${c.type}`).join(', ')})`)
      const insert = db.prepare(`INSERT INTO ${q(name)} VALUES (${cols.map(() => '?').join(', ')})`)
      for (const row of rows.slice(1)) insert.run(...cols.map((_, i) => cell(row[i])))
      db.prepare(`INSERT INTO ${META} (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(randomUUID(), name, now, now)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return name
  }

  close(): void {
    for (const db of this.#dbs.values()) db.close()
    this.#dbs.clear()
  }
}

function proposedColumns(p: PendingImport, hasHeader: boolean): TableColumn[] {
  const names = hasHeader ? p.firstRow.map((n, i) => n.trim() || `column_${i + 1}`) : Array.from({ length: p.width }, (_, i) => `column_${i + 1}`)
  while (names.length < p.width) names.push(`column_${names.length + 1}`)
  const types = hasHeader ? p.typesWithoutFirst : p.typesWithFirst
  return columnIdentifiers(names).map((name, i) => ({ name, type: types[i] ?? 'TEXT' }))
}

function normalizeType(declared: string): TableColumn['type'] {
  const t = declared.toUpperCase()
  if (t.includes('INT')) return 'INTEGER'
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUM') || t.includes('DEC')) return 'REAL'
  return 'TEXT'
}

/** An empty cell is NULL; the column's affinity turns "12" into 12. */
function cell(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

function plainValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`
  return value
}

async function readHead(path: string, bytes: number): Promise<string> {
  let text = ''
  for await (const chunk of createReadStream(path, { encoding: 'utf8', start: 0, end: bytes - 1 })) text += chunk as string
  return text
}

/** The shared owner's file name, for the read connection's ATTACH. */
export const SHARED_TABLES = SHARED_OWNER
