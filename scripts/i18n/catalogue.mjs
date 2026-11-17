/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reads the catalogue fragments as text, for the i18n scripts: Node can't
// import the TypeScript fragments directly, and the scripts must not need a
// build. Each entry is a single-quoted key and a quoted message on one line,
// which is how every fragment is written; anything else is reported.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENTRY = /^\s*'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+)+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"),?\s*(?:\/\/.*)?$/
const KEYISH = /^\s*'[a-z][A-Za-z0-9]*\.[^']*':/

function unescape(text) {
  return text.replace(/\\(.)/g, (_, ch) => (ch === 'n' ? '\n' : ch))
}

/** { file: { key: message } } for every fragment in one language folder, plus the lines that didn't parse. */
export function readLanguage(dir) {
  const files = {}
  const unparsed = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.ts') || name === 'index.ts' || name === 'types.ts') continue
    const entries = {}
    const lines = readFileSync(join(dir, name), 'utf8').split('\n')
    lines.forEach((line, i) => {
      const m = ENTRY.exec(line)
      if (m) entries[m[1]] = unescape(m[2] ?? m[3] ?? '')
      else if (KEYISH.test(line)) unparsed.push(`${name}:${i + 1}`)
    })
    files[name] = entries
  }
  return { files, unparsed }
}

export function merged(files) {
  return Object.assign({}, ...Object.values(files))
}

function closing(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return i
  }
  return -1
}

export function pluralCases(body) {
  const cases = new Map()
  let i = 0
  while (i < body.length) {
    const open = body.indexOf('{', i)
    if (open < 0) break
    const end = closing(body, open)
    if (end < 0) break
    cases.set(body.slice(i, open).trim(), body.slice(open + 1, end))
    i = end + 1
  }
  return cases
}

/** Placeholder names in a message, plural variables included, sorted. */
export function placeholders(message) {
  const names = new Set()
  const walk = (text) => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      if (open < 0) return
      const end = closing(text, open)
      if (end < 0) return
      const inner = text.slice(open + 1, end)
      const plural = /^\s*([A-Za-z0-9_]+)\s*,\s*plural\s*,([\s\S]*)$/.exec(inner)
      if (plural) {
        names.add(plural[1])
        for (const body of pluralCases(plural[2]).values()) walk(body)
      } else if (/^\s*[A-Za-z0-9_]+\s*$/.test(inner)) names.add(inner.trim())
      i = end + 1
    }
  }
  walk(message)
  return [...names].sort()
}

export function pluralProblems(message, locale) {
  const allowed = new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories)
  const problems = []
  const re = /\{\s*[A-Za-z0-9_]+\s*,\s*plural\s*,/g
  for (let m = re.exec(message); m; m = re.exec(message)) {
    const end = closing(message, m.index)
    if (end < 0) {
      problems.push('unclosed plural')
      continue
    }
    const cases = pluralCases(message.slice(m.index + m[0].length, end))
    if (!cases.has('other')) problems.push('no other case')
    for (const name of cases.keys()) if (!/^=\d+$/.test(name) && !allowed.has(name)) problems.push(`"${name}" is not a ${locale} plural category`)
  }
  return problems
}
