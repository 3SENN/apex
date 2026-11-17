/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The shared RFC 4180 CSV reader: password imports and CSV
// tables both use it, and nothing else parses CSV. Handles a BOM,
// quoted fields with doubled quotes, CRLF or LF line ends and newlines inside
// quotes.

export type CsvDelimiter = ',' | ';' | '\t'

export interface CsvParseOptions {
  /** Detected from the first line when omitted. */
  delimiter?: CsvDelimiter
  /** Stops after this many rows (a preview). */
  maxRows?: number
}

export interface CsvParseResult {
  delimiter: CsvDelimiter
  rows: string[][]
}

/** The delimiter the first line uses most outside quotes; ',' on a tie. */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (const ch of text.replace(/^﻿/, '')) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && (ch === ',' || ch === ';' || ch === '\t')) counts[ch]++
  }
  return counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : counts['\t'] > counts[','] ? '\t' : ','
}

/** Parses CSV text into rows of fields. A trailing empty line is not a row. */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvParseResult {
  const body = text.replace(/^﻿/, '')
  const delimiter = options.delimiter ?? detectDelimiter(body)
  const max = options.maxRows ?? Number.POSITIVE_INFINITY
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const endRow = (): void => {
    row.push(field)
    field = ''
    rows.push(row)
    row = []
  }
  while (i < body.length && rows.length < max) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else {
        field += ch
      }
      i++
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\r' || ch === '\n') {
      endRow()
      if (ch === '\r' && body[i + 1] === '\n') i++
    } else field += ch
    i++
  }
  if (rows.length < max && (field !== '' || row.length > 0)) endRow()
  return { delimiter, rows }
}

/** One field, quoted only when it has to be. */
export function csvField(value: string, delimiter: CsvDelimiter = ','): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Rows back to CSV text with CRLF line ends. */
export function toCsv(rows: readonly (readonly string[])[], delimiter: CsvDelimiter = ','): string {
  return rows.map((r) => r.map((v) => csvField(v, delimiter)).join(delimiter)).join('\r\n')
}

// Streaming, header detection and type inference for CSV tables

/**
 * The same RFC 4180 rules as parseCsv, fed in chunks, so a 50 MB file never
 * needs one string or one array of every row. `push` returns the rows that
 * ended inside the chunk; `end` returns the last one.
 */
export class CsvStreamParser {
  readonly delimiter: CsvDelimiter
  #row: string[] = []
  #field = ''
  #quoted = false
  /** A quote seen at the end of a chunk: it closes the field or doubles, depending on the next char. */
  #quotePending = false
  #crPending = false
  #first = true

  constructor(delimiter: CsvDelimiter) {
    this.delimiter = delimiter
  }

  push(chunk: string): string[][] {
    const rows: string[][] = []
    let text = chunk
    if (this.#first) {
      text = text.replace(/^﻿/, '')
      this.#first = false
    }
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string
      if (this.#crPending) {
        this.#crPending = false
        if (ch === '\n') continue
      }
      if (this.#quotePending) {
        this.#quotePending = false
        if (ch === '"') {
          this.#field += '"'
          continue
        }
        this.#quoted = false
      }
      if (this.#quoted) {
        if (ch === '"') this.#quotePending = true
        else this.#field += ch
        continue
      }
      if (ch === '"' && this.#field === '') this.#quoted = true
      else if (ch === this.delimiter) {
        this.#row.push(this.#field)
        this.#field = ''
      } else if (ch === '\r' || ch === '\n') {
        rows.push(this.#endRow())
        if (ch === '\r') this.#crPending = true
      } else this.#field += ch
    }
    return rows
  }

  end(): string[][] {
    this.#quotePending = false
    if (this.#field !== '' || this.#row.length > 0 || this.#quoted) return [this.#endRow()]
    return []
  }

  #endRow(): string[] {
    this.#row.push(this.#field)
    const row = this.#row
    this.#row = []
    this.#field = ''
    this.#quoted = false
    return row
  }
}

export type CsvValueType = 'INTEGER' | 'REAL' | 'TEXT'

const INTEGER_RE = /^[+-]?\d+$/
const REAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** The narrowest type one non-empty value fits. Leading zeros ("007", a postcode) stay text. */
export function csvValueType(value: string): CsvValueType {
  const v = value.trim()
  if (INTEGER_RE.test(v)) {
    const digits = v.replace(/^[+-]/, '')
    if (digits.length > 1 && digits.startsWith('0')) return 'TEXT'
    return Number.isSafeInteger(Number(v)) ? 'INTEGER' : 'REAL'
  }
  if (REAL_RE.test(v) && !/^[+-]?0\d/.test(v)) return 'REAL'
  return 'TEXT'
}

/** Widens a column's type with one more value: INTEGER, then REAL, then TEXT. Empty values change nothing. */
export function widenType(current: CsvValueType | null, value: string): CsvValueType | null {
  if (value.trim() === '' || current === 'TEXT') return current
  const next = csvValueType(value)
  if (current === null) return next
  if (current === next) return current
  return current === 'INTEGER' && next === 'REAL' ? 'REAL' : next === 'INTEGER' && current === 'REAL' ? 'REAL' : 'TEXT'
}

/**
 * Whether the first row names the columns: every cell filled, no repeats and
 * none of them a number. Most exported files have one, so a header of plain
 * words over plain words counts as one.
 */
export function detectHeader(rows: readonly (readonly string[])[]): boolean {
  const [first] = rows
  if (!first || first.length === 0) return false
  const cells = first.map((c) => c.trim())
  if (cells.some((c) => c === '')) return false
  if (new Set(cells.map((c) => c.toLowerCase())).size !== cells.length) return false
  if (cells.some((c) => csvValueType(c) !== 'TEXT')) return false
  return true
}
