/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The private internal/ folder (a separate, private repo checked out inside
// this one and gitignored): the parts of official Apex builds that can't be
// published, such as engines that need a provider's approval before a
// public release may offer them, and the maintainer's signing values
// (internal/release.env). Public code imports those parts as
// `@internal/<area>/...`; without the folder, the same import resolves to the
// stubs in src/stubs/<area>, so a build from this repository is complete.
//
//   node scripts/internal.mjs              prints which mode a build would use
//   node scripts/internal.mjs prepackage   runs the folder's packaging steps (npm run package)
//
// TypeScript resolves `@internal/*` the same way through the fallback list in
// tsconfig.web.json and tsconfig.node.json.

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
    return JSON.parse(readFileSync(marker, 'utf8'))?.name === 'apex-internal'
  } catch {
    return false
  }
}

/** Whether a build uses the internal folder: present, and not turned off with APEX_INTERNAL=0. */
export function isInternal(env = process.env, repo = REPO) {
  return env.APEX_INTERNAL !== '0' && internalPresent(repo)
}

/** The folder `@internal` resolves to: internal/, or the public stubs. */
export function internalRoot(env = process.env, repo = REPO) {
  return isInternal(env, repo) ? join(repo, 'internal') : join(repo, 'src', 'stubs')
}

/** Whether APEX_PUBLIC_RELEASE asks for a public release (read as scripts/release/config.mjs reads it). */
export function publicRelease(env = process.env) {
  const value = typeof env.APEX_PUBLIC_RELEASE === 'string' ? env.APEX_PUBLIC_RELEASE.trim() : ''
  return value === '1' || value === 'true'
}

/**
 * Areas of internal/ that a public release leaves out. The maintainer builds
 * public releases with the folder present (for release.env), so these areas
 * come from the stubs then, and the release has none of their code.
 */
export const PRIVATE_AREAS = ['engines']

/** Whether a build takes `internal/<area>`: the folder is in use, and a public release never takes a private area. */
export function areaIncluded(area, env = process.env, repo = REPO) {
  return isInternal(env, repo) && !(PRIVATE_AREAS.includes(area) && publicRelease(env))
}

/**
 * The Vite alias for `@internal` (an object to spread into `resolve.alias`).
 * An area the build leaves out comes first, pointing at its stubs, so it
 * wins over the folder's own alias.
 */
export function internalAlias(env = process.env, repo = REPO) {
  const alias = {}
  for (const area of PRIVATE_AREAS) {
    if (isInternal(env, repo) && !areaIncluded(area, env, repo)) alias[`@internal/${area}`] = join(repo, 'src', 'stubs', area)
  }
  alias['@internal'] = internalRoot(env, repo)
  return alias
}

/**
 * What the internal folder adds to packaging (internal/build.json), for the
 * areas this build takes: `prepackage` scripts to run before electron-builder
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
  for (const [area, part] of Object.entries(spec?.areas ?? {})) {
    if (!areaIncluded(area, env, repo) || !part || typeof part !== 'object') continue
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

/** The build-time define the app reads: whether the internal folder is built in. */
export function internalDefines(env = process.env, repo = REPO) {
  return { __APEX_INTERNAL__: JSON.stringify(isInternal(env, repo)) }
}

/** A one-line description of the mode, for scripts that print it. */
export function describeMode(env = process.env, repo = REPO) {
  if (isInternal(env, repo)) return 'with the internal/ folder'
  return internalPresent(repo) ? 'without the internal/ folder (APEX_INTERNAL=0)' : 'from public code only'
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
  } else console.log(`Apex builds ${describeMode()}${isInternal() && !areaIncluded('engines') ? ', with the public engines only (APEX_PUBLIC_RELEASE)' : ''}.`)
}
