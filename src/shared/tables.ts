/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Contract for CSV files imported into SQLite
// tables, read by the agent's list_tables and query_table and
// changed only through write_table with a table-write request card.
// Parsing reuses the RFC 4180 parser in src/shared/csv.ts.
import type { Owner } from './services'

export type TableColumnType = 'INTEGER' | 'REAL' | 'TEXT'
export const TABLE_COLUMN_TYPES = ['INTEGER', 'REAL', 'TEXT'] as const satisfies readonly TableColumnType[]

export interface TableColumn {
  name: string
  type: TableColumnType
}

export interface TableSummary {
  id: string
  name: string
  owner: Owner
  rowCount: number
  columns: TableColumn[]
  updatedAt: number
}

/** A picked CSV, parsed and typed but not imported yet; `token` confirms it. */
export interface CsvPreview {
  token: string
  fileName: string
  delimiter: string
  columns: TableColumn[]
  sample: string[][]
  rowCount: number
  /** Whether the first row was read as column names; confirmImport can change it. */
  hasHeader: boolean
}

export interface TablesService {
  list(owner?: Owner): TableSummary[]
  get(id: string): TableSummary
  pickCsv(owner?: Owner): Promise<CsvPreview | null>
  /** `hasHeader` overrides the detected header; the column count must match the preview's. */
  confirmImport(token: string, input: { name: string; columns: TableColumn[]; hasHeader?: boolean }): Promise<TableSummary>
  /** The proposed columns (names and types) for a header choice, for the preview's "First row is column names" switch. */
  previewColumns(token: string, hasHeader: boolean): TableColumn[]
  rows(id: string, q: { offset: number; limit: number; sort?: string; desc?: boolean }): { columns: string[]; rows: unknown[][]; total: number }
  rename(id: string, name: string): TableSummary
  remove(id: string): void
  exportCsv(id: string): Promise<string | null>
}


export const TABLE_LIMITS = {
  /** The largest CSV Atelier imports. */
  fileBytes: 50 * 1024 * 1024,
  rows: 1_000_000,
  columns: 200,
  /** Rows shown in the import preview. */
  sampleRows: 20,
  /** query_table returns at most this many rows and characters. */
  queryRows: 500,
  queryChars: 50_000,
} as const

const RESERVED = new Set(['select', 'from', 'where', 'table', 'index', 'order', 'group', 'by', 'insert', 'update', 'delete', 'drop', 'create', 'alter', 'join', 'on', 'as', 'and', 'or', 'not', 'null', 'values', 'into', 'limit', 'offset', 'having', 'union', 'case', 'when', 'then', 'else', 'end', 'default', 'check', 'primary', 'key', 'references', 'transaction', 'rowid'])

/**
 * A name the agent can use in SQL without quoting: lower-case letters,
 * digits and underscores, starting with a letter. "Order date" becomes
 * order_date; a reserved word or an empty name gets a suffix or a fallback.
 */
export function sqlIdentifier(name: string, fallback = 'column'): string {
  let id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  if (!id) id = fallback
  if (/^[0-9]/.test(id)) id = `${fallback}_${id}`
  if (RESERVED.has(id) || id.startsWith('sqlite_') || id.startsWith('_atelier')) id = `${id}_`
  return id
}

/** Column identifiers for a header row: sanitised, and unique by suffix. */
export function columnIdentifiers(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map((name, i) => {
    const base = sqlIdentifier(name, `column_${i + 1}`)
    let id = base
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`
    used.add(id)
    return id
  })
}
