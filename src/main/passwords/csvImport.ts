/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseCsv, type CsvDelimiter } from '@shared/csv'
import type { CsvMapping, CsvPreview, CsvSourceFormat } from '@shared/passwords'
import type { LoginInput } from './vault'

// Password CSV import (ST-41, ON-04): which app made the file, which
// columns hold the URL, username and password, a masked preview, and the
// rows the vault should decide on. Pure; the temp-file handling is in
// importFiles.ts. Rows are never logged.

/** How many rows the preview shows. */
export const PREVIEW_ROWS = 5
/** The largest CSV Atelier reads (a password export is a few hundred KB at most). */
export const CSV_MAX_BYTES = 20 * 1024 * 1024
export const MASK = '••••••••'

const norm = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Recognizes the export formats of Chrome, Firefox, Safari/Passwords, 1Password and Bitwarden from the header row. */
export function guessFormat(headers: readonly string[]): CsvSourceFormat {
  const h = new Set(headers.map(norm))
  if (h.has('loginuri') && h.has('loginpassword')) return h.has('reprompt') || h.has('folder') || h.has('fields') ? 'bitwarden' : '1password'
  if (h.has('httprealm') || h.has('formactionorigin') || h.has('timepasswordchanged')) return 'firefox'
  if (h.has('title') && h.has('url') && h.has('password') && (h.has('favorite') || h.has('archived') || h.has('tags'))) return '1password'
  if (h.has('title') && h.has('url') && h.has('username') && h.has('password')) return 'safari'
  if (h.has('name') && h.has('url') && h.has('username') && h.has('password')) return 'chrome'
  if (h.has('url') && h.has('username') && h.has('password')) return 'firefox'
  return 'unknown'
}

// Header names per field, best first: exact matches win over partial ones.
const CANDIDATES: Record<keyof CsvMapping, string[]> = {
  url: ['loginuri', 'url', 'website', 'uri', 'site', 'origin', 'loginurl', 'address', 'link', 'hostname', 'domain'],
  username: ['loginusername', 'username', 'user', 'login', 'email', 'emailaddress', 'account', 'userid'],
  password: ['loginpassword', 'password', 'pass', 'passwd', 'pwd'],
}

/** Guesses the URL, username and password columns from the headers; null where nothing fits. */
export function guessMapping(headers: readonly string[]): CsvMapping {
  const names = headers.map(norm)
  const taken = new Set<number>()
  const pick = (field: keyof CsvMapping): number | null => {
    for (const exact of [true, false]) {
      for (const want of CANDIDATES[field]) {
        const index = names.findIndex((n, i) => !taken.has(i) && (exact ? n === want : n.includes(want) && !n.includes('totp') && !n.includes('otp')))
        if (index >= 0) {
          taken.add(index)
          return index
        }
      }
    }
    return null
  }
  // The password first, so "login_password" is never taken as a username.
  const password = pick('password')
  const url = pick('url')
  const username = pick('username')
  return { url, username, password }
}

/** Whether the mapping names three distinct columns that exist (the username may be left out). */
export function mappingComplete(m: CsvMapping, columns: number): boolean {
  const used = [m.url, m.password, m.username].filter((x): x is number => x !== null)
  return m.url !== null && m.password !== null && used.every((i) => i < columns) && new Set(used).size === used.length
}

/** A login URL from an export cell: the first of several URIs, with https assumed when the scheme is missing. */
export function loginUrl(cell: string): string {
  const first = cell.split(/[\n,]/)[0]?.trim() ?? ''
  if (!first) return ''
  return /^[a-z][a-z0-9+.-]*:/i.test(first) ? first : `https://${first}`
}

/** A Bitwarden or 1Password row that isn't a login (a card, a note, an identity) is left out. */
function isLoginRow(row: readonly string[], typeColumn: number): boolean {
  if (typeColumn < 0) return true
  const type = (row[typeColumn] ?? '').trim().toLowerCase()
  return type === '' || type === 'login' || type === '1'
}

export interface ParsedCsv {
  delimiter: CsvDelimiter
  columns: string[]
  /** Data rows, blank lines and non-login rows left out. */
  rows: string[][]
  format: CsvSourceFormat
}

export function readPasswordCsv(text: string): ParsedCsv {
  const { delimiter, rows } = parseCsv(text)
  const [header = [], ...body] = rows
  const columns = header.map((h) => h.trim())
  const format = guessFormat(columns)
  const typeColumn = format === 'bitwarden' || format === '1password' ? columns.findIndex((c) => norm(c) === 'type') : -1
  const data = body.filter((r) => r.some((cell) => cell.trim() !== '') && isLoginRow(r, typeColumn))
  return { delimiter, columns, rows: data, format }
}

/** The rows as logins for the vault; rows missing a URL or password stay in, so the vault reports them skipped. */
export function rowsToLogins(rows: readonly (readonly string[])[], m: CsvMapping): LoginInput[] {
  return rows.map((r) => ({
    url: m.url === null ? '' : loginUrl(r[m.url] ?? ''),
    username: m.username === null ? '' : (r[m.username] ?? '').trim(),
    password: m.password === null ? '' : (r[m.password] ?? ''),
  }))
}

/** Rows that will import: a secure (https or this machine) URL and a password. */
export function importableCount(rows: readonly (readonly string[])[], m: CsvMapping, isSecure: (url: string) => boolean): number {
  if (m.url === null || m.password === null) return 0
  return rowsToLogins(rows, m).filter((l) => l.password !== '' && isSecure(l.url)).length
}

/** The preview the mapping step shows: the first rows, with the mapped password column masked. */
export function buildPreview(
  token: string,
  fileName: string,
  parsed: ParsedCsv,
  mapping: CsvMapping,
  isSecure: (url: string) => boolean,
): CsvPreview {
  const sample = parsed.rows.slice(0, PREVIEW_ROWS).map((row) =>
    parsed.columns.map((_, i) => (i === mapping.password ? (row[i] ? MASK : '') : (row[i] ?? '').slice(0, 200))),
  )
  return {
    token,
    fileName,
    delimiter: parsed.delimiter,
    columns: parsed.columns,
    sample,
    rowCount: parsed.rows.length,
    format: parsed.format,
    mapping,
    importable: mappingComplete(mapping, parsed.columns.length) ? importableCount(parsed.rows, mapping, isSecure) : 0,
  }
}
