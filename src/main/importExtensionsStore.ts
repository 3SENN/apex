/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import type { ExtensionImportReport, ExtensionImportRequest, ImportableExtension } from '@shared/browserImport'
import { DEFAULT_PROFILE_ID } from '@shared/profiles'
import { RECOMMENDED_EXTENSIONS } from '@shared/recommendedExtensions'
import { classifyCompat } from './extensions/compat'
import { CRX_MAX_BYTES, unpackArchive, verifyCrx } from './extensions/crx'
import { iconDataUrl, pickIcon, readManifest, type Manifest } from './extensions/manifest'
import { describePermissions } from './extensions/permissions'
import { currentExtensions } from './extensions/service'
import { crxUrl } from './extensions/webStore'
import { dialogs } from './dialogs'
import type { AppContext, WindowContext } from './features/types'
import { mainT } from './i18n/mainT'
import { browserDefs } from './importBrowsers'
import { browserExtensions, confirmList, extensionName, installBatch, installOne, type BatchItem, type PackageFacts, type StoreInstaller } from './importExtensions'
import { log } from './log'

// The Electron side of ST-46 X and ST-40 R: packages come from the Chrome
// Web Store's own download endpoint through the Apex profile's session (its
// proxy and request rules apply), are verified as the store's (the
// publisher signature and the id) before anything is unpacked, and install
// through the extensions host's installPackage, the same path the store
// page's Add uses. Smoke runs never reach the network.

/** What a manifest lets an extension do, worded as the install prompt words it. */
const accessOf = (m: Manifest): string[] => describePermissions(m).permissions.map((p) => p.label)

function profileOfWindow(ctx: AppContext, win: WindowContext | null): string {
  if (!win) return DEFAULT_PROFILE_ID
  try {
    return ctx.content.profiles.profileOf(win.chrome)
  } catch {
    return DEFAULT_PROFILE_ID
  }
}

function host() {
  const ext = currentExtensions()
  if (!ext) throw new Error(mainT('extImport.error.notReady'))
  return ext.host
}

/** Reads a verified package's manifest from a scratch copy, then removes it. */
export function inspectPackage(id: string, crx: Buffer): PackageFacts {
  const checked = verifyCrx(crx, { expectedId: id, requirePublisher: true })
  const dir = mkdtempSync(join(tmpdir(), 'apex-ext-'))
  try {
    unpackArchive(checked.archive, dir)
    const manifest = readManifest(dir)
    if (!manifest) throw new Error(mainT('extImport.error.badPackage'))
    const compat = classifyCompat(manifest)
    return {
      name: extensionName(dir, manifest, id),
      supported: compat.supported,
      reason: compat.reason,
      manifestJson: JSON.stringify(manifest),
      icon: iconDataUrl(dir, pickIcon(manifest.icons, 128)),
      access: accessOf(manifest),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function confirmBatch(win: WindowContext | null, items: readonly BatchItem[], browserName: string | null): Promise<boolean> {
  if (!win || win.window.isDestroyed()) return false
  const list = confirmList(items)
  const spec = {
    title: mainT('extImport.confirm.title', { count: items.length }),
    description: browserName ? mainT('extImport.confirm.body', { browser: browserName }) : mainT('extImport.confirm.bodyShelf'),
    callout: list,
    icon: 'info' as const,
    buttons: [
      { id: 'cancel', label: mainT('extImport.confirm.cancel'), style: 'secondary' as const, escape: true },
      { id: 'add', label: mainT('extImport.confirm.add', { count: items.length }), style: 'primary' as const, enter: true },
    ],
    dedupeKey: 'extension-import',
  }
  try {
    return await dialogs.confirm(win, spec)
  } catch {
    // No dialog surface in this window yet: the native sheet, same words.
    const { response } = await dialog.showMessageBox(win.window, { type: 'question', message: spec.title, detail: `${spec.description}\n\n${list}`, buttons: [mainT('extImport.confirm.add', { count: items.length }), mainT('extImport.confirm.cancel')], defaultId: 0, cancelId: 1 })
    return response === 0
  }
}

/** The StoreInstaller for one Apex profile and the window that asked. */
export function storeInstaller(opts: { profileId: string; win: WindowContext | null; offline: boolean; chromeVersion?: string }): StoreInstaller {
  const { profileId, win, offline } = opts
  const chromeVersion = opts.chromeVersion ?? process.versions.chrome ?? '0'
  return {
    installedIds: () => new Set(host().list(profileId).map((e) => e.id)),
    download: async (id) => {
      if (offline) throw new Error(mainT('extImport.error.offline'))
      const session = host().sessionOf(profileId)
      if (!session) throw new Error(mainT('extImport.error.notReady'))
      const res = await session.fetch(crxUrl(id, chromeVersion), { redirect: 'follow' })
      // The update server answers an id it doesn't know with 404 (or 204, nothing to give).
      if (res.status === 404 || res.status === 204) return null
      if (!res.ok) throw new Error(mainT('extensions.error.download', { status: res.status }))
      if (Number(res.headers.get('content-length') ?? '0') > CRX_MAX_BYTES) throw new Error(mainT('extensions.error.tooLarge'))
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > CRX_MAX_BYTES) throw new Error(mainT('extensions.error.tooLarge'))
      return buf.length === 0 ? null : buf
    },
    inspect: inspectPackage,
    confirmBatch: (items, browserName) => confirmBatch(win, items, browserName),
    prompt: (id, facts) => host().beginStoreInstall(profileId, id, facts.manifestJson, facts.name, facts.icon),
    install: (id, crx, approved) => host().installPackage(profileId, id, crx, { approvedOnly: approved }),
  }
}

function logReport(kind: string, report: ExtensionImportReport): void {
  if (report.cancelled) return
  log.info('extensions', `${kind}: added ${report.added.length}, skipped ${report.skipped.length}`, { skipped: report.skipped.map((s) => `${s.id}:${s.reason}`).join(',') })
}

/** The browserImport methods for extensions, given the settings runtime's context. */
export function extensionImportServices(context: () => AppContext): {
  extensions(browserId: string, profileId: string): Promise<ImportableExtension[]>
  installExtensions(request: ExtensionImportRequest): Promise<ExtensionImportReport>
  addRecommended(id: string): Promise<ExtensionImportReport>
} {
  const asking = (): { ctx: AppContext; win: WindowContext | null; profileId: string } => {
    const ctx = context()
    const win = ctx.windows.focused()
    return { ctx, win, profileId: profileOfWindow(ctx, win) }
  }
  let busy = false
  const once = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (busy) throw new Error(mainT('extImport.error.busy'))
    busy = true
    try {
      return await fn()
    } finally {
      busy = false
    }
  }
  return {
    extensions: async (browserId, profileId) => {
      const { profileId: apexProfile } = asking()
      const installed = new Set(currentExtensions()?.host.list(apexProfile).map((e) => e.id) ?? [])
      return browserExtensions(process.platform, app.getPath('home'), process.env, browserId, profileId, installed)
    },
    installExtensions: (request) =>
      once(async () => {
        const { ctx, win, profileId } = asking()
        const home = app.getPath('home')
        // Names and ids come from main's own reading of that profile, never from the page.
        const manifests = new Map<string, Manifest>()
        const found = browserExtensions(process.platform, home, process.env, request.browserId, request.profileId, new Set(), manifests)
        const wanted = new Set(request.ids)
        const picks = found.filter((e) => wanted.has(e.id))
        const notOnStore = picks.filter((e) => !e.onStore).map((e) => ({ id: e.id, name: e.name, reason: 'notOnStore' as const }))
        const browserName = browserDefs(process.platform, home, process.env).find((d) => d.id === request.browserId)?.name ?? null
        const batch: BatchItem[] = picks.filter((e) => e.onStore).map((e) => {
          const manifest = manifests.get(e.id)
          return { id: e.id, name: e.name, ...(manifest ? { access: accessOf(manifest) } : {}) }
        })
        const report = await installBatch(storeInstaller({ profileId, win, offline: ctx.smoke }), batch, browserName)
        if (!report.cancelled) report.skipped.push(...notOnStore)
        logReport('Extension import', report)
        return report
      }),
    addRecommended: (id) =>
      once(async () => {
        const rec = RECOMMENDED_EXTENSIONS.find((r) => r.id === id && r.action === 'store')
        if (!rec) throw new Error(mainT('extImport.error.notRecommended'))
        const { ctx, win, profileId } = asking()
        const report = await installOne(storeInstaller({ profileId, win, offline: ctx.smoke }), { id: rec.id, name: rec.name })
        logReport('Recommended extension', report)
        return report
      }),
  }
}
