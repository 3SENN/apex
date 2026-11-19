/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The private internal/ folder (a separate, private repo checked out inside
// this one and gitignored): the maintainer's own files, never published: the
// signing values (internal/release.env), private planning documents, and
// optional packaging steps (internal/build.json). No app code lives there, so a
// build from this repository alone is complete.
//
//   node scripts/internal.mjs              prints which mode a build would use
//   node scripts/internal.mjs prepackage   runs the folder's packaging steps (npm run package)

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..')

/** The internal folder's marker file, relative to the repo. */
export const INTERNAL_MARKER = 'internal/internal.json'

/** Whether the internal folder is in this checkout: internal/internal.json names it. */
export function internalPresent(repo = REPO) {
  const marker = join(repo, INTERNAL_MARKER)
  if (!existsSync(marker)) return false
  try {
    return JSON.parse(readFileSync(marker, 'utf8'))?.name === 'atelier-internal'
  } catch {
    return false
  }
}

/** Whether a build uses the internal folder: present, and not turned off with ATELIER_INTERNAL=0. */
export function isInternal(env = process.env, repo = REPO) {
  return env.ATELIER_INTERNAL !== '0' && internalPresent(repo)
}

/**
 * What the internal folder adds to packaging (internal/build.json):
 * `prepackage` scripts to run before electron-builder
 * and `extraResources` per platform key (mac, win, linux). Empty without it.
 */
export function internalBuild(env = process.env, repo = REPO) {
  const out = { prepackage: [], extraResources: {} }
  if (!isInternal(env, repo)) return out
  let spec
  try {
    spec = JSON.parse(readFileSync(join(repo, 'internal', 'build.json'), 'utf8'))
  } catch {
    return out
  }
  for (const part of Object.values(spec?.areas ?? {})) {
    if (!part || typeof part !== 'object') continue
    for (const script of Array.isArray(part.prepackage) ? part.prepackage : []) if (typeof script === 'string') out.prepackage.push(script)
    for (const [platform, list] of Object.entries(part.extraResources ?? {})) {
      if (Array.isArray(list)) out.extraResources[platform] = [...(out.extraResources[platform] ?? []), ...list]
    }
  }
  return out
}

/** Runs the internal folder's packaging scripts for this build (`node scripts/internal.mjs prepackage`). */
export function runPrepackage(env = process.env, repo = REPO) {
  const { prepackage } = internalBuild(env, repo)
  for (const script of prepackage) {
    const result = spawnSync(process.execPath, [join(repo, script)], { cwd: repo, env, stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`${script} failed (exit ${result.status ?? result.signal})`)
  }
  return prepackage.length
}

/** A one-line description of the mode, for scripts that print it. */
export function describeMode(env = process.env, repo = REPO) {
  if (isInternal(env, repo)) return 'with the internal/ folder'
  return internalPresent(repo) ? 'without the internal/ folder (ATELIER_INTERNAL=0)' : 'from public code only'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'prepackage') {
    try {
      const ran = runPrepackage()
      console.log(ran ? `[internal] Ran ${ran} packaging step${ran === 1 ? '' : 's'} from internal/build.json.` : '[internal] No packaging steps from the internal folder.')
    } catch (err) {
      console.error(`[internal] ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  } else console.log(`Atelier builds ${describeMode()}.`)
}
