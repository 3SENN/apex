#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// App Store Connect API helper for Atelier's App ID and Developer ID profile
// (docs/release.md, "Browser passkeys and iCloud Passwords"). It talks to
// https://api.appstoreconnect.apple.com with the person's own API key and
// never runs without it: APPLE_API_KEY (the .p8 path), APPLE_API_KEY_ID and
// APPLE_API_ISSUER, the same three notarization uses.
//
//   node scripts/release/asc.mjs              dry run (the default): reads only, prints what --apply would change
//   node scripts/release/asc.mjs --apply      registers the bundle id, adds capabilities, makes the profile
//
// Options:
//   --bundle-id <id>       default ATELIER_BUNDLE_ID, else com.sennechin.atelier
//   --name <name>          the App ID's name in the portal (default "Atelier")
//   --capability <TYPE>    a capabilityType to enable on the App ID (repeatable; none by default)
//   --certificate <id>     the Developer ID Application certificate's API id; by default the one whose
//                          SHA-1 is ATELIER_SIGN_IDENTITY (when a hash), or the account's only one
//   --profile-name <name>  default "Atelier Developer ID <bundle id>"
//   --out <path>           where the profile is written (default build/generated/<bundle id>.provisionprofile)
//   --recreate             delete a profile of that name first and make a new one (needed after a capability change)
//
// It needs ATELIER_TEAM_ID (the profile is checked against your team). Like the
// other release scripts, it reads internal/release.env under the environment
// when that file exists (config.mjs).
//
// Apple's browser passkey entitlement is granted to the account on request; the
// API documents no capabilityType for it. Once approved, tick it on the App ID
// (Identifiers › the App ID › Additional Capabilities), then run --apply
// --recreate so the profile carries it. The written profile is checked with
// the same preflight the build runs (entitlements.mjs).

import { createHash, createPrivateKey, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { loadBranding } from '../branding.mjs'
import { bundleIdFrom, requireTeamId } from './bundle.mjs'
import { loadReleaseEnv } from './config.mjs'
import { decodeProfile, profileProblems } from './entitlements.mjs'
import { preferredIdentity } from './identity.mjs'
import { REPO } from './paths.mjs'

export const API = 'https://api.appstoreconnect.apple.com'
/** A token lives at most 20 minutes (Apple's limit). */
const TOKEN_SECONDS = 19 * 60

const text = (env, key) => (typeof env[key] === 'string' ? env[key].trim() : '')

export class AscError extends Error {}

/** The person's API key from env; throws before anything else happens when any part is missing. */
export function keyFrom(env, exists = existsSync) {
  const keyPath = text(env, 'APPLE_API_KEY')
  const keyId = text(env, 'APPLE_API_KEY_ID')
  const issuer = text(env, 'APPLE_API_ISSUER')
  const missing = [['APPLE_API_KEY', keyPath], ['APPLE_API_KEY_ID', keyId], ['APPLE_API_ISSUER', issuer]].filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) throw new AscError(`asc.mjs runs only with your App Store Connect API key: set ${missing.join(', ')} (docs/release.md). Nothing was sent.`)
  if (!exists(keyPath)) throw new AscError(`APPLE_API_KEY points at ${keyPath}, which doesn't exist. Nothing was sent.`)
  return { keyPath, keyId, issuer }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

/** An ES256 JWT for the App Store Connect API. */
export function makeToken({ privateKey, keyId, issuer, now = Date.now() }) {
  const iat = Math.floor(now / 1000)
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss: issuer, iat, exp: iat + TOKEN_SECONDS, aud: 'appstoreconnect-v1' }))
  const input = `${header}.${payload}`
  const signature = sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64url(signature)}`
}

/** A tiny JSON:API client. `fetch` is injectable (tests hand in a fake API). */
export function createClient({ token, fetch: doFetch = globalThis.fetch, base = API }) {
  const request = async (method, path, body) => {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status === 204) return null
    const raw = await res.text()
    const json = raw ? JSON.parse(raw) : null
    if (!res.ok) {
      const err = json?.errors?.[0]
      throw new AscError(`${method} ${path.split('?')[0]} failed (${res.status}): ${err?.detail ?? err?.title ?? raw.slice(0, 200)}`)
    }
    return json
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    delete: (path) => request('DELETE', path),
  }
}

const query = (params) =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')

export function parseArgs(argv) {
  const opts = { apply: false, recreate: false, capabilities: [], bundleId: null, name: null, certificate: null, profileName: null, out: null }
  const value = (i, flag) => {
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) throw new AscError(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') opts.apply = true
    else if (a === '--recreate') opts.recreate = true
    else if (a === '--capability') opts.capabilities.push(value(i++, a))
    else if (a === '--bundle-id') opts.bundleId = value(i++, a)
    else if (a === '--name') opts.name = value(i++, a)
    else if (a === '--certificate') opts.certificate = value(i++, a)
    else if (a === '--profile-name') opts.profileName = value(i++, a)
    else if (a === '--out') opts.out = value(i++, a)
    else throw new AscError(`unknown option ${a}`)
  }
  return opts
}

/** The SHA-1 of a certificate's DER content, as the keychain names identities. */
export const certificateHash = (base64Der) => createHash('sha1').update(Buffer.from(base64Der, 'base64')).digest('hex').toUpperCase()

/** Which Developer ID Application certificate the profile names. */
export function pickCertificate(certs, { id, hash }) {
  if (id) {
    const found = certs.find((c) => c.id === id)
    if (!found) throw new AscError(`no Developer ID Application certificate with id ${id} (found ${certs.map((c) => c.id).join(', ') || 'none'})`)
    return found
  }
  const byHash = certs.find((c) => c.attributes?.certificateContent && certificateHash(c.attributes.certificateContent) === hash)
  if (byHash) return byHash
  if (certs.length === 1) return certs[0]
  if (!certs.length) throw new AscError('the account has no Developer ID Application certificate. Create one first (docs/release.md)')
  const which = hash ? `and none is ${hash}` : 'and ATELIER_SIGN_IDENTITY names no SHA-1 to pick one'
  throw new AscError(
    `several Developer ID Application certificates, ${which}: pass --certificate <id> (${certs.map((c) => `${c.id}, expires ${String(c.attributes?.expirationDate ?? '?').slice(0, 10)}`).join('; ')})`,
  )
}

/**
 * The whole run. Reads always; writes (POST, DELETE, the profile file) only with --apply.
 * Returns the plan: what was done, or would be.
 */
export async function runAsc({ argv = [], env = process.env, fetch: doFetch, readFile = readFileSync, exists = existsSync, write = writeFileSync, log = console.log, now = Date.now(), decode = process.platform === 'darwin' ? decodeProfile : null, repo = REPO } = {}) {
  const opts = parseArgs(argv)
  // The App ID's name: --name, else the branding's (Atelier for official builds).
  opts.name ??= loadBranding(env).name
  const key = keyFrom(env, exists)
  const bundleId = bundleIdFrom(opts.bundleId ? { ATELIER_BUNDLE_ID: opts.bundleId } : env)
  const teamId = requireTeamId(env, 'asc.mjs (it checks the profile against your team; nothing was sent)')
  const token = makeToken({ privateKey: createPrivateKey(readFile(key.keyPath)), keyId: key.keyId, issuer: key.issuer, now })
  const api = createClient({ token, fetch: doFetch })
  const plan = []
  const step = (what) => {
    plan.push(what)
    log(`${opts.apply ? '' : '(dry run) would '}${what}`)
  }
  log(`App Store Connect: ${bundleId} for team ${teamId}${opts.apply ? '' : ' (dry run: nothing is changed; add --apply)'}`)

  // 1. The App ID.
  const found = await api.get(`/v1/bundleIds?${query({ 'filter[identifier]': bundleId, limit: 200 })}`)
  let bundle = (found?.data ?? []).find((b) => b.attributes?.identifier === bundleId && ['MAC_OS', 'UNIVERSAL'].includes(b.attributes?.platform)) ?? null
  if (bundle) log(`the App ID ${bundleId} is registered (${bundle.id})`)
  else {
    step(`register the App ID ${bundleId} ("${opts.name}", macOS)`)
    if (opts.apply) bundle = (await api.post('/v1/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: bundleId, name: opts.name, platform: 'MAC_OS' } } })).data
  }

  // 2. Capabilities asked for on the command line.
  const have = bundle ? ((await api.get(`/v1/bundleIds/${bundle.id}/bundleIdCapabilities?limit=200`))?.data ?? []).map((c) => c.attributes?.capabilityType) : []
  for (const type of opts.capabilities) {
    if (have.includes(type)) {
      log(`the App ID already has ${type}`)
      continue
    }
    step(`enable ${type} on ${bundleId}`)
    if (opts.apply) await api.post('/v1/bundleIdCapabilities', { data: { type: 'bundleIdCapabilities', attributes: { capabilityType: type }, relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } } } })
  }

  // 3. The Developer ID Application certificate the profile names.
  const certs = (await api.get(`/v1/certificates?${query({ 'filter[certificateType]': 'DEVELOPER_ID_APPLICATION', limit: 200 })}`))?.data ?? []
  const cert = pickCertificate(certs, { id: opts.certificate, hash: preferredIdentity(env) })
  log(`the profile names the certificate ${cert.id} (${cert.attributes?.displayName ?? cert.attributes?.name ?? 'Developer ID Application'}, expires ${String(cert.attributes?.expirationDate ?? '?').slice(0, 10)})`)

  // 4. The Developer ID profile (MAC_APP_DIRECT).
  const profileName = opts.profileName ?? `Atelier Developer ID ${bundleId}`
  const listed = (await api.get(`/v1/profiles?${query({ 'filter[name]': profileName, 'filter[profileType]': 'MAC_APP_DIRECT', limit: 200 })}`))?.data ?? []
  let profile = listed.find((p) => p.attributes?.name === profileName) ?? null
  if (profile && opts.recreate) {
    step(`delete the profile "${profileName}" (${profile.id}) to make it again`)
    if (opts.apply) await api.delete(`/v1/profiles/${profile.id}`)
    profile = null
  }
  if (!profile) {
    step(`create the Developer ID profile "${profileName}" for ${bundleId}`)
    if (opts.apply) {
      const body = {
        data: {
          type: 'profiles',
          attributes: { name: profileName, profileType: 'MAC_APP_DIRECT' },
          relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } }, certificates: { data: [{ type: 'certificates', id: cert.id }] } },
        },
      }
      profile = (await api.post('/v1/profiles', body)).data
    }
  } else log(`the profile "${profileName}" exists (${profile.id}); --recreate makes a new one`)

  // 5. Write it, and check it the way the build will.
  const outArg = opts.out ?? join('build', 'generated', `${bundleId}.provisionprofile`)
  const out = isAbsolute(outArg) ? outArg : resolve(repo, outArg)
  if (!opts.apply) {
    step(`write the profile to ${out}`)
    log('(dry run) nothing was changed. Run again with --apply.')
    return { plan, applied: false, out: null, problems: null }
  }
  const content = profile.attributes?.profileContent ?? (await api.get(`/v1/profiles/${profile.id}`))?.data?.attributes?.profileContent
  if (!content) throw new AscError(`the profile ${profile.id} came back without its content`)
  mkdirSync(dirname(out), { recursive: true })
  write(out, Buffer.from(content, 'base64'))
  plan.push(`write the profile to ${out}`)
  log(`wrote ${out}`)
  let problems = null
  if (decode) {
    problems = profileProblems(decode(out), { teamId, bundleId, now: new Date(now) })
    if (problems.length) log(`the profile can't sign a passkeys build yet:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    else log('the profile grants the browser passkey entitlement')
  }
  log(`export ATELIER_PROVISIONING_PROFILE="${out}"`)
  return { plan, applied: true, out, problems }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    loadReleaseEnv()
    await runAsc({ argv: process.argv.slice(2) })
  } catch (err) {
    console.error(`asc: ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  }
}
