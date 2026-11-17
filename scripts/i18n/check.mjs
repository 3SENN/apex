#!/usr/bin/env node
/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// The i18n catalogue check: `node scripts/i18n/check.mjs [--strict]`. Fails on a
// key defined twice, a Dutch key English lacks, a placeholder Dutch drops or
// adds, a broken plural, or the app's name written out: messages say {brand},
// which the i18n layer fills in from the branding (src/shared/i18n/core.ts), so
// either language may use it where it reads best. Untranslated keys are listed
// per area and only fail with --strict.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { merged, placeholders, pluralProblems, readLanguage } from './catalogue.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'shared', 'i18n')
const strict = process.argv.includes('--strict')
const errors = []

const en = readLanguage(join(root, 'en'))
const nl = readLanguage(join(root, 'nl'))
for (const where of [...en.unparsed, ...nl.unparsed]) errors.push(`can't read the entry at ${where} (one quoted key and message per line)`)

const seen = new Map()
for (const [file, entries] of Object.entries(en.files)) {
  for (const key of Object.keys(entries)) {
    if (seen.has(key)) errors.push(`${key} is defined in both en/${seen.get(key)} and en/${file}`)
    seen.set(key, file)
  }
}
const EN = merged(en.files)
const NL = merged(nl.files)

// The branding's names (branding/*/branding.json) never appear in a message, nor do Apex's characters (TRADEMARKS.md;
// Sage is also a colour, so the colour pickers keep it).
const NAMES = /\b(Apex|Summit|Pip|Juniper|Bolt|Mochi|Pepper)\b/
for (const [lang, catalogue] of [['en', EN], ['nl', NL]]) {
  for (const [key, text] of Object.entries(catalogue)) if (NAMES.test(text)) errors.push(`${lang} ${key} writes "${NAMES.exec(text)[1]}"; use {brand} for the app's name, and no character's name`)
}
/** The placeholders a call site passes: {brand} is the i18n layer's own. */
const passed = (text) => placeholders(text).filter((p) => p !== 'brand')

for (const [key, text] of Object.entries(EN)) for (const p of pluralProblems(text, 'en')) errors.push(`en ${key}: ${p}`)
for (const [key, text] of Object.entries(NL)) {
  if (!(key in EN)) {
    errors.push(`nl ${key} has no English`)
    continue
  }
  const a = passed(EN[key]).join(', ')
  const b = passed(text).join(', ')
  if (a !== b) errors.push(`nl ${key}: placeholders {${b}} differ from English {${a}}`)
  for (const p of pluralProblems(text, 'nl')) errors.push(`nl ${key}: ${p}`)
}

const missing = new Map()
for (const key of Object.keys(EN)) {
  if (key in NL) continue
  const area = key.split('.')[0]
  missing.set(area, (missing.get(area) ?? 0) + 1)
}
const total = Object.keys(EN).length
const done = total - [...missing.values()].reduce((a, b) => a + b, 0)
console.log(`English: ${total} keys. Dutch: ${done} (${Math.round((done / Math.max(1, total)) * 100)}%).`)
if (missing.size > 0) {
  console.log(`Untranslated by area: ${[...missing].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} ${n}`).join(', ')}`)
  if (strict) errors.push(`${total - done} keys have no Dutch yet`)
}

if (errors.length > 0) {
  console.error(`\n${errors.length} problem${errors.length === 1 ? '' : 's'}:`)
  for (const e of errors.slice(0, 200)) console.error(`  ${e}`)
  process.exit(1)
}
console.log('The catalogue is consistent.')
