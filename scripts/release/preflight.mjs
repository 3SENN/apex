#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// The signing preflight, on its own (npm run package starts with it; release.mjs
// runs the same before building): the macOS signing mode the environment picks,
// the identity resolved to one SHA-1, and in the passkeys mode the provisioning
// profile decoded and checked (entitlements.mjs). Nothing is built or signed.
// It reads the real environment only (release.mjs loads internal/release.env first).
//
//   node scripts/release/preflight.mjs

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { builderConfig } from './builderConfig.mjs'
import { BASE_ENTITLEMENTS, isRestricted, readEntitlements } from './entitlements.mjs'
import { REPO } from './paths.mjs'

try {
  const config = builderConfig(process.env, { log: (m) => console.log(`preflight: ${m}`) })
  if (process.platform === 'darwin') {
    const file = config.mac?.entitlements ?? BASE_ENTITLEMENTS
    const restricted = Object.keys(readEntitlements(readFileSync(resolve(REPO, file), 'utf8'))).filter(isRestricted)
    console.log(`preflight: the app gets ${file}${restricted.length ? `, with ${restricted.join(', ')}` : ', no restricted entitlements'}`)
  }
} catch (err) {
  console.error(`preflight: ${err instanceof Error ? err.message : err}`)
  process.exitCode = 1
}
