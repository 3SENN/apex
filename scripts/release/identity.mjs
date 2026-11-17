/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which Developer ID Application identity signs Apex (docs/release.md, Signing).
//
// APEX_SIGN_IDENTITY (or CSC_NAME) names it by SHA-1 hash or by name. A name
// can match more than one identity: a keychain can hold a renewed
// "Developer ID Application: Your Name (TEAMID)" certificate next to the one it
// replaces, and electron-builder would take whichever `security find-identity`
// lists first. So a name is resolved here to one hash before electron-builder
// sees it: the only match, or the preferred hash (APEX_SIGN_IDENTITY when it is
// one) when it is among the matches, or an error that lists the hashes to
// choose from. codesign is then always called with a hash and never sees an
// ambiguous name.
//
// Nothing here names a certificate: the maintainer's own hash lives in the
// private internal/release.env (config.mjs), yours in your environment. The
// private key stays in the keychain (or in CSC_LINK's .p12, which
// electron-builder imports itself).

import { execFileSync } from 'node:child_process'

export const DEVELOPER_ID_PREFIX = 'Developer ID Application: '

const HASH = /^[0-9A-Fa-f]{40}$/
const text = (env, key) => (typeof env[key] === 'string' ? env[key].trim() : '')

/** The valid identities in `security find-identity -v -p codesigning` output. */
export function parseIdentities(output) {
  const out = []
  for (const line of String(output ?? '').split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"(.+)"\s*$/.exec(line)
    if (m && !/CSSMERR_|REVOKED|expired/i.test(line)) out.push({ hash: m[1].toUpperCase(), name: m[2] })
  }
  return out
}

/** The keychain's code signing identities (macOS). */
export function keychainIdentities(run = execFileSync) {
  try {
    return parseIdentities(run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return []
  }
}

/** What you asked for: APEX_SIGN_IDENTITY, else CSC_NAME; '' when neither (CSC_LINK, or unsigned). */
export function requestedIdentity(env = process.env) {
  return text(env, 'APEX_SIGN_IDENTITY') || text(env, 'CSC_NAME')
}

/** The preferred certificate: APEX_SIGN_IDENTITY when it is a SHA-1 (upper case), else ''. There is no default. */
export function preferredIdentity(env = process.env) {
  const v = text(env, 'APEX_SIGN_IDENTITY')
  return HASH.test(v) ? v.toUpperCase() : ''
}

/**
 * One identity for `requested` (a SHA-1 or a name, with or without the
 * "Developer ID Application: " prefix) among `identities`. Throws when it is
 * missing or ambiguous.
 */
export function resolveIdentity(requested, identities, { preferred = '' } = {}) {
  const want = requested.trim()
  if (HASH.test(want)) {
    const found = identities.find((i) => i.hash === want.toUpperCase())
    if (!found) throw new Error(`the signing identity ${want} isn't in the keychain (security find-identity -v -p codesigning lists ${identities.length})`)
    if (!found.name.startsWith(DEVELOPER_ID_PREFIX)) throw new Error(`the identity ${want} is "${found.name}", not a Developer ID Application certificate`)
    return found
  }
  const name = want.startsWith(DEVELOPER_ID_PREFIX) ? want : `${DEVELOPER_ID_PREFIX}${want}`
  const matches = identities.filter((i) => i.name === name)
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) throw new Error(`no "${name}" identity in the keychain. Import the certificate, or set APEX_SIGN_IDENTITY to its SHA-1`)
  const pick = preferred ? matches.find((i) => i.hash === preferred.trim().toUpperCase()) : undefined
  if (pick) return pick
  throw new Error(`"${name}" is ambiguous: ${matches.length} identities carry it (${matches.map((i) => i.hash).join(', ')}). Set APEX_SIGN_IDENTITY to the SHA-1 of the one to sign with`)
}

/**
 * The hash electron-builder's mac.identity gets, or null when no keychain
 * identity was asked for (unsigned, or CSC_LINK's own certificate).
 */
export function signingIdentity(env = process.env, { identities = keychainIdentities, preferred = preferredIdentity(env) } = {}) {
  const requested = requestedIdentity(env)
  if (!requested) return null
  return resolveIdentity(requested, typeof identities === 'function' ? identities() : identities, { preferred }).hash
}
