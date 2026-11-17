#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// Writes SHA256SUMS for a release's installers and update archives.
//
//   node scripts/release/checksums.mjs [dir]     default dist/; writes <dir>/SHA256SUMS
//                                                for package.json's version
//
// Check a download with `shasum -a 256 -c SHA256SUMS --ignore-missing` (macOS)
// or `sha256sum -c SHA256SUMS --ignore-missing` (Linux).

import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { CHECKSUMMED, checksumLines, ofVersion } from './checks.mjs'
import { DIST, packageJson } from './paths.mjs'

function sha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** Hashes `version`'s installers in `dir` and writes SHA256SUMS; returns its path and the files. */
export async function writeChecksums(dir = DIST, version = packageJson().version) {
  const names = ofVersion(readdirSync(dir), version).filter((n) => CHECKSUMMED.test(n) && statSync(join(dir, n)).isFile())
  if (!names.length) throw new Error(`no ${version} installers in ${dir}`)
  const files = await Promise.all(names.map(async (name) => ({ name, sha256: await sha256(join(dir, name)) })))
  const out = join(dir, 'SHA256SUMS')
  writeFileSync(out, checksumLines(files))
  return { out, files }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { out, files } = await writeChecksums(resolve(process.argv[2] ?? DIST))
    console.log(`checksums: ${files.length} files in ${out}`)
  } catch (err) {
    console.error(`checksums: ${err.message}`)
    process.exit(1)
  }
}
