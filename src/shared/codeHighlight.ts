/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A small, dependency-free code highlighter for the file viewer:
// comments, strings, numbers, keywords and JSON keys, per language family.
// It never builds HTML; the chrome renders the tokens as spans.
import type { CodeLanguage } from './fileKinds'

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'key' | 'tag' | 'attr'

export interface CodeToken {
  kind: TokenKind
  text: string
}

/** Past this many characters the rest is shown plain, so a huge file stays responsive. */
export const HIGHLIGHT_MAX_CHARS = 200_000

const KEYWORDS: Partial<Record<CodeLanguage, readonly string[]>> = {
  js: ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'var', 'void', 'while', 'yield'],
  py: ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'end', 'except', 'False', 'finally', 'for', 'from', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nil', 'not', 'or', 'pass', 'raise', 'return', 'self', 'True', 'try', 'while', 'with', 'yield'],
  sh: ['case', 'do', 'done', 'echo', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'return', 'then', 'while'],
  sql: ['and', 'as', 'by', 'create', 'delete', 'desc', 'asc', 'from', 'group', 'having', 'insert', 'into', 'join', 'left', 'limit', 'not', 'null', 'on', 'or', 'order', 'right', 'select', 'set', 'table', 'update', 'values', 'where', 'with'],
  c: ['break', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'false', 'fn', 'for', 'func', 'if', 'impl', 'import', 'int', 'let', 'match', 'mut', 'new', 'nil', 'null', 'package', 'private', 'pub', 'public', 'return', 'self', 'static', 'struct', 'switch', 'this', 'true', 'try', 'use', 'var', 'void', 'while'],
  css: ['important'],
  yaml: ['true', 'false', 'null', 'yes', 'no'],
  json: ['true', 'false', 'null'],
}

interface Family {
  line: string | null
  block: [string, string] | null
  quotes: string
}

const FAMILIES: Record<CodeLanguage, Family> = {
  js: { line: '//', block: ['/*', '*/'], quotes: `'"\`` },
  json: { line: null, block: null, quotes: '"' },
  py: { line: '#', block: null, quotes: `'"` },
  sh: { line: '#', block: null, quotes: `'"` },
  css: { line: null, block: ['/*', '*/'], quotes: `'"` },
  xml: { line: null, block: ['<!--', '-->'], quotes: `'"` },
  yaml: { line: '#', block: null, quotes: `'"` },
  sql: { line: '--', block: ['/*', '*/'], quotes: `'"` },
  c: { line: '//', block: ['/*', '*/'], quotes: `'"` },
  plain: { line: null, block: null, quotes: '' },
}

const WORD = /[A-Za-z_$][\w$]*/y
const NUMBER = /-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/y

function push(out: CodeToken[], kind: TokenKind, text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.kind === kind) last.text += text
  else out.push({ kind, text })
}

/** Splits code into tokens; concatenating their text gives back the input exactly. */
export function highlight(code: string, language: CodeLanguage): CodeToken[] {
  const out: CodeToken[] = []
  const text = code.length > HIGHLIGHT_MAX_CHARS ? code.slice(0, HIGHLIGHT_MAX_CHARS) : code
  const fam = FAMILIES[language]
  const keywords = new Set(language === 'sql' ? (KEYWORDS.sql ?? []).flatMap((k) => [k, k.toUpperCase()]) : (KEYWORDS[language] ?? []))
  let i = 0
  while (i < text.length) {
    const rest = text.startsWith.bind(text)
    if (language === 'xml' && text[i] === '<' && !rest('<!--', i)) {
      // A tag: its name, then attributes and their quoted values.
      const end = text.indexOf('>', i)
      const stop = end === -1 ? text.length : end + 1
      const tag = text.slice(i, stop)
      const name = /^<\/?[\w:.-]*/.exec(tag)?.[0] ?? '<'
      push(out, 'tag', name)
      let j = name.length
      while (j < tag.length) {
        const ch = tag[j] as string
        if (ch === '"' || ch === "'") {
          const close = tag.indexOf(ch, j + 1)
          const to = close === -1 ? tag.length : close + 1
          push(out, 'string', tag.slice(j, to))
          j = to
        } else if (/[\w:-]/.test(ch)) {
          const m = /^[\w:.-]+/.exec(tag.slice(j))?.[0] ?? ch
          push(out, 'attr', m)
          j += m.length
        } else {
          push(out, ch === '>' || ch === '/' ? 'tag' : 'plain', ch)
          j++
        }
      }
      i = stop
      continue
    }
    if (fam.block && rest(fam.block[0], i)) {
      const close = text.indexOf(fam.block[1], i + fam.block[0].length)
      const to = close === -1 ? text.length : close + fam.block[1].length
      push(out, 'comment', text.slice(i, to))
      i = to
      continue
    }
    if (fam.line && rest(fam.line, i) && (language !== 'sh' || i === 0 || /\s/.test(text[i - 1] as string))) {
      const nl = text.indexOf('\n', i)
      const to = nl === -1 ? text.length : nl
      push(out, 'comment', text.slice(i, to))
      i = to
      continue
    }
    const ch = text[i] as string
    if (fam.quotes.includes(ch)) {
      let j = i + 1
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\') j++
        else if (text[j] === '\n' && ch !== '`') break
        j++
      }
      const to = Math.min(text.length, j + 1)
      const literal = text.slice(i, to)
      // A JSON (or YAML) string followed by ':' is a key.
      const isKey = (language === 'json' || language === 'yaml') && /^\s*:/.test(text.slice(to, to + 8))
      push(out, isKey ? 'key' : 'string', literal)
      i = to
      continue
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(text[i + 1] ?? '') && !/[\w$]/.test(text[i - 1] ?? ''))) {
      NUMBER.lastIndex = i
      const m = NUMBER.exec(text)
      if (m && !/[\w$]/.test(text[i - 1] ?? '')) {
        push(out, 'number', m[0])
        i += m[0].length
        continue
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      WORD.lastIndex = i
      const word = WORD.exec(text)?.[0] ?? ch
      const yamlKey = language === 'yaml' && /^\s*:/.test(text.slice(i + word.length, i + word.length + 4)) && /(^|\n)\s*(- )?$/.test(text.slice(Math.max(0, i - 80), i))
      push(out, yamlKey ? 'key' : keywords.has(word) ? 'keyword' : 'plain', word)
      i += word.length
      continue
    }
    push(out, 'plain', ch)
    i++
  }
  if (text.length < code.length) push(out, 'plain', code.slice(text.length))
  return out
}
