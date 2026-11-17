/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apex's two brandings, as Firefox has them (TRADEMARKS.md; docs/architecture.md › Branding):
//
//   branding/official/     Apex: the name, logo, icons and Pip, the default companion
//   branding/unofficial/   Summit: a plain name, plain icons and a neutral companion of its own
//                          (companion.json); it offers none of Apex's six characters
//
// The official files that depict an Apex character are Apex Companion Art
// (ART-LICENSE.md; branding/official/LICENSE.md), the rest of both folders is
// MPL-2.0, and neither licence grants rights to the Apex trademarks, so builds
// from source use the unofficial branding unless official branding is switched on:
//
//   APEX_OFFICIAL_BRANDING=1   the official branding (official Apex builds; the release workflow sets it)
//   APEX_OFFICIAL_BRANDING=0   the unofficial branding
//   unset                      official when the private internal/ folder is in use (the maintainer's
//                              checkout; scripts/internal.mjs), unofficial otherwise
//
// One place decides it for everything that names or draws the app:
// electron.vite.config.ts (the __APEX_BRANDING__ define and the `@branding`
// alias), electron-builder's config (productName, appId, icons, installer
// art), scripts/dev-branding.mjs (the dev bundle's name and icon), the native
// helpers' Info.plists and vitest.config.ts.
//
//   node scripts/branding.mjs          prints which branding a build would use
//   node scripts/branding.mjs --json   prints the define's value

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { isInternal } from './internal.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..')

/** @type {readonly ['official', 'unofficial']} */
export const BRANDINGS = ['official', 'unofficial']

/** Where the companion presets live; a branding names its default companion by preset id. */
export const PRESETS = 'src/renderer/public/companion/config/presets.json'

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * Whether a build uses the official branding: APEX_OFFICIAL_BRANDING when it
 * is set (1/true or 0/false), else whether the internal folder is in use. Any
 * other value is an error, never silently read as either.
 */
export function officialBranding(env = process.env, repo = REPO) {
  const value = typeof env.APEX_OFFICIAL_BRANDING === 'string' ? env.APEX_OFFICIAL_BRANDING.trim().toLowerCase() : ''
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  if (value) throw new Error(`APEX_OFFICIAL_BRANDING is "${env.APEX_OFFICIAL_BRANDING}"; use 1 for the official branding or 0 for the unofficial one`)
  return isInternal(env, repo)
}

/** 'official' or 'unofficial'. */
export function brandingId(env = process.env, repo = REPO) {
  return officialBranding(env, repo) ? 'official' : 'unofficial'
}

/** The active branding's folder (absolute). */
export function brandingRoot(env = process.env, repo = REPO) {
  return join(repo, 'branding', brandingId(env, repo))
}

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** Checks one branding.json; returns the list of problems (empty when it is fine). */
export function brandingProblems(json) {
  const problems = []
  if (!json || typeof json !== 'object' || Array.isArray(json)) return ['branding.json is not an object']
  for (const key of ['name', 'shortName']) {
    if (!text(json[key]) || text(json[key]).length > 40) problems.push(`${key} must be a name of 1 to 40 characters`)
  }
  if (!BUNDLE_ID.test(text(json.bundleId))) problems.push(`bundleId "${json.bundleId}" is not a reverse-DNS id`)
  // Who publishes the build (the installer's publisher, Windows' company name) and its copyright line, as Brave's "The Brave Authors".
  if (!text(json.publisher) || text(json.publisher).length > 80) problems.push('publisher must be a name of 1 to 80 characters')
  if (!text(json.copyright) || text(json.copyright).length > 120) problems.push('copyright must be a line of 1 to 120 characters')
  // Firefox's trademarkInfo: the line About shows under the name, with {brand} for the name; "" for a branding that claims no marks.
  if (typeof json.trademarkInfo !== 'string' || json.trademarkInfo.length > 200) problems.push('trademarkInfo must be a line of text, or "" for none')
  if (!PRESET_ID.test(text(json.defaultPreset))) problems.push('defaultPreset must be a companion preset id')
  // A branding's own default companion, a preset of its own beside presets.json's (the unofficial branding's neutral one).
  if (json.companion != null && !/^[\w.-]+\.json$/.test(text(json.companion))) problems.push('companion must be a .json file in the branding folder, or null for a preset from presets.json')
  if (!Array.isArray(json.hiddenPresets) || json.hiddenPresets.some((id) => !PRESET_ID.test(text(id)))) problems.push('hiddenPresets must be a list of preset ids')
  else if (json.hiddenPresets.includes(json.defaultPreset)) problems.push('the default preset cannot be hidden')
  if (!json.icons || typeof json.icons !== 'object') problems.push('icons must name the icon files')
  if (json.logo !== null && typeof json.logo !== 'string') problems.push('logo must be a file in the branding folder, or null for the name beside the mark')
  return problems
}

/** A branding's branding.json, checked, with its id and folder. Throws naming every problem. */
export function readBranding(id, repo = REPO) {
  if (!BRANDINGS.includes(id)) throw new Error(`There is no "${id}" branding (${BRANDINGS.join(', ')})`)
  const dir = join(repo, 'branding', id)
  const file = join(dir, 'branding.json')
  const json = JSON.parse(readFileSync(file, 'utf8'))
  const problems = brandingProblems(json)
  if (problems.length > 0) throw new Error(`${relative(repo, file)}: ${problems.join('; ')}`)
  return { ...json, id, official: id === 'official', dir }
}

/** The active branding (see readBranding). */
export function loadBranding(env = process.env, repo = REPO) {
  return readBranding(brandingId(env, repo), repo)
}

/** A file of the active branding, relative to the repo with forward slashes (as electron-builder's config takes it). */
export function brandingFile(branding, file, repo = REPO) {
  return relative(repo, join(branding.dir, file)).split('\\').join('/')
}

/** Checks a branding's own companion (branding/<id>/companion.json); returns the list of problems. */
export function companionProblems(json, defaultPreset) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return ['it is not an object']
  const problems = []
  if (json.id !== defaultPreset) problems.push(`its id must be the branding's defaultPreset ("${defaultPreset}")`)
  if (!text(json.name) || text(json.name).length > 24) problems.push('name must be a name of 1 to 24 characters')
  if (typeof json.tagline !== 'string' || json.tagline.length > 200) problems.push('tagline must be a line of up to 200 characters')
  if (typeof json.personality !== 'string' || json.personality.length > 1000) problems.push('personality must be text of up to 1000 characters')
  if (json.summary !== undefined && typeof json.summary !== 'string') problems.push('summary must be text')
  const look = json.look
  if (!look || typeof look !== 'object' || typeof look.rig !== 'string' || !look.parts || !look.face || !look.colors) problems.push('look must be a look: rig, parts, face and colors')
  return problems
}

/** The branding's own default companion, a full preset (companion.json); null when its default is a preset from presets.json. */
export function ownCompanion(branding) {
  if (typeof branding.companion !== 'string') return null
  const file = join(branding.dir, branding.companion)
  const json = JSON.parse(readFileSync(file, 'utf8'))
  const problems = companionProblems(json, branding.defaultPreset)
  if (problems.length > 0) throw new Error(`branding/${branding.id}/${branding.companion}: ${problems.join('; ')}`)
  return json
}

/**
 * The default companion's preset (name and look): the branding's own
 * (companion.json), else the one in presets.json, so first run and the
 * defaults agree with the gallery.
 */
export function brandingCompanion(branding, repo = REPO) {
  const own = ownCompanion(branding)
  if (own) return { id: own.id, name: own.name, look: own.look }
  const presets = JSON.parse(readFileSync(join(repo, PRESETS), 'utf8'))
  const preset = Array.isArray(presets) ? presets.find((p) => p && p.id === branding.defaultPreset) : null
  if (!preset || !text(preset.name) || !preset.look) throw new Error(`The ${branding.id} branding's default companion "${branding.defaultPreset}" is not a preset in ${PRESETS}`)
  return { id: preset.id, name: preset.name, look: preset.look }
}

/**
 * What the app reads at run time (src/shared/branding.ts): the names, the
 * bundle id, the copyright and trademark lines (Settings › About), the default
 * companion (with the whole preset when it is the branding's own) and which
 * presets to leave out, and whether the logo is a drawn wordmark. No paths:
 * the renderer takes the images through the `@branding` alias, main through
 * resources/.
 */
export function runtimeBranding(env = process.env, repo = REPO) {
  const branding = loadBranding(env, repo)
  return {
    id: branding.id,
    official: branding.official,
    name: branding.name,
    shortName: branding.shortName,
    bundleId: branding.bundleId,
    copyright: branding.copyright,
    trademarkInfo: branding.trademarkInfo,
    companion: brandingCompanion(branding, repo),
    ownPreset: ownCompanion(branding),
    hiddenPresets: [...branding.hiddenPresets],
    wordmark: typeof branding.logo === 'string',
  }
}

/** The electron-vite and vitest define. */
export function brandingDefines(env = process.env, repo = REPO) {
  return { __APEX_BRANDING__: JSON.stringify(runtimeBranding(env, repo)) }
}

/** The Vite alias for `@branding` (an object to spread into `resolve.alias`): the active branding's folder. */
export function brandingAlias(env = process.env, repo = REPO) {
  return { '@branding': brandingRoot(env, repo) }
}

/** A one-line description, for scripts that print it. */
export function describeBranding(env = process.env, repo = REPO) {
  const branding = loadBranding(env, repo)
  const why = typeof env.APEX_OFFICIAL_BRANDING === 'string' && env.APEX_OFFICIAL_BRANDING.trim() !== '' ? 'APEX_OFFICIAL_BRANDING' : isInternal(env, repo) ? 'the internal/ folder is here' : 'no internal/ folder'
  return `${branding.name} (the ${branding.id} branding; ${why})`
}

/** Whether every file a branding's branding.json names is there; returns the missing ones. */
export function missingBrandingFiles(branding) {
  const { documents, ...icons } = branding.icons ?? {}
  const files = Object.values(icons).filter((file) => typeof file === 'string')
  // A document icon is named without its extension: <name>.icns for macOS, <name>.ico for Windows, <name>.png for the rest.
  for (const name of Object.values(documents ?? {})) files.push(`${name}.icns`, `${name}.ico`)
  if (typeof branding.logo === 'string') files.push(branding.logo)
  return files.filter((file) => !existsSync(join(branding.dir, file)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--json')) console.log(JSON.stringify(runtimeBranding(), null, 2))
    else console.log(`This checkout builds ${describeBranding()}.`)
  } catch (err) {
    console.error(`[branding] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
