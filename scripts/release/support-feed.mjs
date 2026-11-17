#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// Writes atelier-support.json, the release asset the updater reads:
// versions below a given one are told they're no longer supported and asked
// to update. This is how a bad release is rolled back: ship a fixed, higher
// version, then list it here so everyone below it is prompted (docs/release.md).
//
//   node scripts/release/support-feed.mjs [--out dist/atelier-support.json]
//   node scripts/release/support-feed.mjs --below 0.3.0 --message "…"   add an entry for this run
//
// The committed list is scripts/release/support.json ({ "unsupported": [...] }).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { supportFeed } from './checks.mjs'
import { DIST, REPO } from './paths.mjs'

export const SUPPORT_SOURCE = join(REPO, 'scripts', 'release', 'support.json')

/** Reads the committed list, adds `extra`, validates, and writes the feed to `out`. */
export function writeSupportFeed({ out = join(DIST, 'atelier-support.json'), source = SUPPORT_SOURCE, extra = [] } = {}) {
  const committed = JSON.parse(readFileSync(source, 'utf8'))
  if (!Array.isArray(committed?.unsupported)) throw new Error(`${source} needs an "unsupported" array`)
  const feed = supportFeed([...committed.unsupported, ...extra])
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(feed, null, 2) + '\n')
  return { out, feed }
}

function parseArgs(argv) {
  const opts = { out: undefined, extra: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out = resolve(argv[++i] ?? '')
    else if (a === '--below') opts.extra.push({ below: argv[++i] })
    else if (a === '--message') {
      const last = opts.extra.at(-1)
      if (!last) throw new Error('--message follows a --below')
      last.message = argv[++i]
    } else throw new Error(`unknown option ${a}`)
  }
  return opts
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { out, feed } = writeSupportFeed(parseArgs(process.argv.slice(2)))
    console.log(`support feed: ${feed.unsupported.length} unsupported range(s) in ${out}`)
  } catch (err) {
    console.error(`support-feed: ${err.message}`)
    process.exit(1)
  }
}
