/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcMain, type IpcMainInvokeEvent, type Session } from 'electron'
import { z } from 'zod'
import { EXTENSION_ID, isWebStoreUrl } from '@shared/extensions'
import { WEB_STORE_INVOKE, WEB_STORE_OPS, type WebStoreOp } from '@shared/extensionShim'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { CRX_MAX_BYTES } from './crx'
import { compareVersions, type ExtensionsHost } from './host'

// The Chrome Web Store bridge: the store page's webstorePrivate and
// management calls, answered by Apex. Only the store's exact origin, in a
// main frame, of a session Apex attached, is heard (a prefix match would trust
// look-alike hosts). Packages download through the profile's own session,
// are verified before unpacking, and uninstalling asks first (the store's
// remove button goes through Apex's confirmation).

export interface WebStoreDeps {
  host: ExtensionsHost
  toast(profileId: string, kind: 'success' | 'error' | 'info', text: string): void
  /** Asks before the store page removes an extension; false when the person says no. */
  confirmRemove(profileId: string, name: string): Promise<boolean>
}

const ICON_MAX_BYTES = 1024 * 1024
const id = z.string().regex(EXTENSION_ID)
const beginDetails = z
  .object({
    id,
    manifest: z.string().max(256 * 1024),
    iconUrl: z.string().max(4096).optional(),
    localizedName: z.string().max(512).optional(),
  })
  .passthrough()

/** The package download for one id, Chrome's own update endpoint. */
export function crxUrl(extensionId: string, chromeVersion: string): string {
  const url = new URL('https://clients2.google.com/service/update2/crx')
  url.searchParams.set('response', 'redirect')
  url.searchParams.set('acceptformat', 'crx3')
  url.searchParams.set('prodversion', chromeVersion)
  url.searchParams.set('x', `id=${extensionId}&installsource=ondemand&uc`)
  return url.href
}

/** The update check for installed store extensions (one request for all of them). */
export function updateCheckUrl(installs: { id: string; version: string }[], chromeVersion: string): string {
  const url = new URL('https://clients2.google.com/service/update2/crx')
  url.searchParams.set('response', 'updatecheck')
  url.searchParams.set('acceptformat', 'crx3')
  url.searchParams.set('prodversion', chromeVersion)
  for (const i of installs) url.searchParams.append('x', `id=${i.id}&v=${i.version}&uc`)
  return url.href
}

/** Reads the update check's XML: the ids with a newer version and where to get it. */
export function parseUpdateCheck(xml: string, installed: { id: string; version: string }[]): { id: string; version: string; codebase: string }[] {
  const out: { id: string; version: string; codebase: string }[] = []
  for (const app of xml.matchAll(/<app\b[^>]*\bappid="([a-p]{32})"[^>]*>([\s\S]*?)<\/app>/g)) {
    const [, appId, body] = app
    const check = /<updatecheck\b([^>]*)\/?>/.exec(body ?? '')?.[1] ?? ''
    const attr = (name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(check)?.[1] ?? null
    const version = attr('version')
    const codebase = attr('codebase')?.replace(/&amp;/g, '&') ?? null
    const current = installed.find((i) => i.id === appId)
    if (!appId || !version || !codebase || !current || attr('status') !== 'ok') continue
    if (!/^https:\/\//.test(codebase) || compareVersions(version, current.version) <= 0) continue
    out.push({ id: appId, version, codebase })
  }
  return out
}

/** Downloads through the profile's session, so its proxy and request rules apply. */
async function download(session: Session, url: string, max: number): Promise<Buffer> {
  const res = await session.fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(mainT('extensions.error.download', { status: res.status }))
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > max) throw new Error(mainT('extensions.error.tooLarge'))
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > max) throw new Error(mainT('extensions.error.tooLarge'))
  return buf
}

async function iconFrom(session: Session, url: string | undefined): Promise<string | null> {
  if (!url || !/^https:\/\//.test(url)) return null
  try {
    const res = await session.fetch(url)
    const type = res.headers.get('content-type') ?? 'image/png'
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)/.test(type)) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return buf.length > ICON_MAX_BYTES ? null : `data:${type.split(';')[0]};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/** One id's package from the Web Store, downloaded through the profile's session (verify it before use). */
export async function downloadCrx(session: Session, extensionId: string, chromeVersion: string): Promise<Buffer> {
  return download(session, crxUrl(extensionId, chromeVersion), CRX_MAX_BYTES)
}

/** Installs one id end to end after its prompt: download, verify, unpack, load, toast. */
export async function completeInstall(deps: WebStoreDeps, profileId: string, extensionId: string, chromeVersion: string): Promise<'success' | 'install_error'> {
  const session = deps.host.sessionOf(profileId)
  if (!session) return 'install_error'
  try {
    const crx = await download(session, crxUrl(extensionId, chromeVersion), CRX_MAX_BYTES)
    const name = await deps.host.installPackage(profileId, extensionId, crx, { approvedOnly: true })
    deps.toast(profileId, 'success', mainT('extensions.toast.added', { name }))
    return 'success'
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn('extensions', 'A Web Store install failed', { id: extensionId, error: message })
    deps.toast(profileId, 'error', mainT('extensions.toast.installFailed', { reason: message }))
    return 'install_error'
  }
}

/** Updates every store install of a profile that has a newer version. Quiet unless something updated. */
export async function checkForUpdates(deps: WebStoreDeps, profileId: string, chromeVersion: string): Promise<number> {
  const session = deps.host.sessionOf(profileId)
  const installs = deps.host.storeInstalls(profileId)
  if (!session || installs.length === 0) return 0
  let updated = 0
  try {
    const res = await session.fetch(updateCheckUrl(installs, chromeVersion))
    if (!res.ok) return 0
    for (const next of parseUpdateCheck(await res.text(), installs)) {
      try {
        const crx = await download(session, next.codebase, CRX_MAX_BYTES)
        await deps.host.installPackage(profileId, next.id, crx, { approvedOnly: false })
        updated++
      } catch (err) {
        log.warn('extensions', 'An extension update failed', { id: next.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
  } catch (err) {
    log.debug('extensions', 'The extension update check failed', { error: err instanceof Error ? err.message : String(err) })
  }
  return updated
}

/** The store page's caller, or null when it isn't the store's main frame in an attached session. */
function storeCaller(deps: WebStoreDeps, event: IpcMainInvokeEvent): string | null {
  const frame = event.senderFrame
  if (!frame || frame !== event.sender.mainFrame || !isWebStoreUrl(frame.url)) return null
  return deps.host.profileOfSession(event.sender.session)
}

const OPS = new Set<string>(WEB_STORE_OPS)

export async function runStoreOp(deps: WebStoreDeps, profileId: string, op: WebStoreOp, args: unknown[], chromeVersion: string): Promise<unknown> {
  const { host } = deps
  switch (op) {
    case 'beginInstall': {
      const details = beginDetails.parse(args[0])
      const session = host.sessionOf(profileId)
      const icon = session ? await iconFrom(session, details.iconUrl) : null
      const result = await host.beginStoreInstall(profileId, details.id, details.manifest, details.localizedName ?? '', icon)
      if (result.unsupported) return { result: 'unsupported_extension_type', message: result.unsupported }
      return result.ok ? { result: 'success' } : { result: 'user_cancelled', message: 'User cancelled install' }
    }
    case 'completeInstall':
      return completeInstall(deps, profileId, id.parse(args[0]), chromeVersion)
    case 'getExtensionStatus':
      return host.installedStatus(profileId, id.parse(args[0]))
    case 'getFullChromeVersion':
      return { version_number: chromeVersion }
    case 'getBrowserLogin':
      return { login: '' }
    case 'getStoreLogin':
      return ''
    case 'setStoreLogin':
    case 'enableAppLauncher':
      return true
    case 'isInIncognitoMode':
    case 'getIsLauncherEnabled':
    case 'isPendingCustodianApproval':
      return false
    case 'getMV2DeprecationStatus':
      return 'inactive'
    case 'getWebGLStatus':
      return 'webgl_allowed'
    case 'getReferrerChain':
      return []
    case 'install':
      // The legacy one-step install skips the prompt; Apex never installs unasked.
      return 'unknown_error'
    case 'management.getAll':
      return host.list(profileId).map((e) => ({ id: e.id, name: e.name, shortName: e.name, description: e.description, version: e.version, enabled: e.enabled, mayDisable: true, type: 'extension', installType: e.source === 'store' ? 'normal' : 'development', isApp: false, offlineEnabled: false, icons: [], permissions: [], hostPermissions: e.hosts }))
    case 'management.setEnabled': {
      await host.setEnabled(profileId, id.parse(args[0]), z.boolean().parse(args[1]))
      return true
    }
    case 'management.uninstall': {
      const extensionId = id.parse(args[0])
      const item = host.list(profileId).find((e) => e.id === extensionId)
      if (!item) return false
      if (!(await deps.confirmRemove(profileId, item.name))) return false
      await host.remove(profileId, extensionId)
      return true
    }
  }
}

/** Registers the store bridge's IPC. Returns an unregister. */
export function wireWebStore(deps: WebStoreDeps, chromeVersion: string): () => void {
  ipcMain.handle(WEB_STORE_INVOKE, async (event, op: unknown, ...args: unknown[]) => {
    const profileId = storeCaller(deps, event)
    if (!profileId || typeof op !== 'string' || !OPS.has(op)) {
      log.warn('extensions', 'Rejected a Web Store call from an untrusted sender')
      throw new Error('Rejected.')
    }
    return runStoreOp(deps, profileId, op as WebStoreOp, args.slice(0, 4), chromeVersion)
  })
  return () => ipcMain.removeHandler(WEB_STORE_INVOKE)
}
