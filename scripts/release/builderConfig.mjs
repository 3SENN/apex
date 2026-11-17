/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// electron-builder's whole config (electron-builder.config.mjs): the static
// electron-builder.yml plus what the environment decides, so `npm run package`
// and release.mjs build the same thing from the same env:
//   - the branding (scripts/branding.mjs): the yml is written for the official
//     one, and brandedConfig swaps in the active branding's name and files;
//   - appId, from APEX_BUNDLE_ID, else the branding's (bundle.mjs);
//   - the publish target (config.mjs builderOverrides);
//   - on macOS, the signing mode and its entitlements and profile
//     (entitlements.mjs), notarization on or off, the identity resolved
//     to one SHA-1 (identity.mjs) and kept as a hash all the way to codesign
//     (sign.mjs), and a signed dmg when the app is signed.
// YAML can't be conditional, so the yml keeps everything that is fixed and
// says `mac.identity: null`: without signing env nothing is signed.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { brandingFile, loadBranding } from '../branding.mjs'
import { internalBuild } from '../internal.mjs'
import { builderOverrides, releaseSettings } from './config.mjs'
import { macSigningConfig } from './entitlements.mjs'
import { signingIdentity } from './identity.mjs'
import { REPO } from './paths.mjs'

const require = createRequire(import.meta.url)

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A deep copy of `base` with each source laid over it; arrays and scalars replace. */
export function mergeConfig(base, ...sources) {
  const out = structuredClone(base)
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) {
      out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeConfig(out[key], value) : structuredClone(value)
    }
  }
  return out
}

/** The config with `extra` (platform key → entries, from internal/build.json) added to each platform's extraResources. */
export function withExtraResources(config, extra) {
  const out = structuredClone(config)
  for (const [platform, entries] of Object.entries(extra ?? {})) {
    if (!Array.isArray(entries) || entries.length === 0) continue
    out[platform] = { ...(out[platform] ?? {}), extraResources: [...(out[platform]?.extraResources ?? []), ...structuredClone(entries)] }
  }
  return out
}

/** What electron-builder.yml is written for: the official branding's folder and name. */
export const OFFICIAL_DIR = 'branding/official/'
export const OFFICIAL_NAME = 'Apex'

/**
 * electron-builder.yml for `branding`: each branding/official/ path from the
 * branding's own folder, and its name wherever the yml says "Apex" (the
 * product name, the shortcut, the file types' names, the usage descriptions,
 * the Linux window class). Lower-case apex (file extensions, the helpers'
 * file names) stays, as do the keys. The packaged package.json carries the
 * name too, so app.name, and with it the profile folder, follows the branding.
 * The copyright, the publisher (package.json's author) and the Windows
 * trademark line come from the branding as well.
 */
export function brandedConfig(config, branding, repo = REPO) {
  const dir = `${brandingFile(branding, '.', repo)}/`
  const rename = (value) => {
    if (typeof value === 'string') return value.split(OFFICIAL_DIR).join(dir).replace(/\bApex\b/g, branding.name)
    if (Array.isArray(value)) return value.map(rename)
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v)]))
    return value
  }
  // package.json's description names the app too (the Linux packages show it).
  let description
  try {
    description = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).description
  } catch {
    description = undefined
  }
  // The publisher is the packaged package.json's author: the installer's publisher and Windows' company name.
  const metadata = { productName: branding.name, author: branding.publisher, ...(typeof description === 'string' ? { description: rename(description) } : {}) }
  // The copyright line (macOS NSHumanReadableCopyright, Windows LegalCopyright), as Brave's "The Brave Authors",
  // and the trademark line in the Windows file properties, only for a branding that claims marks.
  const trademarks = brandTrademarkInfo(branding)
  return mergeConfig(rename(config), { productName: branding.name, copyright: branding.copyright, extraMetadata: metadata }, trademarks ? { win: { legalTrademarks: trademarks } } : {})
}

/** The branding's trademark line with its name filled in ({brand}), or '' when it claims none. */
export function brandTrademarkInfo(branding) {
  return typeof branding.trademarkInfo === 'string' ? branding.trademarkInfo.split('{brand}').join(branding.shortName).trim() : ''
}

/** electron-builder.yml as written. */
export function baseConfig(repo = REPO) {
  return require('js-yaml').load(readFileSync(join(repo, 'electron-builder.yml'), 'utf8'))
}

/**
 * The config for a build on `platform` under `env`. On macOS this runs the
 * signing preflight (and writes the passkeys entitlements in that mode), so a
 * build that can't be signed stops before anything is packaged.
 */
export function builderConfig(env = process.env, { platform = process.platform, repo = REPO, out, identities, decode, log = () => {} } = {}) {
  const settings = releaseSettings(env, platform)
  const branded = brandedConfig(baseConfig(repo), loadBranding(env, repo), repo)
  const config = withExtraResources(mergeConfig(branded, builderOverrides(settings, env), { appId: settings.bundleId }), internalBuild(env, repo).extraResources)
  if (platform !== 'darwin') return config
  const signing = macSigningConfig(env, { repo, ...(out ? { out } : {}), ...(decode ? { decode } : {}), log })
  const mac = { ...signing.mac }
  // CSC_LINK's certificate lives in the temporary keychain electron-builder makes; it finds that one itself.
  const fromCertificate = typeof env.CSC_LINK === 'string' && env.CSC_LINK.trim() !== ''
  if (signing.mode !== 'unsigned' && !fromCertificate) {
    const hash = signingIdentity(env, identities ? { identities } : {})
    if (hash) mac.identity = hash
  }
  // electron-builder's own sign call passes the identity's name, which codesign
  // calls ambiguous when two certificates share it; sign.mjs keeps the hash.
  if (signing.mode !== 'unsigned') mac.sign = join(repo, 'scripts', 'release', 'sign.mjs')
  log(`${signing.mode} for ${signing.bundleId}${signing.mode === 'unsigned' ? '' : `${signing.teamId ? `, team ${signing.teamId}` : ''}${mac.identity ? `, identity ${mac.identity}` : ''}, notarization ${mac.notarize ? 'on' : 'off'}`}`)
  // A signed build signs its dmg too (with the same hash), so Gatekeeper can assess the dmg itself once it is notarized.
  return mergeConfig(config, { mac }, signing.mode === 'unsigned' ? {} : { dmg: { sign: true } })
}
