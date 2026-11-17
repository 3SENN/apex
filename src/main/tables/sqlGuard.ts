/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The tables SQL guard (CH-43): what query_table and
// write_table accept. One statement only; comments and string literals are
// blanked before any keyword is read, so `-- DROP` or 'ATTACH' inside a
// string never counts, and a second statement hidden after a `;` is refused
// (node:sqlite's prepare would quietly run only the first). The read path
// also runs on a separate read-only connection, so a write that slipped past
// these rules still fails in SQLite itself.

import { BRAND_NAME } from '@shared/branding'
export type SqlKind = 'read' | 'write'

export type SqlVerdict =
  | { ok: true; kind: SqlKind; destructive: boolean; statement: string; table: string | null }
  | { ok: false; reason: string }

/** Never run, whatever the tool: they reach outside the table files or change how SQLite runs. */
const REFUSED_KEYWORDS = ['ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'TRIGGER', 'VIRTUAL']
const REFUSED_FUNCTIONS = ['LOAD_EXTENSION', 'READFILE', 'WRITEFILE', 'EDIT', 'FTS3_TOKENIZER']
const WRITE_VERBS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER'])

/**
 * The SQL with comments removed and the insides of quoted strings and
 * identifiers blanked (kept as quotes of the same length, so positions hold).
 * Returns null for an unterminated string or comment.
 */
export function maskSql(sql: string): string | null {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i] as string
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      const stop = end < 0 ? sql.length : end
      out += ' '.repeat(stop - i)
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) return null
      out += ' '.repeat(end + 2 - i)
      i = end + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch
      let j = i + 1
      for (;;) {
        if (j >= sql.length) return null
        if (sql[j] === close) {
          // A doubled quote is an escaped quote inside the literal.
          if (close !== ']' && sql[j + 1] === close) {
            j += 2
            continue
          }
          break
        }
        j++
      }
      out += ch + '_'.repeat(j - i - 1) + close
      i = j + 1
      continue
    }
    out += ch
    i++
  }
  return out
}

function words(masked: string): string[] {
  return masked.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? []
}

/** The verb of the statement WITH leads to: the first top-level keyword after the CTE list. */
function verbAfterWith(masked: string): string | null {
  let depth = 0
  const upper = masked.toUpperCase()
  const re = /[()]|[A-Z_][A-Z0-9_]*/g
  let m: RegExpExecArray | null
  let seenAs = false
  while ((m = re.exec(upper))) {
    const token = m[0]
    if (token === '(') depth++
    else if (token === ')') depth--
    else if (depth === 0) {
      if (token === 'AS') seenAs = true
      else if (seenAs && (token === 'SELECT' || token === 'VALUES' || WRITE_VERBS.has(token))) return token
    }
  }
  return null
}

/** The table a write names, best effort (for the approval card); null when it can't tell. */
export function targetTable(sql: string): string | null {
  const masked = maskSql(sql)
  if (masked === null) return null
  const ident = String.raw`((?:[A-Za-z_][A-Za-z0-9_]*|"[^"]+"|\[[^\]]+\]|\x60[^\x60]+\x60)(?:\s*\.\s*(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]+"))?)`
  const patterns = [
    new RegExp(String.raw`\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+` + ident, 'i'),
    new RegExp(String.raw`\bREPLACE\s+INTO\s+` + ident, 'i'),
    new RegExp(String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?` + ident, 'i'),
    new RegExp(String.raw`\bDELETE\s+FROM\s+` + ident, 'i'),
    new RegExp(String.raw`\b(?:DROP|ALTER|CREATE)\s+(?:TEMP(?:ORARY)?\s+)?(?:TABLE|VIEW|INDEX)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?` + ident, 'i'),
  ]
  for (const re of patterns) {
    // Match on the masked text for position, read the name from the original.
    const hit = re.exec(masked)
    if (hit?.[1]) {
      const start = hit.index + hit[0].length - hit[1].length
      return sql.slice(start, start + hit[1].length).replace(/\s*\.\s*(?=[A-Za-z_"[`])/, '.').replace(/["[\]`]/g, '')
    }
  }
  return null
}

/** Judges one statement for the tables tools. */
export function classifySql(sql: string): SqlVerdict {
  const trimmed = sql.trim()
  if (!trimmed) return { ok: false, reason: 'The statement is empty.' }
  if (trimmed.length > 100_000) return { ok: false, reason: 'The statement is too long.' }
  const masked = maskSql(trimmed)
  if (masked === null) return { ok: false, reason: 'A string or comment is not closed.' }
  // One statement: a single trailing semicolon is fine, anything after one is not.
  const semi = masked.indexOf(';')
  if (semi >= 0 && masked.slice(semi + 1).replace(/;/g, '').trim() !== '') return { ok: false, reason: 'Send one statement at a time.' }
  const statement = semi >= 0 ? trimmed.slice(0, semi).trim() : trimmed
  const body = semi >= 0 ? masked.slice(0, semi) : masked
  const tokens = words(body)
  const refusedWord = tokens.find((w) => REFUSED_KEYWORDS.includes(w))
  if (refusedWord) return { ok: false, reason: `${refusedWord} is never allowed on tables.` }
  const fn = REFUSED_FUNCTIONS.find((f) => new RegExp(String.raw`\b${f}\s*\(`, 'i').test(body))
  if (fn) return { ok: false, reason: `${fn.toLowerCase()}() is never allowed on tables.` }
  if (/\bsqlite_\w+/i.test(body) && tokens.some((w) => WRITE_VERBS.has(w))) return { ok: false, reason: "SQLite's own tables can't be changed." }
  if (/\b_atelier\w*/i.test(body)) return { ok: false, reason: `${BRAND_NAME}'s own bookkeeping table is off limits.` }

  const first = tokens[0] ?? ''
  const verb = first === 'WITH' ? verbAfterWith(body) : first
  if (verb === 'SELECT' || verb === 'VALUES') return { ok: true, kind: 'read', destructive: false, statement, table: null }
  if (verb === null || !WRITE_VERBS.has(verb)) return { ok: false, reason: 'Only SELECT, WITH, INSERT, UPDATE, DELETE, REPLACE, CREATE, ALTER and DROP statements are supported.' }
  const hasWhere = tokens.includes('WHERE')
  const replaces = verb === 'REPLACE' || (verb === 'INSERT' && /\bINSERT\s+OR\s+REPLACE\b/i.test(body))
  const destructive = verb === 'DELETE' || verb === 'DROP' || verb === 'ALTER' || replaces || (verb === 'UPDATE' && !hasWhere)
  return { ok: true, kind: 'write', destructive, statement, table: targetTable(statement) }
}

/** query_table's rule: a read, or the reason it isn't one. */
export function checkRead(sql: string): { ok: true; statement: string } | { ok: false; reason: string } {
  const verdict = classifySql(sql)
  if (!verdict.ok) return verdict
  if (verdict.kind !== 'read') return { ok: false, reason: 'query_table only reads: use a single SELECT or WITH statement, or write_table to change data.' }
  return { ok: true, statement: verdict.statement }
}
