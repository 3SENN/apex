/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EXTENSION_IMPORT_MAX, type ExtensionImportReport, type ImportableExtension } from '@shared/browserImport'
import { EXTENSION_ID } from '@shared/extensions'
import { localize, readManifest, type Manifest } from './extensions/manifest'
import { browserDefs, chromiumProfiles } from './importBrowsers'
import { mainT } from './i18n/mainT'

// Extensions from another Chromium browser (ST-46 X) and the Recommended
// shelf's Add (ST-40 R). Reading: the profile's Preferences and Secure
// Preferences say which extensions it has, where and whether they're on;
// each one's manifest (in the profile's Extensions folder) gives the name
// and where it updates from. Only what the person installed from a store
// counts: built-in, policy and default-installed ones are left out, and so
// are themes and apps. Installing goes through the Chrome Web Store with one
// confirmation for the batch; Electron and the network stay behind the
// StoreInstaller seam (importExtensionsStore.ts), so this file tests offline.

/** Chromium's ManifestLocation::kInternal: installed from a store or a package by the person. */
const LOCATION_INTERNAL = 1
const CHROME_STORE_UPDATE = /^https:\/\/clients2\.google\.com\/service\/update2\/crx\b/
/** Built into Chrome-family browsers even when listed as internal. */
const BUILT_IN = new Set(['ahfgeienlihckogmohjhadlkjgocpleb', 'nmmhkkegccagdldgiimedpiccmgmieda', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', 'neajdppkdcdipfabeoofebfddakdcjhd', 'nkeimhogjdpnpccoofpliimaahmaaome'])

/** One extension's entry in Preferences' extensions.settings, the fields Apex reads. */
export interface PrefEntry {
  location?: unknown
  from_webstore?: unknown
  path?: unknown
  manifest?: unknown
  disable_reasons?: unknown
  state?: unknown
  was_installed_by_default?: unknown
  was_installed_by_oem?: unknown
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** extensions.settings from each preferences file, merged field by field (later files win: pass Secure Preferences last). */
export function extensionSettings(...prefs: unknown[]): Map<string, PrefEntry> {
  const out = new Map<string, PrefEntry>()
  for (const file of prefs) {
    const settings = isObject(file) && isObject(file.extensions) ? file.extensions.settings : null
    if (!isObject(settings)) continue
    for (const [id, entry] of Object.entries(settings)) {
      if (!EXTENSION_ID.test(id) || !isObject(entry)) continue
      out.set(id, { ...out.get(id), ...entry })
    }
  }
  return out
}

/** On unless Chromium recorded a reason it is off (a bitmask in older builds, a list in newer ones) or the old state 0. */
export function prefEnabled(entry: PrefEntry): boolean {
  const reasons = entry.disable_reasons
  if (typeof reasons === 'number' && reasons !== 0) return false
  if (Array.isArray(reasons) && reasons.length > 0) return false
  return entry.state !== 0
}

/** Installed by the person (not built in, not by policy, not shipped by default). */
export function personInstalled(id: string, entry: PrefEntry): boolean {
  if (BUILT_IN.has(id)) return false
  if (entry.location !== LOCATION_INTERNAL) return false
  return entry.was_installed_by_default !== true && entry.was_installed_by_oem !== true
}

/** From the Chrome Web Store: its manifest updates from there (other stores update elsewhere), or Chromium says so. */
export function fromChromeStore(manifest: Manifest | null, entry: PrefEntry | null): boolean {
  const update = manifest?.update_url
  if (typeof update === 'string' && update) return CHROME_STORE_UPDATE.test(update)
  return entry?.from_webstore === true
}

/** Dotted versions, numerically ("1.10.0_0" after "1.9.3_0"). */
function compareVersionDirs(a: string, b: string): number {
  const pa = a.replace(/_\d+$/, '').split('.').map((n) => Number(n) || 0)
  const pb = b.replace(/_\d+$/, '').split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** The installed version folder: the one Preferences names when it stays inside Extensions/<id>/, else the newest there. */
export function versionDir(extensionsDir: string, id: string, prefPath: unknown): string | null {
  if (typeof prefPath === 'string' && /^[a-p]{32}\/[\w.-]+$/.test(prefPath) && prefPath.startsWith(`${id}/`) && !prefPath.includes('..')) {
    const dir = join(extensionsDir, prefPath)
    if (existsSync(join(dir, 'manifest.json'))) return dir
  }
  const root = join(extensionsDir, id)
  try {
    const versions = readdirSync(root)
      .filter((v) => /^[\w.-]+$/.test(v) && v !== '..' && existsSync(join(root, v, 'manifest.json')) && statSync(join(root, v)).isDirectory())
      .sort(compareVersionDirs)
    const newest = versions[versions.length - 1]
    return newest ? join(root, newest) : null
  } catch {
    return null
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown
  } catch {
    return null
  }
}

/** The name people see: the manifest's (resolved from _locales when it is a __MSG_ key), its short name, or the id. */
export function extensionName(dir: string | null, manifest: Manifest, id: string): string {
  for (const value of [manifest.name, manifest.short_name]) {
    if (typeof value !== 'string' || !value.trim()) continue
    const resolved = dir ? localize(dir, manifest, value) : value
    if (resolved && !/^__MSG_\w+__$/.test(resolved)) return resolved.trim().slice(0, 120)
  }
  return id
}

/** Themes and apps aren't extensions Apex runs. */
const notAnExtension = (m: Manifest): boolean => m.theme !== undefined || m.app !== undefined

/**
 * The extensions of one Chromium profile folder, enabled ones first, then
 * by name. Without readable preferences it falls back to the folders in
 * Extensions/ (each one's manifest still says where it came from).
 */
export function profileExtensions(profileDir: string, manifests?: Map<string, Manifest>): Omit<ImportableExtension, 'installed'>[] {
  const extensionsDir = join(profileDir, 'Extensions')
  const settings = extensionSettings(readJson(join(profileDir, 'Preferences')), readJson(join(profileDir, 'Secure Preferences')))
  const out: Omit<ImportableExtension, 'installed'>[] = []
  if (settings.size > 0) {
    for (const [id, entry] of settings) {
      if (!personInstalled(id, entry)) continue
      const dir = versionDir(extensionsDir, id, entry.path)
      const manifest = (dir ? readManifest(dir) : null) ?? (isObject(entry.manifest) ? (entry.manifest as Manifest) : null)
      if (!manifest || notAnExtension(manifest)) continue
      manifests?.set(id, manifest)
      out.push({ id, name: extensionName(dir, manifest, id), version: typeof manifest.version === 'string' ? manifest.version : '', enabled: prefEnabled(entry), onStore: fromChromeStore(manifest, entry) })
    }
  } else {
    let ids: string[] = []
    try {
      ids = readdirSync(extensionsDir).filter((d) => EXTENSION_ID.test(d) && !BUILT_IN.has(d))
    } catch {
      ids = []
    }
    for (const id of ids) {
      const dir = versionDir(extensionsDir, id, null)
      const manifest = dir ? readManifest(dir) : null
      if (!manifest || notAnExtension(manifest)) continue
      manifests?.set(id, manifest)
      out.push({ id, name: extensionName(dir, manifest, id), version: typeof manifest.version === 'string' ? manifest.version : '', enabled: true, onStore: fromChromeStore(manifest, null) })
    }
  }
  return out.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
}

/**
 * The extensions of a detected browser's profile, marked when this Apex
 * profile already has them. `manifests`, when given, collects each one's
 * local manifest (main uses it to say what each can do; it never crosses IPC).
 */
export function browserExtensions(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, browserId: string, profileId: string, installed: ReadonlySet<string>, manifests?: Map<string, Manifest>): ImportableExtension[] {
  const def = browserDefs(platform, home, env).find((d) => d.id === browserId)
  if (!def) throw new Error(mainT('settings.import.error.noBrowser'))
  if (def.kind !== 'chromium') return []
  if (!chromiumProfiles(def.root).some((p) => p.id === profileId)) throw new Error(mainT('settings.import.error.noProfile'))
  return profileExtensions(join(def.root, profileId), manifests).map((e) => ({ ...e, installed: installed.has(e.id) }))
}

// ── Installing from the Chrome Web Store ──

/** What a downloaded, verified package turned out to be. */
export interface PackageFacts {
  name: string
  supported: boolean
  reason: string | null
  manifestJson: string
  icon: string | null
  /** What the store's package can do, as the install prompt words it. */
  access: string[]
}

/** One pick of a batch; `access` is what the copy in the other browser can do (shown in the confirmation). */
export interface BatchItem {
  id: string
  name: string
  access?: readonly string[]
}

/** Electron and the network, seen from here. */
export interface StoreInstaller {
  installedIds(): ReadonlySet<string>
  /** The store's package for an id, or null when the store has no such extension. */
  download(id: string): Promise<Buffer | null>
  /** Verifies the package is the store's own for that id and reads its manifest. Throws when it isn't. */
  inspect(id: string, crx: Buffer): PackageFacts
  /** One confirmation for the whole batch; false when the person says no. */
  confirmBatch(items: readonly BatchItem[], browserName: string | null): Promise<boolean>
  /** The Web Store's own install prompt for one extension (its permissions); ok when the person says yes. */
  prompt(id: string, facts: PackageFacts): Promise<{ ok: boolean; unsupported: string | null }>
  /** Installs a verified package; `approved` is true after prompt() said yes. Resolves with its name. */
  install(id: string, crx: Buffer, approved: boolean): Promise<string>
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200)

/** Unique, well-formed ids, in the order given, at most EXTENSION_IMPORT_MAX. */
export function cleanPicks<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    if (!EXTENSION_ID.test(item.id) || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
    if (out.length >= EXTENSION_IMPORT_MAX) break
  }
  return out
}

/** How many extensions the batch confirmation lists before "and N more". */
const CONFIRM_NAMES = 10
/** How many of one extension's access lines it shows before "+N". */
const CONFIRM_ACCESS = 3

/** One line per extension with what it can do, then "and N more". */
export function confirmList(items: readonly BatchItem[]): string {
  const lines = items.slice(0, CONFIRM_NAMES).map((i) => {
    // Unknown (no local manifest): the name alone; the store's own prompt comes before it's added.
    if (!i.access) return i.name
    const access = i.access
    if (access.length === 0) return mainT('extImport.confirm.line', { name: i.name, access: mainT('extImport.confirm.noAccess') })
    const shown = access.slice(0, CONFIRM_ACCESS).join('; ')
    const extra = access.length - CONFIRM_ACCESS
    return mainT('extImport.confirm.line', { name: i.name, access: extra > 0 ? mainT('extImport.confirm.moreAccess', { access: shown, count: extra }) : shown })
  })
  const more = items.length - lines.length
  if (more > 0) lines.push(mainT('extImport.confirm.moreLines', { count: more }))
  return lines.join('\n')
}

/** True when the store's package can do something the confirmed copy couldn't (or nothing was shown for it). */
export function widensAccess(shown: readonly string[] | undefined, store: readonly string[]): boolean {
  if (!shown) return true
  return store.some((a) => !shown.includes(a))
}

/**
 * Adds a batch from the store: one confirmation that names each one and
 * what it can do (nothing is fetched before it), then each in turn. One
 * whose store version asks for more than the confirmation showed gets the
 * store's own prompt first. Not on the store, needs what Apex lacks,
 * declined or failed are reported and the rest carry on.
 */
export async function installBatch(io: StoreInstaller, items: readonly BatchItem[], browserName: string | null): Promise<ExtensionImportReport> {
  const report: ExtensionImportReport = { cancelled: false, added: [], skipped: [] }
  const installed = io.installedIds()
  const todo: BatchItem[] = []
  for (const item of cleanPicks(items)) {
    if (installed.has(item.id)) report.skipped.push({ id: item.id, name: item.name, reason: 'installed' })
    else todo.push(item)
  }
  if (todo.length === 0) return report
  if (!(await io.confirmBatch(todo, browserName))) return { cancelled: true, added: [], skipped: [] }
  for (const { id, name: itemName, access } of todo) {
    const item = { id, name: itemName }
    try {
      const crx = await io.download(id)
      if (!crx) {
        report.skipped.push({ ...item, reason: 'notOnStore' })
        continue
      }
      const facts = io.inspect(id, crx)
      if (!facts.supported) {
        report.skipped.push({ ...item, reason: 'unsupported', ...(facts.reason ? { message: facts.reason } : {}) })
        continue
      }
      let approved = false
      if (widensAccess(access, facts.access)) {
        const answer = await io.prompt(id, facts)
        if (answer.unsupported) {
          report.skipped.push({ ...item, reason: 'unsupported', message: answer.unsupported })
          continue
        }
        if (!answer.ok) {
          report.skipped.push({ ...item, reason: 'declined' })
          continue
        }
        approved = true
      }
      const name = await io.install(id, crx, approved)
      report.added.push({ id, name: name || itemName })
    } catch (err) {
      report.skipped.push({ ...item, reason: 'failed', message: errorText(err) })
    }
  }
  return report
}

/** One extension from the shelf: the store's own prompt (what it can do), then the install. */
export async function installOne(io: StoreInstaller, item: { id: string; name: string }): Promise<ExtensionImportReport> {
  const report: ExtensionImportReport = { cancelled: false, added: [], skipped: [] }
  if (!EXTENSION_ID.test(item.id)) return { ...report, skipped: [{ ...item, reason: 'failed', message: mainT('extImport.error.badId') }] }
  if (io.installedIds().has(item.id)) return { ...report, skipped: [{ ...item, reason: 'installed' }] }
  try {
    const crx = await io.download(item.id)
    if (!crx) return { ...report, skipped: [{ ...item, reason: 'notOnStore' }] }
    const facts = io.inspect(item.id, crx)
    const answer = await io.prompt(item.id, facts)
    if (answer.unsupported) return { ...report, skipped: [{ ...item, reason: 'unsupported', message: answer.unsupported }] }
    if (!answer.ok) return { ...report, cancelled: true }
    const name = await io.install(item.id, crx, true)
    return { ...report, added: [{ id: item.id, name: name || facts.name || item.name }] }
  } catch (err) {
    return { ...report, skipped: [{ ...item, reason: 'failed', message: errorText(err) }] }
  }
}
