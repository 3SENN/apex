#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// macOS signing modes and the app's entitlements (docs/release.md, "Browser
// passkeys and iCloud Passwords"). electron-builder.config.mjs asks this
// module which mode the environment picks and what the app is signed with:
//
//   unsigned               no CSC_LINK or CSC_NAME (the default). Not signed
//                          by electron-builder; the fuses step re-signs ad hoc.
//   developer-id           ATELIER_SIGN_IDENTITY or CSC_NAME (a keychain identity,
//                          by SHA-1 or name; identity.mjs), or CSC_LINK
//                          (+ CSC_KEY_PASSWORD): hardened
//                          runtime, build/entitlements.mac.plist, notarized
//                          when the APPLE_* credentials are there.
//   developer-id-passkeys  developer-id plus ATELIER_PROVISIONING_PROFILE (a
//                          Developer ID .provisionprofile) and ATELIER_TEAM_ID
//                          (required here, no default). The profile is embedded and
//                          the app gets a generated entitlements file adding
//                          Apple's browser passkey entitlement, the application
//                          and team identifiers and the Touch ID keychain group.
//
// Restricted entitlements (the ones a provisioning profile must grant) are
// only ever written next to the profile that grants them: macOS refuses to
// launch an app that claims one without it. The preflight decodes the profile
// (security cms -D -i) before anything is signed and stops with a clear error
// when it doesn't grant what the build would claim.
//
// `node scripts/release/preflight.mjs` runs all of it from the command line
// (npm run package starts with it).

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { bundleIdFrom, requireTeamId, teamIdFrom } from './bundle.mjs'
import { signingPlan } from './config.mjs'
import { REPO } from './paths.mjs'

export const BROWSER_PASSKEY_ENTITLEMENT = 'com.apple.developer.web-browser.public-key-credential'
export const BASE_ENTITLEMENTS = 'build/entitlements.mac.plist'
export const INHERIT_ENTITLEMENTS = 'build/entitlements.mac.inherit.plist'
/** Written only in developer-id-passkeys mode; gitignored. */
export const PASSKEY_ENTITLEMENTS = 'build/generated/entitlements.mac.passkeys.plist'

/** @typedef {'unsigned' | 'developer-id' | 'developer-id-passkeys'} SigningMode */

const text = (env, key) => (typeof env[key] === 'string' ? env[key].trim() : '')

/** Keys macOS honours only with a provisioning profile that grants them. */
export function isRestricted(key) {
  return (
    key.startsWith('com.apple.developer.') ||
    key === 'com.apple.application-identifier' ||
    key === 'keychain-access-groups' ||
    key === 'com.apple.security.application-groups'
  )
}

/** Which mode the environment picks. A profile without an identity is an error: an ad hoc build can't carry what it grants. */
export function signingMode(env = process.env) {
  const signed = signingPlan(env, 'darwin').identity !== null
  const profile = text(env, 'ATELIER_PROVISIONING_PROFILE')
  if (profile && !signed) {
    throw new Error('ATELIER_PROVISIONING_PROFILE is set, but there is no Developer ID identity (ATELIER_SIGN_IDENTITY, CSC_NAME or CSC_LINK). An unsigned build never carries the browser passkey entitlement: macOS would refuse to launch it.')
  }
  if (!signed) return 'unsigned'
  return profile ? 'developer-id-passkeys' : 'developer-id'
}

// ---------------------------------------------------------------------------
// Entitlements plists: just what entitlements use (booleans, strings, arrays of strings).

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The top-level dict of an entitlements plist (as codesign --xml prints it, or a committed file). */
export function readEntitlements(xml) {
  const body = /<dict>([\s\S]*)<\/dict>/.exec(String(xml ?? '').replace(/<!--[\s\S]*?-->/g, ''))
  if (!body) return {}
  const out = {}
  const re = /<key>([^<]*)<\/key>\s*(<true\s*\/>|<false\s*\/>|<string>([^<]*)<\/string>|<string\s*\/>|<array>([\s\S]*?)<\/array>|<array\s*\/>)/g
  for (const m of body[1].matchAll(re)) {
    const key = unescape(m[1].trim())
    const value = m[2]
    if (/^<true/.test(value)) out[key] = true
    else if (/^<false/.test(value)) out[key] = false
    else if (/^<string/.test(value)) out[key] = unescape(m[3] ?? '')
    else out[key] = [...(m[4] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((s) => unescape(s[1]))
  }
  return out
}

/** An entitlements plist for `dict`, keys in the order given. */
export function entitlementsXml(dict, comment = '') {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">']
  if (comment) lines.push(`<!-- ${comment.replace(/--/g, '-')} -->`)
  lines.push('<plist version="1.0">', '<dict>')
  for (const [key, value] of Object.entries(dict)) {
    lines.push(`\t<key>${escape(key)}</key>`)
    if (value === true) lines.push('\t<true/>')
    else if (value === false) lines.push('\t<false/>')
    else if (Array.isArray(value)) lines.push('\t<array>', ...value.map((v) => `\t\t<string>${escape(v)}</string>`), '\t</array>')
    else lines.push(`\t<string>${escape(value)}</string>`)
  }
  lines.push('</dict>', '</plist>', '')
  return lines.join('\n')
}

/** The `<TEAM>.<bundle>.webauthn` keychain group Touch ID passkeys use (src/main/signInCompat.ts). */
export const webAuthnGroup = (teamId, bundleId) => `${teamId}.${bundleId}.webauthn`

/**
 * What the app itself is signed with in `mode`. `base` is build/entitlements.mac.plist,
 * which must stay free of restricted keys: those are added here, and only for the passkeys mode.
 */
export function entitlementsFor(mode, { base, teamId, bundleId, keychainGroup = true }) {
  const restricted = Object.keys(base).filter(isRestricted)
  if (restricted.length) throw new Error(`${BASE_ENTITLEMENTS} carries ${restricted.join(', ')}. Restricted entitlements need a provisioning profile, so only the generated passkeys file may hold them.`)
  if (mode !== 'developer-id-passkeys') return { ...base }
  const appId = `${teamId}.${bundleId}`
  return {
    ...base,
    [BROWSER_PASSKEY_ENTITLEMENT]: true,
    'com.apple.application-identifier': appId,
    'com.apple.developer.team-identifier': teamId,
    ...(keychainGroup ? { 'keychain-access-groups': [webAuthnGroup(teamId, bundleId)] } : {}),
  }
}

// ---------------------------------------------------------------------------
// The provisioning profile preflight.

/**
 * @typedef {object} ProfileFacts
 * @property {string} name
 * @property {string[]} teamIds        TeamIdentifier
 * @property {Record<string, unknown>} entitlements
 * @property {string | null} expires   ExpirationDate, ISO 8601
 * @property {string[]} platforms      Platform (OSX for a Mac profile)
 * @property {boolean} allDevices      ProvisionsAllDevices (Developer ID profiles)
 * @property {boolean} devices         ProvisionedDevices is present (development profiles)
 */

/** Matches a profile's keychain or app id pattern ("<TEAMID>.*") against a value. */
export function profilePatternMatches(pattern, value) {
  if (typeof pattern !== 'string') return false
  if (!pattern.endsWith('*')) return pattern === value
  return value.startsWith(pattern.slice(0, -1))
}

/** Whether the profile lets the app claim `group` in keychain-access-groups. */
export function profileAllowsKeychainGroup(facts, group) {
  const allowed = facts.entitlements['keychain-access-groups']
  return Array.isArray(allowed) && allowed.some((p) => profilePatternMatches(p, group))
}

/** Everything that keeps `facts` from signing a passkeys build of `bundleId` for `teamId`; [] when it can. */
export function profileProblems(facts, { teamId, bundleId, now = new Date() }) {
  const problems = []
  const appId = `${teamId}.${bundleId}`
  if (!facts.platforms.includes('OSX')) problems.push(`it is not a macOS profile (Platform: ${facts.platforms.join(', ') || 'none'})`)
  if (facts.devices || !facts.allDevices) problems.push('it is a development profile. A Developer ID build needs a Developer ID profile (Profiles › + › Developer ID)')
  if (!facts.teamIds.includes(teamId)) problems.push(`it belongs to team ${facts.teamIds.join(', ') || '(none)'}, not ${teamId} (ATELIER_TEAM_ID)`)
  const team = facts.entitlements['com.apple.developer.team-identifier']
  if (team !== teamId) problems.push(`it grants com.apple.developer.team-identifier ${JSON.stringify(team ?? null)}, not "${teamId}"`)
  const profileAppId = facts.entitlements['com.apple.application-identifier']
  if (profileAppId !== appId) {
    const wildcard = typeof profileAppId === 'string' && profileAppId.endsWith('*')
    problems.push(
      wildcard
        ? `it is a wildcard profile (${profileAppId}). The browser passkey entitlement needs an explicit App ID: ${bundleId}`
        : `it is for ${JSON.stringify(profileAppId ?? null)}, not ${appId}. Register the App ID ${bundleId} and make the profile for it (or set ATELIER_BUNDLE_ID)`,
    )
  }
  if (facts.entitlements[BROWSER_PASSKEY_ENTITLEMENT] !== true) {
    problems.push(`it doesn't grant ${BROWSER_PASSKEY_ENTITLEMENT}. Once Apple approves the request, tick it under the App ID's Additional Capabilities and download a new profile (docs/release.md)`)
  }
  if (facts.expires && Date.parse(facts.expires) <= now.getTime()) problems.push(`it expired on ${facts.expires.slice(0, 10)}`)
  return problems
}

/** Runs `security cms -D -i` and reads the fields the preflight needs with plutil (macOS only). */
export function decodeProfile(path, run = execFileSync) {
  if (!existsSync(path)) throw new Error(`ATELIER_PROVISIONING_PROFILE points at ${path}, which doesn't exist`)
  let xml
  try {
    xml = run('security', ['cms', '-D', '-i', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    throw new Error(`security cms -D couldn't decode ${path}: is it a .provisionprofile? (${String(err?.stderr ?? err?.message ?? err).trim()})`)
  }
  const extract = (key, format) => {
    try {
      return run('plutil', ['-extract', key, format, '-o', '-', '-'], { input: xml, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
    } catch {
      return null
    }
  }
  const json = (key, fallback) => {
    const v = extract(key, 'json')
    return v === null ? fallback : JSON.parse(v)
  }
  return {
    name: extract('Name', 'raw') ?? '',
    teamIds: json('TeamIdentifier', []),
    entitlements: json('Entitlements', {}),
    expires: extract('ExpirationDate', 'raw'),
    platforms: json('Platform', []),
    allDevices: extract('ProvisionsAllDevices', 'raw') === 'true',
    devices: extract('ProvisionedDevices', 'json') !== null,
  }
}

/**
 * The preflight: the profile decoded and checked against the team and bundle id.
 * Throws with every problem listed; returns what the entitlements may claim.
 */
export function preflightProfile(path, { teamId, bundleId, now = new Date(), decode = decodeProfile }) {
  const facts = decode(path)
  const problems = profileProblems(facts, { teamId, bundleId, now })
  if (problems.length) {
    throw new Error(`The provisioning profile ${path}${facts.name ? ` ("${facts.name}")` : ''} can't sign Atelier with browser passkeys:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  }
  return { facts, keychainGroup: profileAllowsKeychainGroup(facts, webAuthnGroup(teamId, bundleId)) }
}

// ---------------------------------------------------------------------------
// What electron-builder's mac config gets.

/**
 * The mac part of electron-builder's config for the environment's mode. In the
 * passkeys mode it runs the preflight and writes PASSKEY_ENTITLEMENTS.
 * `log` hears what was decided.
 */
export function macSigningConfig(env = process.env, { repo = REPO, out = join(repo, PASSKEY_ENTITLEMENTS), now = new Date(), decode = decodeProfile, log = () => {} } = {}) {
  const mode = signingMode(env)
  const bundleId = bundleIdFrom(env)
  // Only the passkeys entitlements name the team; unsigned and plain Developer ID builds go without it.
  const teamId = mode === 'developer-id-passkeys' ? requireTeamId(env, 'The passkeys signing mode (ATELIER_PROVISIONING_PROFILE)') : teamIdFrom(env)
  const base = readEntitlements(readFileSync(join(repo, BASE_ENTITLEMENTS), 'utf8'))
  const inheritRestricted = Object.keys(readEntitlements(readFileSync(join(repo, INHERIT_ENTITLEMENTS), 'utf8'))).filter(isRestricted)
  if (inheritRestricted.length) throw new Error(`${INHERIT_ENTITLEMENTS} carries ${inheritRestricted.join(', ')}. The nested helpers have no provisioning profile, so they never get restricted entitlements.`)
  const plan = signingPlan(env, 'darwin')
  if (mode === 'unsigned') {
    entitlementsFor(mode, { base, teamId, bundleId })
    return { mode, bundleId, teamId, entitlements: base, mac: { notarize: false } }
  }
  const mac = { hardenedRuntime: true, notarize: plan.notarize !== null }
  if (mode === 'developer-id') return { mode, bundleId, teamId, entitlements: entitlementsFor(mode, { base, teamId, bundleId }), mac }

  const profileEnv = text(env, 'ATELIER_PROVISIONING_PROFILE')
  const profile = isAbsolute(profileEnv) ? profileEnv : resolve(repo, profileEnv)
  const { keychainGroup } = preflightProfile(profile, { teamId, bundleId, now, decode })
  if (!keychainGroup) log(`the profile doesn't allow the keychain group ${webAuthnGroup(teamId, bundleId)}, so Touch ID passkeys stay off (iCloud Keychain passkeys still work)`)
  const entitlements = entitlementsFor(mode, { base, teamId, bundleId, keychainGroup })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, entitlementsXml(entitlements, `Generated by scripts/release/entitlements.mjs for ${teamId}.${bundleId} (developer-id-passkeys). Do not edit or commit.`))
  return { mode, bundleId, teamId, entitlements, mac: { ...mac, entitlements: out, provisioningProfile: profile } }
}
