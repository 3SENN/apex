/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Apex's bundle id and Apple team (docs/release.md, "Browser passkeys and
// iCloud Passwords"). One place for both, read by electron-builder's config
// (electron-builder.config.mjs), the entitlements generator, electron-vite's
// defines and the native helper builds. The default bundle id is the
// branding's (scripts/branding.mjs): com.sennechin.apex for official Apex,
// dev.summit.browser for the unofficial branding.
//
// The team id has no default: it comes from APEX_TEAM_ID (in the environment,
// or in the maintainer's private internal/release.env; config.mjs). Unsigned,
// ad hoc and open-source builds need none. Certificates, profiles and
// notarization credentials never live here; they come from the environment.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadBranding } from '../branding.mjs'

/** The official branding's bundle id (branding/official/branding.json). */
export const DEFAULT_BUNDLE_ID = 'com.sennechin.apex'

/** Reverse-DNS, as Apple accepts it for an explicit App ID: letters, digits, hyphens and dots, no wildcard. */
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
const TEAM_ID = /^[A-Z0-9]{10}$/

const text = (env, key) => (typeof env[key] === 'string' ? env[key].trim() : '')

/** APEX_BUNDLE_ID, else the branding's (com.sennechin.apex when official). A malformed value is an error, never silently replaced. */
export function bundleIdFrom(env = process.env) {
  const v = text(env, 'APEX_BUNDLE_ID')
  if (!v) return loadBranding(env).bundleId
  if (!BUNDLE_ID.test(v) || v.length > 155) throw new Error(`APEX_BUNDLE_ID "${v}" is not a bundle id like ${DEFAULT_BUNDLE_ID}`)
  return v
}

/** APEX_TEAM_ID, or null when it isn't set. A malformed value is an error. */
export function teamIdFrom(env = process.env) {
  const v = text(env, 'APEX_TEAM_ID')
  if (!v) return null
  if (!TEAM_ID.test(v)) throw new Error(`APEX_TEAM_ID "${v}" is not a 10-character Apple Team ID (developer.apple.com › Membership)`)
  return v
}

/** APEX_TEAM_ID for something that can't go without it (`what`); throws naming the variable when it isn't set. */
export function requireTeamId(env = process.env, what = 'This') {
  const v = teamIdFrom(env)
  if (!v) throw new Error(`${what} needs your Apple Team ID: set APEX_TEAM_ID (developer.apple.com › Membership), in the environment or in internal/release.env (docs/release.md)`)
  return v
}

/** A native helper's bundle id: com.sennechin.apex.speech and friends. */
export const helperBundleId = (bundleId, helper) => `${bundleId}.${helper}`

/** `plist` with its CFBundleIdentifier replaced. */
export function withBundleIdentifier(plist, id) {
  const re = /(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]*(<\/string>)/
  if (!re.test(plist)) throw new Error('the Info.plist has no CFBundleIdentifier')
  return plist.replace(re, `$1${id}$2`)
}

const OFFICIAL_NAME = 'Apex'

/**
 * `plist` with the official name in its string values ("Apex Speech", "Apex
 * reads your calendar…") replaced by `name`, the branding's. Keys stay.
 */
export function withProductName(plist, name) {
  if (name === OFFICIAL_NAME) return plist
  return plist.replace(/<string>([^<]*)<\/string>/g, (_m, value) => `<string>${value.replace(/\bApex\b/g, name)}</string>`)
}

/**
 * The Info.plist a helper build embeds (swiftc -sectcreate __TEXT __info_plist):
 * the committed one for the official branding's bundle id and name, else a copy
 * in `outDir` carrying <APEX_BUNDLE_ID>.<helper> and the branding's name in
 * its usage descriptions. Its path is returned.
 */
export function helperInfoPlist(sourcePlist, outDir, helper, env = process.env) {
  const id = helperBundleId(bundleIdFrom(env), helper)
  const source = readFileSync(sourcePlist, 'utf8')
  const plist = withProductName(withBundleIdentifier(source, id), loadBranding(env).name)
  if (plist === source) return sourcePlist
  mkdirSync(outDir, { recursive: true })
  const out = join(outDir, 'Info.plist')
  writeFileSync(out, plist)
  return out
}
