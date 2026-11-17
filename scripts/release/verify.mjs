#!/usr/bin/env node
/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// Verifies a packaged Apex before it ships:
//   - the Resources folder holds the icons, the tray, the native helpers, app.asar
//     and (with a release repo) app-update.yml,
//     and the asar carries licenses.json (served at app://apex/licenses.json);
//   - macOS: Info.plist has the usage strings, the URL and document types, a
//     matching icon and the bundle id; codesign verifies; the entitlements fit
//     the signing mode (no restricted key without its profile); each native
//     helper (speech, calendar, translate) is signed like the app and carries
//     its own usage strings; when notarized, spctl and stapler agree;
//   - the fuses in the binary match electron-builder.yml (@electron/fuses);
//   - Windows: the installer's Authenticode signature, when signing was configured;
//   - the smoke test passes inside the packaged app (smoke-packaged.mjs).
// Every arch under dist/ gets the static checks; the smoke test runs the one
// this machine can launch natively.
//
//   node scripts/release/verify.mjs [--public] [--no-smoke]
//
// The signing and public-release expectations come from the same env as the
// build (scripts/release/config.mjs, internal/release.env included).

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { teamIdFrom } from './bundle.mjs'
import { MAC_HELPERS, codesignDetails, entitlementProblems, expectedFuses, expectedResources, fuseProblems, fusesFromWire, helperProblems, infoPlistFromOtool, ofVersion, plistProblems } from './checks.mjs'
import { loadReleaseEnv, releaseSettings } from './config.mjs'
import { readEntitlements, signingMode } from './entitlements.mjs'
import { DIST, REPO, packageJson, packagedApps } from './paths.mjs'
import { smokePackaged } from './smoke-packaged.mjs'

const require = createRequire(import.meta.url)

/** electron-builder.yml as electron-builder itself reads it. */
async function builderConfig() {
  const { getConfig } = require('app-builder-lib/out/util/config/config')
  return getConfig(REPO, null, null)
}

function resourceProblems(app, platform, settings) {
  const { required, optional } = expectedResources(platform)
  const problems = required.filter((p) => !existsSync(join(app.resources, p))).map((p) => `Resources is missing ${p}`)
  // electron-updater reads where to look from app-update.yml, written whenever there is a publish target.
  if (settings.repo && !existsSync(join(app.resources, 'app-update.yml'))) problems.push('Resources has no app-update.yml, so the updater has no feed')
  for (const o of optional) {
    if (existsSync(join(REPO, o.source)) && !existsSync(join(app.resources, o.path))) problems.push(`Resources is missing ${o.path} (built at ${o.source})`)
  }
  const asar = join(app.resources, 'app.asar')
  if (existsSync(asar)) {
    const { listPackage } = require('@electron/asar')
    const files = new Set(listPackage(asar, { isPack: false }).map((f) => f.replaceAll('\\', '/')))
    if (!files.has('/out/renderer/licenses.json')) problems.push('app.asar has no out/renderer/licenses.json (npm run licenses)')
  }
  return problems
}

/** The fuse wire as @electron/fuses reads it. */
async function readFuses(app) {
  const target = process.platform === 'darwin' ? app.app : app.executable
  const { getCurrentFuseWire, FuseV1Options } = await import('@electron/fuses')
  const names = Object.fromEntries(Object.entries(FuseV1Options).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k]))
  return { tool: '@electron/fuses', slices: [fusesFromWire(await getCurrentFuseWire(target), names)] }
}

function macProblems(app, { signed, notarized, dmgs, settings }) {
  const problems = []
  const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', join(app.app, 'Contents', 'Info.plist')], { encoding: 'utf8' }))
  problems.push(...plistProblems(plist, { assetCatalog: existsSync(join(app.resources, 'Assets.car')) }))
  if (plist.CFBundleIdentifier !== settings.bundleId) problems.push(`Info.plist's CFBundleIdentifier is ${plist.CFBundleIdentifier}, not ${settings.bundleId}`)
  // Restricted entitlements only with the profile that grants them (entitlements.mjs).
  const ents = readEntitlements(spawnSync('codesign', ['-d', '--entitlements', '-', '--xml', app.app], { encoding: 'utf8' }).stdout)
  // The app id <TEAMID>.<bundle id> is checked only in the passkeys mode, which needs APEX_TEAM_ID.
  const teamId = teamIdFrom(process.env)
  problems.push(...entitlementProblems(ents, { mode: signingMode(process.env), embeddedProfile: existsSync(join(app.app, 'Contents', 'embedded.provisionprofile')), appId: teamId ? `${teamId}.${settings.bundleId}` : null }))
  // Ad hoc (unsigned) builds must verify too: Apple silicon kills a broken signature.
  const codesign = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app.app], { encoding: 'utf8' })
  if (codesign.status !== 0) problems.push(`codesign --verify failed: ${codesign.stderr.trim()}`)
  let appTeam = null
  if (signed) {
    const info = spawnSync('codesign', ['-dvv', app.app], { encoding: 'utf8' })
    if (!/flags=.*runtime/.test(info.stderr)) problems.push('the app is signed without the hardened runtime')
    appTeam = codesignDetails(info.stderr).team
  }
  problems.push(...helperChecks(app, { signed, bundleId: settings.bundleId, appTeam }))
  if (notarized) {
    const spctl = spawnSync('spctl', ['-a', '-vv', app.app], { encoding: 'utf8' })
    if (spctl.status !== 0) problems.push(`spctl rejects the app: ${spctl.stderr.trim()}`)
    for (const target of [app.app, ...dmgs]) {
      const staple = spawnSync('xcrun', ['stapler', 'validate', target], { encoding: 'utf8' })
      if (staple.status !== 0) problems.push(`no stapled ticket on ${target}`)
    }
  }
  return problems
}

/** The helpers in Resources: each signature, and the usage strings in each embedded Info.plist (a missing helper is resourceProblems'). */
function helperChecks(app, { signed, bundleId, appTeam }) {
  const problems = []
  for (const spec of MAC_HELPERS) {
    const file = join(app.resources, spec.path)
    if (!existsSync(file)) continue
    const verify = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', file], { encoding: 'utf8' })
    const details = codesignDetails(spawnSync('codesign', ['-dvv', file], { encoding: 'utf8' }).stderr ?? '')
    const otool = spawnSync('otool', ['-X', '-s', '__TEXT', '__info_plist', file], { encoding: 'utf8' })
    const plist = otool.status === 0 ? infoPlistFromOtool(otool.stdout) : null
    problems.push(...helperProblems(spec, { plist, bundleId, verify: { ok: verify.status === 0, error: (verify.stderr ?? '').trim() }, details, signed, appTeam }))
  }
  return problems
}

function windowsProblems({ signed, version }) {
  if (!signed) return []
  const problems = []
  for (const exe of ofVersion(readdirSync(DIST), version).filter((n) => n.endsWith('.exe'))) {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${join(DIST, exe).replaceAll("'", "''")}').Status`], { encoding: 'utf8' })
    if (ps.stdout.trim() !== 'Valid') problems.push(`${exe} has no valid signature (${ps.stdout.trim() || ps.stderr.trim()})`)
  }
  return problems
}

/** Everything wrong with the packaged app for this machine; [] when it can ship. */
export async function verify({ settings = releaseSettings(), version = packageJson().version, smoke = true, log = console.log } = {}) {
  const apps = packagedApps()
  if (!apps.length) return ['no packaged app for this platform under dist/']
  const platform = process.platform
  const signed = settings.signing.identity !== null
  const want = expectedFuses((await builderConfig()).electronFuses)
  const dmgs = existsSync(DIST) ? ofVersion(readdirSync(DIST), version).filter((n) => n.endsWith('.dmg')).map((n) => join(DIST, n)) : []
  const problems = []
  for (const [i, app] of apps.entries()) {
    const tag = (p) => (apps.length > 1 ? `${app.arch}: ${p}` : p)
    const own = resourceProblems(app, platform, settings)
    const { tool, slices } = await readFuses(app)
    for (const slice of slices) own.push(...fuseProblems(want, slice))
    log(`verify: ${app.arch} fuses read with ${tool}`)
    // The dmgs are checked once, with the first app.
    if (platform === 'darwin') own.push(...macProblems(app, { signed, notarized: settings.signing.notarize !== null, dmgs: i === 0 ? dmgs : [], settings }))
    problems.push(...own.map(tag))
  }
  if (platform === 'win32') problems.push(...windowsProblems({ signed, version }))

  const app = apps[0]
  if (smoke) {
    if (problems.length) log('verify: skipping the packaged smoke test until the problems above are fixed')
    else problems.push(...(await smokePackaged({ executable: app.executable, publicRelease: settings.publicRelease })))
  }
  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  // The same env as the build: internal/release.env under the real environment.
  loadReleaseEnv()
  const settings = releaseSettings()
  if (argv.includes('--public')) settings.publicRelease = true
  const problems = await verify({ settings, smoke: !argv.includes('--no-smoke') })
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`)
    process.exit(1)
  }
  console.log('verify: the packaged app is ready to ship')
}
