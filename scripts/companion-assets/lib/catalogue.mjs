/* Copyright (c) 2026 Senne Chin. All rights reserved.
 * Part of the Apex Companion Art: licensed under the Apex Companion Art License
 * (ART-LICENSE.md), not under the Mozilla Public License. */

// The ids come straight from the shared contract so the generator can never
// drift from it. Node strips the TypeScript types (Node 22.18 or newer).
import { register } from 'node:module'

// The contract imports its neighbours (./branding) without an extension, as
// the bundlers resolve them; Node needs the .ts, so a resolve hook adds it,
// and the load hook says the .ts files are modules (the repo's package.json
// has no "type").
const TS_HOOKS = `export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\\.\\.?\\//.test(specifier) || /\\.[cm]?[jt]sx?$/.test(specifier)) throw err
    return next(specifier + '.ts', context)
  }
}
export async function load(url, context, next) {
  return next(url, url.endsWith('.ts') ? { ...context, format: 'module-typescript' } : context)
}`
register(`data:text/javascript,${encodeURIComponent(TS_HOOKS)}`)

let contract
try {
  contract = await import('../../../src/shared/companion.ts')
} catch (err) {
  throw new Error(`companion assets: could not load src/shared/companion.ts (needs Node 22.18+ with type stripping): ${err.message}`)
}

export const {
  RIGS,
  RIG_NODES,
  PART_SLOTS,
  TINTS,
  PART_IDS,
  FACE_LAYERS,
  EYE_VARIANTS,
  BROW_VARIANTS,
  MOUTH_VARIANTS,
  FACE_IDS,
  CLIPS,
  ONE_SHOT_CLIPS,
  FACE_CANVAS,
} = contract
