#!/usr/bin/env node
/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// The branding's name and icon for a dev run (macOS): Apex, or Summit for the
// unofficial branding (scripts/branding.mjs, APEX_OFFICIAL_BRANDING).
//
//   node scripts/dev-branding.mjs     runs from `predev` and after `postinstall`
//
// `npm run dev` starts node_modules/electron/dist/Electron.app, whose
// Info.plist and icon say "Electron": the menu bar, the Dock, the app
// switcher, the About panel, notifications, login items and dialogs all read
// them. This renames that bundle after the branding (its helpers too, so
// Activity Monitor lists "Apex Helper (Renderer)") and copies the branding's
// icon.icns over its icon. The packaged app gets the same names from
// electron-builder (productName) and needs none of this. Switching brandings
// renames the bundle again on the next `npm run dev`.
//
// Idempotent: a file is only written when its bytes change, and only then is
// the bundle touched and re-registered, so Launch Services and the Dock drop
// their cached name and icon. The bundle is ad hoc, linker-signed with no
// sealed resources, so editing Info.plist leaves its signature valid. Nothing
// here fails an install or a dev run: problems are printed and skipped.
// npm reinstalls Electron.app on every install of electron, and postinstall
// runs this again.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadBranding } from './branding.mjs'

/** The official branding's name; brandDevApp names the bundle after the active branding. */
export const APP_NAME = 'Apex'
const DEV_NAME = 'Electron'
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
// Keys are plain identifiers (CFBundleName and the like), so they need no escaping.
const keyPattern = (key) => new RegExp(`(<key>${key}</key>\\s*)(?:<string>([^<]*)</string>|<string\\s*/>)`)

/** A top-level string value of an XML plist, or null. */
export function plistString(text, key) {
  const match = keyPattern(key).exec(text)
  return match ? unescapeXml(match[2] ?? '') : null
}

/** The plist text with `key` set to `value`; a missing key is added at the end of the top-level dict. */
export function setPlistString(text, key, value) {
  const pattern = keyPattern(key)
  if (pattern.test(text)) return text.replace(pattern, (_m, open) => `${open}<string>${escapeXml(value)}</string>`)
  const end = text.lastIndexOf('</dict>')
  if (end < 0 || !text.includes('<plist')) throw new Error('This is not an XML property list.')
  const indent = /\n([ \t]*)<key>/.exec(text)?.[1] ?? '\t'
  return `${text.slice(0, end)}${indent}<key>${key}</key>\n${indent}<string>${escapeXml(value)}</string>\n${text.slice(end)}`
}

/** Electron.app's Info.plist with the app's names (CFBundleName, CFBundleDisplayName). Everything else stays. */
export function brandInfoPlist(text, name = APP_NAME) {
  return setPlistString(setPlistString(text, 'CFBundleName', name), 'CFBundleDisplayName', name)
}

/**
 * A helper's Info.plist: "Electron Helper (GPU)" becomes "Apex Helper (GPU)",
 * and a helper named after another branding ("Summit Helper (GPU)") is renamed
 * too; other names stay.
 */
export function brandHelperPlist(text, name = APP_NAME, others = []) {
  let out = text
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    const value = plistString(out, key)
    const from = value ? [DEV_NAME, ...others].find((prefix) => value.startsWith(`${prefix} Helper`)) : undefined
    if (value && from && from !== name) out = setPlistString(out, key, name + value.slice(from.length))
  }
  return out
}

function readPlistText(path) {
  const bytes = readFileSync(path)
  // A binary plist is turned into XML first (plutil ships with macOS).
  if (bytes.subarray(0, 6).toString('latin1') === 'bplist') {
    execFileSync('plutil', ['-convert', 'xml1', path], { stdio: 'ignore' })
    return readFileSync(path, 'utf8')
  }
  return bytes.toString('utf8')
}

/**
 * Brands the dev bundle under `repo` with `branding` (the active one by
 * default). Returns the files it changed (empty when everything already
 * matched) or why it skipped.
 */
export function brandDevApp({ repo = REPO, platform = process.platform, refresh = refreshBundle, branding: given, others = ['Apex', 'Summit'] } = {}) {
  if (platform !== 'darwin') return { changed: [], skipped: 'not macOS' }
  const bundle = join(repo, 'node_modules', 'electron', 'dist', 'Electron.app')
  const plistPath = join(bundle, 'Contents', 'Info.plist')
  if (!existsSync(plistPath)) return { changed: [], skipped: 'Electron is not installed' }
  const branding = given ?? loadBranding(process.env, repo)
  const changed = []
  const rewrite = (path, brand) => {
    const before = readPlistText(path)
    const after = brand(before)
    if (after !== before) {
      writeFileSync(path, after)
      changed.push(path)
    }
  }

  rewrite(plistPath, (text) => brandInfoPlist(text, branding.name))
  const frameworks = join(bundle, 'Contents', 'Frameworks')
  for (const entry of existsSync(frameworks) ? readdirSync(frameworks) : []) {
    const helperPlist = join(frameworks, entry, 'Contents', 'Info.plist')
    if (entry.endsWith('.app') && existsSync(helperPlist)) rewrite(helperPlist, (text) => brandHelperPlist(text, branding.name, others))
  }

  const icon = join(branding.dir, branding.icons.mac)
  const iconFile = plistString(readFileSync(plistPath, 'utf8'), 'CFBundleIconFile') || 'electron.icns'
  const target = join(bundle, 'Contents', 'Resources', iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`)
  if (existsSync(icon) && (!existsSync(target) || !readFileSync(icon).equals(readFileSync(target)))) {
    copyFileSync(icon, target)
    changed.push(target)
  }

  if (changed.length > 0) refresh(bundle)
  return { changed }
}

/** Newer dates on the bundle, then a forced re-registration, so macOS shows the new name and icon. */
function refreshBundle(bundle) {
  const now = new Date()
  for (const path of [bundle, join(bundle, 'Contents'), join(bundle, 'Contents', 'Info.plist'), join(bundle, 'Contents', 'Resources')]) {
    try {
      utimesSync(path, now, now)
    } catch {
      // Best effort.
    }
  }
  try {
    execFileSync(LSREGISTER, ['-f', bundle], { stdio: 'ignore' })
  } catch {
    // lsregister moved or is missing: the touch above still invalidates the caches, just later.
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const branding = loadBranding()
    const { changed, skipped } = brandDevApp({ branding })
    if (!skipped && changed.length > 0) console.log(`dev-branding: the dev app is now called ${branding.name} (${changed.length} file${changed.length === 1 ? '' : 's'} updated)`)
  } catch (err) {
    console.warn(`dev-branding: skipped (${err instanceof Error ? err.message : String(err)})`)
  }
}
