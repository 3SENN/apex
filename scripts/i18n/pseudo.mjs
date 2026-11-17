#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// The en-XA pseudo-locale preview: `node scripts/i18n/pseudo.mjs "Some text"` prints the
// pseudo form; `--key <key>` prints one catalogue entry; `--json` writes the
// whole pseudo catalogue to stdout. In the app, turn on atelier://flags ›
// Pseudo-locale or start with ATELIER_PSEUDO_LOCALE=1. Node strips the types of
// src/shared/i18n/pseudo.ts, which imports nothing.
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { merged, readLanguage } from './catalogue.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const i18n = join(here, '..', '..', 'src', 'shared', 'i18n')
const { pseudoize } = await import(pathToFileURL(join(i18n, 'pseudo.ts')).href)

const args = process.argv.slice(2)
if (args[0] === '--json') {
  const en = merged(readLanguage(join(i18n, 'en')).files)
  const out = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, pseudoize(v)]))
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
} else if (args[0] === '--key') {
  const en = merged(readLanguage(join(i18n, 'en')).files)
  const text = en[args[1] ?? '']
  if (text === undefined) {
    console.error(`No English key ${args[1] ?? '(none given)'}.`)
    process.exit(1)
  }
  console.log(pseudoize(text))
} else if (args.length > 0) {
  console.log(pseudoize(args.join(' ')))
} else {
  console.log('Usage: pseudo.mjs "text" | --key <catalogue key> | --json')
}
