/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apex's own spreadsheet reader for previews: CSV and TSV through the
// shared parser, and the first sheet of an XLSX workbook through
// fflate plus a small reader for the sheet XML. Read-only and capped at
// SHEET_LIMITS, so a huge or hostile file never turns into a huge preview.
import { unzipSync, strFromU8 } from 'fflate'
import { parseCsv, type CsvDelimiter } from './csv'
import { t } from './i18n/core'
import { SHEET_LIMITS, type SheetData } from './files'

/** Parts of a workbook bigger than this (uncompressed) are refused: a preview never needs more. */
export const XLSX_PART_MAX_BYTES = 40_000_000

export function readDelimited(text: string, delimiter?: CsvDelimiter, limits = SHEET_LIMITS): SheetData {
  // One row past the cap tells whether there is more; the total is counted separately.
  const { rows } = parseCsv(text, { delimiter, maxRows: limits.rows + 1 })
  const all = rows.length > limits.rows ? countRows(text) : rows.length
  const totalColumns = rows.reduce((max, r) => Math.max(max, r.length), 0)
  const kept = rows.slice(0, limits.rows).map((r) => r.slice(0, limits.columns))
  return { rows: kept, totalRows: all, totalColumns, truncated: all > limits.rows || totalColumns > limits.columns, sheetName: null, sheetCount: 1 }
}

function countRows(text: string): number {
  // Quote-aware, like the parser: a newline inside quotes doesn't end a row.
  let rows = 0
  let quoted = false
  let content = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') quoted = !quoted
    if (!quoted && ch === '\n') {
      if (content) rows++
      content = false
    } else if (ch !== '\r') content = true
  }
  return rows + (content ? 1 : 0)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e.startsWith('#x')) return safeCodePoint(Number.parseInt(e.slice(2), 16))
    if (e.startsWith('#')) return safeCodePoint(Number.parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? ''
  })
}

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
}

/** "C12" → 2 (zero-based column), or null. */
export function columnIndex(ref: string): number | null {
  const letters = /^([A-Z]{1,3})\d*$/.exec(ref)?.[1]
  if (!letters) return null
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Every <t> run inside one shared-string item, joined (rich text keeps its words, not its styling). */
function runsText(xml: string): string {
  let out = ''
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1] ?? '')
  return out
}

export function readSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runsText(m[1] ?? ''))
}

/** The first sheet's part path from workbook.xml and its relationships; sheet1.xml when they don't say. */
function firstSheet(files: Record<string, Uint8Array>): { path: string; name: string | null; count: number } {
  const workbook = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : ''
  const sheets = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => m[1] ?? '')
  const first = sheets[0] ?? ''
  const name = /\bname="([^"]*)"/.exec(first)?.[1]
  const rid = /\br:id="([^"]*)"/.exec(first)?.[1]
  let path = 'xl/worksheets/sheet1.xml'
  if (rid && files['xl/_rels/workbook.xml.rels']) {
    const rels = strFromU8(files['xl/_rels/workbook.xml.rels'])
    for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const attrs = m[1] ?? ''
      if (/\bId="([^"]*)"/.exec(attrs)?.[1] !== rid) continue
      const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1]
      if (target) path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    }
  }
  return { path, name: name ? decodeXml(name) : null, count: Math.max(1, sheets.length) }
}

/** The cells of a worksheet's XML, capped; shared strings resolve by index. */
export function readSheetXml(xml: string, shared: readonly string[], limits = SHEET_LIMITS): Omit<SheetData, 'sheetName' | 'sheetCount'> {
  const rows: string[][] = []
  let totalRows = 0
  let totalColumns = 0
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    totalRows++
    const index = Number(/\br="(\d+)"/.exec(rowMatch[1] ?? '')?.[1] ?? totalRows)
    // Rows can be sparse (r skips numbers); the preview keeps the gaps.
    if (Number.isFinite(index) && index > totalRows) totalRows = index
    const body = rowMatch[2] ?? ''
    const cells: string[] = []
    let next = 0
    for (const cell of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? ''
      const col = columnIndex(/\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '') ?? next
      next = col + 1
      totalColumns = Math.max(totalColumns, col + 1)
      if (col >= limits.columns) continue
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? 'n'
      const inner = cell[2] ?? ''
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
      let value = ''
      if (type === 's') value = shared[Number(raw)] ?? ''
      else if (type === 'inlineStr') value = runsText(inner)
      else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : ''
      else value = decodeXml(raw ?? '')
      while (cells.length < col) cells.push('')
      cells[col] = value
    }
    if (totalRows <= limits.rows) {
      while (rows.length < totalRows - 1) rows.push([])
      rows.push(cells)
    }
  }
  return { rows: rows.slice(0, limits.rows), totalRows, totalColumns, truncated: totalRows > limits.rows || totalColumns > limits.columns }
}

/** The first sheet of an XLSX workbook. Throws a plain sentence when it can't be read. */
export function readXlsx(bytes: Uint8Array, limits = SHEET_LIMITS): SheetData {
  const wanted = new Set(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml'])
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!(wanted.has(f.name) || f.name.startsWith('xl/worksheets/'))) return false
        if (f.originalSize > XLSX_PART_MAX_BYTES) throw new Error('too large')
        return true
      },
    })
  } catch (err) {
    throw new Error(err instanceof Error && err.message === 'too large' ? t('files.error.workbookTooLarge') : t('files.error.notWorkbook'))
  }
  const sheet = firstSheet(files)
  const xml = files[sheet.path] ?? files['xl/worksheets/sheet1.xml']
  if (!xml) throw new Error(t('files.error.noSheet'))
  const shared = files['xl/sharedStrings.xml'] ? readSharedStrings(strFromU8(files['xl/sharedStrings.xml'])) : []
  return { ...readSheetXml(strFromU8(xml), shared, limits), sheetName: sheet.name, sheetCount: sheet.count }
}

/** The column header for a zero-based index: A, B, …, Z, AA. */
export function columnName(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}
