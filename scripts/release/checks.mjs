/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The pure checks behind verify.mjs, smoke-packaged.mjs, checksums.mjs and
// support-feed.mjs, kept apart from the file system and child
// processes so tests/release.test.ts covers them.

import { compareVersions } from './config.mjs'
import { BROWSER_PASSKEY_ENTITLEMENT, isRestricted } from './entitlements.mjs'

// ---------------------------------------------------------------------------
// Fuses: electron-builder.yml's electronFuses against what the binary holds.

/** electron-builder's camelCase key to Electron's fuse name: runAsNode → RunAsNode. */
export const fuseName = (key) => key.charAt(0).toUpperCase() + key.slice(1)

/** Keys in electronFuses that configure the build rather than a fuse. */
const NOT_FUSES = new Set(['resetAdHocDarwinSignature', 'strictlyRequireAllFuses'])

/** { RunAsNode: false, ... } from the yml's electronFuses. */
export function expectedFuses(electronFuses) {
  const out = {}
  for (const [key, value] of Object.entries(electronFuses ?? {})) {
    if (!NOT_FUSES.has(key) && typeof value === 'boolean') out[fuseName(key)] = value
  }
  return out
}

/** Reads @electron/fuses' getCurrentFuseWire into [{ name, enabled }]. ENABLE is 49 ('1'). */
export function fusesFromWire(wire, names) {
  return Object.entries(wire)
    .filter(([k]) => /^\d+$/.test(k) && names[Number(k)] !== undefined)
    .map(([k, state]) => ({ name: names[Number(k)], enabled: state === 49 }))
}

/** Every way a read fuse wire differs from the yml. */
export function fuseProblems(expected, actual) {
  const problems = []
  const seen = new Map(actual.map((f) => [f.name, f.enabled]))
  for (const [name, want] of Object.entries(expected)) {
    if (!seen.has(name)) problems.push(`fuse ${name} is missing from the binary`)
    else if (seen.get(name) !== want) problems.push(`fuse ${name} is ${seen.get(name) ? 'enabled' : 'disabled'}, electron-builder.yml says ${want ? 'enabled' : 'disabled'}`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// The packaged app's Info.plist and resources.

/** Usage strings a hardened, signed Atelier must carry, or macOS refuses (or kills) the request. */
export const MAC_USAGE_KEYS = [
  'NSMicrophoneUsageDescription',
  'NSCameraUsageDescription',
  'NSLocationWhenInUseUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSAudioCaptureUsageDescription',
  'NSSpeechRecognitionUsageDescription',
  // macOS 15+ shows the Local Network prompt for any browser; without the string it can't say why.
  'NSLocalNetworkUsageDescription',
]

/** What verify.mjs checks in Contents/Info.plist (as JSON, from plutil). */
export function plistProblems(plist, { assetCatalog }) {
  const problems = []
  for (const key of MAC_USAGE_KEYS) {
    const v = plist[key]
    if (typeof v !== 'string' || v.trim().length < 10) problems.push(`Info.plist has no ${key}`)
  }
  const schemes = (plist.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? [])
  for (const s of ['http', 'https']) if (!schemes.includes(s)) problems.push(`Info.plist doesn't claim the ${s} scheme`)
  const exts = (plist.CFBundleDocumentTypes ?? []).flatMap((t) => t.CFBundleTypeExtensions ?? [])
  for (const e of ['ateliercompanion', 'atelierpack', 'html']) if (!exts.includes(e)) problems.push(`Info.plist has no document type for .${e}`)
  if (plist.CFBundleIconFile == null) problems.push('Info.plist has no CFBundleIconFile (the .icns fallback)')
  // CFBundleIconName must name the icon in Assets.car, or the Dock shows a generic icon.
  // The official branding's Atelier.icon compiles to "Atelier" (afterPack.mjs); electron-builder's own compile says "Icon".
  if (assetCatalog && plist.CFBundleIconName !== 'Atelier' && plist.CFBundleIconName !== 'Icon') problems.push(`Assets.car is there but CFBundleIconName is ${JSON.stringify(plist.CFBundleIconName ?? null)}, not "Atelier"`)
  if (!assetCatalog && plist.CFBundleIconName != null) problems.push('CFBundleIconName is set without an Assets.car')
  return problems
}

/**
 * What verify.mjs checks in the app's signed entitlements (codesign -d --entitlements - --xml):
 * restricted keys only next to an embedded profile, and the browser passkey keys in that mode.
 */
export function entitlementProblems(entitlements, { mode, embeddedProfile, appId }) {
  const problems = []
  const restricted = Object.keys(entitlements).filter(isRestricted)
  if (mode !== 'developer-id-passkeys' || !embeddedProfile) {
    for (const key of restricted) problems.push(`the app claims ${key} without ${embeddedProfile ? 'the passkeys mode' : 'an embedded provisioning profile'}: macOS would refuse to launch it`)
  }
  if (mode === 'developer-id-passkeys') {
    if (!embeddedProfile) problems.push('Contents/embedded.provisionprofile is missing')
    if (entitlements[BROWSER_PASSKEY_ENTITLEMENT] !== true) problems.push(`the app isn't signed with ${BROWSER_PASSKEY_ENTITLEMENT}`)
    if (!appId) problems.push("com.apple.application-identifier can't be checked without your Apple Team ID: set ATELIER_TEAM_ID")
    else if (entitlements['com.apple.application-identifier'] !== appId) problems.push(`com.apple.application-identifier is ${JSON.stringify(entitlements['com.apple.application-identifier'] ?? null)}, not ${appId}`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// The native helpers in Contents/Resources. Each asks macOS in Atelier's name,
// so each must be signed like the app (notarization refuses one that isn't)
// and carry, in its embedded Info.plist, the usage strings macOS shows.

/** Each macOS helper: where it sits in Resources, its bundle id suffix, and the usage strings it needs. */
export const MAC_HELPERS = [
  { path: 'atelier-speech', helper: 'speech', usage: ['NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription'] },
  {
    path: 'atelier-calendar',
    helper: 'calendar',
    usage: ['NSCalendarsFullAccessUsageDescription', 'NSCalendarsUsageDescription', 'NSRemindersFullAccessUsageDescription', 'NSRemindersUsageDescription'],
  },
  { path: 'atelier-translate', helper: 'translate', usage: [] },
]

/** The embedded Info.plist's XML from `otool -X -s __TEXT __info_plist` (hex lines; a universal binary repeats it per slice), or null. */
export function infoPlistFromOtool(output) {
  const bytes = []
  for (const line of output.split(/\r?\n/)) {
    const m = /^[0-9a-f]+\s+((?:[0-9a-f]{2}\s*)+)$/i.exec(line.trim())
    if (m) for (const b of m[1].trim().split(/\s+/)) bytes.push(parseInt(b, 16))
  }
  const text = Buffer.from(bytes).toString('utf8')
  const start = text.indexOf('<?xml')
  const end = text.indexOf('</plist>', start)
  return start >= 0 && end > start ? text.slice(start, end + '</plist>'.length) : null
}

/** A plist's top-level string values, by key. */
export function plistStrings(xml) {
  return Object.fromEntries([...xml.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)].map((m) => [m[1], m[2]]))
}

/** The fields of `codesign -dvv` that matter here. */
export function codesignDetails(stderr) {
  return {
    runtime: /flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(stderr),
    team: /^TeamIdentifier=(?!not set)(.+)$/m.exec(stderr)?.[1]?.trim() ?? null,
    adhoc: /^Signature=adhoc$/m.test(stderr),
  }
}

/**
 * Everything wrong with one bundled helper: its signature (`verify` from
 * codesign --verify, `details` from codesign -dvv, the app's own team when
 * signed) and its embedded Info.plist (the XML, or null when there is none).
 */
export function helperProblems(spec, { plist, bundleId, verify, details, signed, appTeam }) {
  const problems = []
  const name = spec.path
  if (!verify.ok) problems.push(`${name}: codesign --verify failed: ${verify.error}`)
  if (signed) {
    if (details.adhoc) problems.push(`${name} is signed ad hoc, not with the app's identity`)
    if (!details.runtime) problems.push(`${name} is signed without the hardened runtime`)
    if (appTeam && details.team !== appTeam) problems.push(`${name} is signed by team ${details.team ?? 'none'}, not the app's ${appTeam}`)
  }
  if (!plist) {
    problems.push(`${name} has no embedded Info.plist, so macOS can't say why it asks`)
    return problems
  }
  const strings = plistStrings(plist)
  const id = `${bundleId}.${spec.helper}`
  if (strings.CFBundleIdentifier !== id) problems.push(`${name}'s CFBundleIdentifier is ${JSON.stringify(strings.CFBundleIdentifier ?? null)}, not ${id}`)
  for (const key of spec.usage) {
    if (typeof strings[key] !== 'string' || strings[key].trim().length < 10) problems.push(`${name}'s Info.plist has no ${key}`)
  }
  return problems
}

/**
 * Files the packaged app's Resources folder must hold, per platform.
 * `optional` entries are checked only when their source exists in the repo.
 */
export function expectedResources(platform) {
  // The branding's resources/ folder (scripts/branding.mjs), packaged as resources/.
  const icons = [32, 64, 128, 256, 512].map((s) => `resources/icons/app-${s}.png`)
  if (platform === 'darwin') {
    return {
      required: [...icons, 'resources/tray/trayTemplate.png', 'resources/tray/trayTemplate@2x.png', 'atelier-speech', 'app.asar'],
      optional: [
        // Haptics have a no-op fallback, so the addon ships whenever it built.
        { path: 'native/atelier_haptics.node', source: 'native/haptics/build/atelier_haptics.node' },
        { path: 'atelier-calendar', source: 'native/calendar/build/atelier-calendar' },
        { path: 'atelier-translate', source: 'native/translate/build/atelier-translate' },
      ],
    }
  }
  if (platform === 'win32') {
    return {
      required: [...icons, 'resources/tray/tray-light.ico', 'resources/tray/tray-dark.ico', 'html-document.ico', 'ateliercompanion.ico', 'atelierpack.ico', 'app.asar'],
      optional: [{ path: 'atelier-speech.exe', source: 'native/speech-win/build/atelier-speech.exe' }],
    }
  }
  return { required: [...icons, 'resources/tray/tray.png', 'resources/tray/tray@2x.png', 'app.asar'], optional: [] }
}

// ---------------------------------------------------------------------------
// The packaged smoke run.

/** Must match the check in src/main/smokeMaintenance/release.ts; the smoke runner prefixes its group, "MAINTENANCE: ". */
export const PUBLIC_FLAG_CHECK = 'MAINTENANCE: release: a public build offers your Claude subscription and the API key'

/** Parses the smoke runner's "PASS  name" / "FAIL  name" lines and its summary. */
export function smokeSummary(output) {
  const results = new Map()
  for (const line of output.split(/\r?\n/)) {
    const m = /^(PASS|FAIL) {2}(.+?)(?: {2}— .*)?$/.exec(line)
    if (m) results.set(m[2], m[1] === 'PASS')
  }
  const total = /(\d+)\/(\d+) smoke checks passed/.exec(output)
  return {
    results,
    failed: [...results].filter(([, ok]) => !ok).map(([name]) => name),
    passed: total ? Number(total[1]) : 0,
    total: total ? Number(total[2]) : 0,
  }
}

/** Why a packaged smoke run fails the release, or []. */
export function smokeProblems(summary, { exitCode, publicRelease }) {
  const problems = []
  if (summary.total === 0) problems.push('the packaged app printed no smoke summary')
  if (summary.failed.length) problems.push(`failed checks: ${summary.failed.join('; ')}`)
  if (exitCode !== 0 && !summary.failed.length) problems.push(`the packaged app exited with ${exitCode}`)
  // A public build must prove it offers both engines, not just not fail.
  if (publicRelease && summary.results.get(PUBLIC_FLAG_CHECK) !== true) problems.push(`a public release needs "${PUBLIC_FLAG_CHECK}" to pass`)
  return problems
}

// ---------------------------------------------------------------------------
// Release assets.

/**
 * The names in dist/ that belong to `version`. dist/ keeps earlier builds'
 * installers, which a release must not notarize, check, checksum or upload
 * again. Names without a version (the update feeds) always belong; 1.3.0
 * doesn't take 1.3.0-beta.1's files.
 */
export function ofVersion(names, version) {
  const own = new RegExp(`(^|[-_])${version.replace(/\./g, '\\.')}(?!-beta\\.)([-_.]|$)`)
  return names.filter((n) => own.test(n) || !/\d+\.\d+\.\d+/.test(n))
}

/** Installers and update archives that SHA256SUMS covers. */
export const CHECKSUMMED = /\.(dmg|zip|exe|AppImage|deb)$/

/** SHA256SUMS in `sha256sum -c` format, sorted by name. */
export function checksumLines(files) {
  return [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => {
      if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`bad sha256 for ${f.name}`)
      if (/[\r\n]/.test(f.name)) throw new Error(`bad file name ${JSON.stringify(f.name)}`)
      return `${f.sha256}  ${f.name}\n`
    })
    .join('')
}

export const SUPPORT_MESSAGE_MAX = 280

/**
 * atelier-support.json (the updater's SupportFeed): versions below `below` are told to
 * update. Validated, deduplicated and sorted newest first.
 */
export function supportFeed(entries) {
  const byBelow = new Map()
  for (const e of entries) {
    if (typeof e?.below !== 'string' || !/^\d+\.\d+\.\d+$/.test(e.below)) throw new Error(`"below" must be x.y.z, got ${JSON.stringify(e?.below)}`)
    const entry = { below: e.below }
    if (e.message != null) {
      const message = String(e.message).trim()
      if (message.length > SUPPORT_MESSAGE_MAX) throw new Error(`the message for ${e.below} is over ${SUPPORT_MESSAGE_MAX} characters`)
      if (message) entry.message = message
    }
    byBelow.set(e.below, entry)
  }
  return { schema: 1, unsupported: [...byBelow.values()].sort((a, b) => compareVersions(b.below, a.below)) }
}

/** What release.mjs uploads to the draft: installers, update archives, blockmaps and the update feeds. */
export const UPLOADED = /(\.(dmg|zip|exe|AppImage|deb|blockmap)|^(latest|beta|alpha)(-mac|-linux(-[a-z0-9]+)?)?\.yml)$/

/**
 * The files in dist/ to upload, sorted. GitHub renames an asset whose name has
 * a space, which would break the update feed's links, so those throw.
 */
export function uploadsFrom(names) {
  const picked = names.filter((n) => UPLOADED.test(n)).sort()
  const spaced = picked.filter((n) => /\s/.test(n))
  if (spaced.length) throw new Error(`asset names with spaces don't survive the upload: ${spaced.join(', ')} (set artifactName in electron-builder.yml)`)
  return picked
}

/**
 * An electron-builder update feed (latest-mac.yml and friends) with new
 * sha512 and size for files changed after it was written: stapling a dmg
 * changes its bytes. Lines for other files are left exactly as they were.
 */
export function refreshFeed(yml, changed) {
  const byName = new Map(changed.map((c) => [c.name, c]))
  const unquote = (v) => v.trim().replace(/^(['"])(.*)\1$/, '$2')
  let current = null
  return yml
    .split('\n')
    .map((line) => {
      const item = /^\s*- url: (.+)$/.exec(line)
      if (item) {
        current = byName.get(unquote(item[1])) ?? null
        return line
      }
      const top = /^path: (.+)$/.exec(line)
      if (top) current = byName.get(unquote(top[1])) ?? null
      else if (/^\S/.test(line) && !/^(sha512|size): /.test(line)) current = null
      if (!current) return line
      const sha = /^(\s*)sha512: /.exec(line)
      if (sha) return `${sha[1]}sha512: ${current.sha512}`
      const size = /^(\s*)size: /.exec(line)
      if (size) return `${size[1]}size: ${current.size}`
      return line
    })
    .join('\n')
}
