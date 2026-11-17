/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// query_table's read: one guarded statement on its own
// read-only connection, with the shared tables attached read-only as
// `shared`. Runs inside the query worker (so a slow query never blocks the
// window) and directly in tests. Rows stop at the cap; the text stops at
// the character cap.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { TABLE_LIMITS } from '@shared/tables'

export interface ReadRequest {
  /** The companion's (or shared) table file; it may not exist yet. */
  dbPath: string
  /** shared.sqlite, attached as `shared` when it exists and differs from dbPath. */
  sharedPath: string | null
  statement: string
}

export type ReadResult =
  | { ok: true; columns: string[]; rows: unknown[][]; truncated: boolean }
  | { ok: false; error: string }

function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`
  return value
}

export function runRead(req: ReadRequest, maxRows: number = TABLE_LIMITS.queryRows): ReadResult {
  // An empty in-memory database stands in when nothing has been imported yet, so `shared.x` still works.
  const db = existsSync(req.dbPath) ? new DatabaseSync(req.dbPath, { readOnly: true }) : new DatabaseSync(':memory:')
  try {
    if (req.sharedPath && req.sharedPath !== req.dbPath && existsSync(req.sharedPath)) {
      // Apex attaches it itself; the guard refuses ATTACH from the agent. A read-only main
      // connection opens attached files read-only too.
      db.prepare('ATTACH DATABASE ? AS shared').run(req.sharedPath)
    }
    db.exec('PRAGMA query_only = ON')
    const stmt = db.prepare(req.statement)
    const columns = stmt.columns().map((c) => c.name)
    stmt.setReturnArrays(true)
    const rows: unknown[][] = []
    let truncated = false
    for (const row of stmt.iterate() as Iterable<unknown[]>) {
      if (rows.length >= maxRows) {
        truncated = true
        break
      }
      rows.push(row.map(plain))
    }
    return { ok: true, columns, rows, truncated }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    db.close()
  }
}

/** The model's view of a result: JSON, cut to the character cap on a row boundary. */
export function formatRead(result: Extract<ReadResult, { ok: true }>, maxChars: number = TABLE_LIMITS.queryChars): string {
  const note = (n: number): string => `Only the first ${n} rows fit. Narrow the query (WHERE, LIMIT, fewer columns) to see the rest.`
  const head = { columns: result.columns, rowCount: result.rows.length, truncated: true, note: note(result.rows.length) }
  const rows: unknown[][] = []
  // Room for the note is kept from the start, so a cut result still fits the cap.
  let size = JSON.stringify({ ...head, rows: [] }).length
  let cut = result.truncated
  for (const row of result.rows) {
    const extra = JSON.stringify(row).length + 1
    if (size + extra > maxChars) {
      cut = true
      break
    }
    rows.push(row)
    size += extra
  }
  const out: Record<string, unknown> = { columns: result.columns, rows, rowCount: rows.length, truncated: cut }
  if (cut) out.note = note(rows.length)
  return JSON.stringify(out)
}
