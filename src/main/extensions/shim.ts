/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ipcMain, type IpcMainInvokeEvent, type ServiceWorkerMain, type WebContents } from 'electron'
import { z } from 'zod'
import { EXT_LISTEN_EVENTS, EXT_SHIM_EVENT, EXT_SHIM_INVOKE, EXT_SHIM_OPS, type ExtListenEvent, type ExtShimEvent, type ExtShimOp } from '@shared/extensionShim'
import { log } from '../log'
import type { ExtensionsHost, ShimCaller } from './host'
import { PRIVACY_SETTINGS } from './privacySettings'

// The main side of Apex's chrome.* shims: calls from an extension's
// service worker (ServiceWorkerMain.ipc, so the sender is the worker itself)
// and from its pages (ipcMain, checked against the frame's origin and the
// session). Each op's payload is validated with zod before the host sees it.

const tabId = z.number().int().min(-1).max(2 ** 31).optional()
const text = (max: number): z.ZodString => z.string().max(max)
const permissionRequest = z.object({ permissions: z.array(text(128)).max(64).optional(), origins: z.array(text(512)).max(64).optional() }).strict()
const portId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const hostName = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/).max(256)
/** Native messages are capped again at the framing layer; this guards the IPC hop. */
const nativeMessage = z.unknown()
const privacyKey = z.enum(PRIVACY_SETTINGS)
const scope = z.enum(['regular', 'regular_only', 'incognito_persistent', 'incognito_session_only']).optional()
const frameRef = z.number().int().min(0).max(2 ** 31)
const menuId = z.union([z.string().min(1).max(512), z.number().int()])
/** Menu item properties: plain data (Apex drops onclick functions in the shim). */
const menuProps = z.record(z.string().max(64), z.unknown())
const ruleIds = z.array(z.string().max(512)).max(1000).optional()

const SCHEMAS: Record<ExtShimOp, z.ZodType> = {
  'action.setBadgeText': z.object({ text: text(64).nullable().optional(), tabId }).passthrough(),
  'action.getBadgeText': z.object({ tabId }).passthrough(),
  'action.setBadgeBackgroundColor': z.object({ color: z.union([text(64), z.array(z.number()).max(4)]), tabId }).passthrough(),
  'action.getBadgeBackgroundColor': z.object({ tabId }).passthrough(),
  'action.setTitle': z.object({ title: text(512), tabId }).passthrough(),
  'action.getTitle': z.object({ tabId }).passthrough(),
  'action.setPopup': z.object({ popup: text(1024), tabId }).passthrough(),
  'action.getPopup': z.object({ tabId }).passthrough(),
  'action.enable': z.object({ tabId }).passthrough(),
  'action.disable': z.object({ tabId }).passthrough(),
  'action.isEnabled': z.object({ tabId }).passthrough(),
  'action.setIcon': z.object({ path: z.union([text(1024), z.record(text(8), text(1024))]).optional(), tabId }).passthrough(),
  'action.openPopup': z.object({}).passthrough(),
  'commands.getAll': z.object({}).passthrough(),
  'contextMenus.create': z.object({ props: menuProps }).strict(),
  'contextMenus.update': z.object({ id: menuId, props: menuProps }).strict(),
  'contextMenus.remove': z.object({ id: menuId }).strict(),
  'contextMenus.removeAll': z.object({}).strict(),
  'declarativeContent.addRules': z.object({ rules: z.array(z.record(z.string().max(64), z.unknown())).max(1000) }).strict(),
  'declarativeContent.removeRules': z.object({ ids: ruleIds }).strict(),
  'declarativeContent.getRules': z.object({ ids: ruleIds }).strict(),
  'native.connect': z.object({ portId, host: hostName }).strict(),
  'native.post': z.object({ portId, message: nativeMessage }).strict(),
  'native.disconnect': z.object({ portId }).strict(),
  'native.send': z.object({ host: hostName, message: nativeMessage }).strict(),
  'permissions.getAll': z.object({}).passthrough(),
  'permissions.contains': permissionRequest,
  'permissions.request': permissionRequest,
  'permissions.remove': permissionRequest,
  'privacy.get': z.object({ key: privacyKey, details: z.object({ incognito: z.boolean().optional() }).passthrough() }).strict(),
  'privacy.set': z.object({ key: privacyKey, details: z.object({ value: z.unknown(), scope }).passthrough() }).strict(),
  'privacy.clear': z.object({ key: privacyKey, details: z.object({ scope }).passthrough() }).strict(),
  'tabs.create': z.object({ url: text(8192).optional(), active: z.boolean().optional() }).passthrough(),
  'tabs.listen': z.object({ event: z.enum(EXT_LISTEN_EVENTS) }).strict(),
  'tabs.query': z
    .object({
      active: z.boolean().optional(),
      currentWindow: z.boolean().optional(),
      lastFocusedWindow: z.boolean().optional(),
      windowId: z.number().int().optional(),
      pinned: z.boolean().optional(),
      audible: z.boolean().optional(),
      url: z.union([text(2048), z.array(text(2048)).max(32)]).optional(),
      title: text(1024).optional(),
      status: z.enum(['loading', 'complete', 'unloaded']).optional(),
    })
    .passthrough(),
  'webNavigation.getFrame': z.object({ tabId: frameRef, frameId: frameRef, processId: z.number().int().optional(), documentId: z.string().max(64).optional() }).passthrough(),
  'webNavigation.getAllFrames': z.object({ tabId: frameRef }).passthrough(),
  'windows.getAll': z.object({}).passthrough(),
  'runtime.openOptionsPage': z.object({}).passthrough(),
  'window.close': z.object({}).passthrough(),
}

const OPS = new Set<string>(EXT_SHIM_OPS)

/** Runs one validated op for one extension. */
export async function runShimOp(host: ExtensionsHost, profileId: string, caller: ShimCaller, op: string, raw: unknown): Promise<unknown> {
  if (!OPS.has(op)) throw new Error(`Unknown call ${op}.`)
  const payload = SCHEMAS[op as ExtShimOp].parse(raw ?? {}) as Record<string, unknown>
  const id = caller.extensionId
  if (!host.isLoaded(profileId, id)) throw new Error('This extension isn’t running.')
  if (op.startsWith('action.') && op !== 'action.openPopup') {
    const details = { ...payload, text: payload.text === null ? '' : payload.text } as Parameters<ExtensionsHost['action']>[3]
    return host.action(profileId, id, op, details)
  }
  switch (op as ExtShimOp) {
    case 'action.openPopup':
      return host.openPopupFromExtension(profileId, id)
    case 'commands.getAll':
      return host.commandsOf(profileId, id)
    case 'contextMenus.create':
      return host.menuCreate(profileId, id, payload.props)
    case 'contextMenus.update':
      return host.menuUpdate(profileId, id, payload.id, payload.props)
    case 'contextMenus.remove':
      return host.menuRemove(profileId, id, payload.id)
    case 'contextMenus.removeAll':
      return host.menuRemoveAll(profileId, id)
    case 'declarativeContent.addRules':
      return host.contentRulesAdd(profileId, id, payload.rules as unknown[])
    case 'declarativeContent.removeRules':
      return host.contentRulesRemove(profileId, id, payload.ids as string[] | undefined)
    case 'declarativeContent.getRules':
      return host.contentRulesGet(profileId, id, payload.ids as string[] | undefined)
    case 'native.connect':
      return host.nativeConnect(profileId, caller, payload.host as string, payload.portId as string)
    case 'native.post':
      return host.nativePost(profileId, id, payload.portId as string, payload.message)
    case 'native.disconnect':
      return host.nativeDisconnect(profileId, id, payload.portId as string)
    case 'native.send':
      return host.nativeSend(profileId, id, payload.host as string, payload.message)
    case 'permissions.getAll':
      return host.grantedSet(profileId, id)
    case 'permissions.contains':
      return host.hasPermissions(profileId, id, payload)
    case 'permissions.request':
      return host.requestPermissions(profileId, id, payload)
    case 'permissions.remove':
      return host.removePermissions(profileId, id, payload)
    case 'privacy.get':
      return host.privacyGet(profileId, id, payload.key as string)
    case 'privacy.set':
      return host.privacySet(profileId, id, payload.key as string, payload.details as { value?: unknown; scope?: unknown })
    case 'privacy.clear':
      return host.privacyClear(profileId, id, payload.key as string, payload.details as { scope?: unknown })
    case 'tabs.create':
      return host.createTab(profileId, id, payload.url as string | undefined, payload.active !== false)
    case 'tabs.query':
      return host.queryTabs(profileId, payload)
    case 'tabs.listen':
      return host.listenTabs(profileId, caller, payload.event as ExtListenEvent)
    case 'webNavigation.getFrame':
      return host.navGetFrame(profileId, id, payload as { tabId: number; frameId: number })
    case 'webNavigation.getAllFrames':
      return host.navGetAllFrames(profileId, id, payload as { tabId: number })
    case 'windows.getAll':
      return host.windowsOf(profileId)
    case 'runtime.openOptionsPage':
      return host.openOptionsPage(profileId, id)
    case 'window.close':
      return caller.webContents ? host.closeIfPopup(caller.webContents) : false
    default:
      throw new Error(`Unknown call ${op}.`)
  }
}

/** Errors cross IPC as plain messages; the shim turns them into chrome.runtime.lastError or a rejection. */
async function settle(fn: () => Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    const error = err instanceof z.ZodError ? 'Invalid arguments.' : err instanceof Error ? err.message : String(err)
    return { ok: false, error }
  }
}

/** Wires a new extension service worker's calls. */
export function wireWorker(host: ExtensionsHost, profileId: string, extensionId: string, worker: ServiceWorkerMain): void {
  const caller: ShimCaller = {
    extensionId,
    webContents: null,
    send: (name: ExtShimEvent, ...args: unknown[]) => {
      if (!worker.isDestroyed()) worker.send(EXT_SHIM_EVENT, name, ...args)
    },
    keepAlive: () => {
      const task = worker.isDestroyed() ? null : worker.startTask()
      return () => task?.end()
    },
  }
  worker.ipc.removeHandler(EXT_SHIM_INVOKE)
  worker.ipc.handle(EXT_SHIM_INVOKE, (_e, op: unknown, payload: unknown) => settle(() => runShimOp(host, profileId, caller, String(op), payload)))
}

/** The extension a page belongs to, from its frame's own origin (never from anything the page says). */
function extensionOfFrame(event: IpcMainInvokeEvent): string | null {
  const url = event.senderFrame?.url ?? ''
  return /^chrome-extension:\/\/([a-p]{32})\//.exec(url)?.[1] ?? null
}

/** Wires calls from extension pages (popups, options pages, tabs). Returns an unregister. */
export function wireFrames(host: ExtensionsHost): () => void {
  ipcMain.handle(EXT_SHIM_INVOKE, (event, op: unknown, payload: unknown) => {
    const extensionId = extensionOfFrame(event)
    const profileId = host.profileOfSession(event.sender.session)
    if (!extensionId || !profileId) {
      log.warn('extensions', 'Rejected an extension call from an untrusted sender')
      return { ok: false, error: 'Rejected.' }
    }
    const sender: WebContents = event.sender
    // An extension iframe inside a tab (a fill list on a sign-in page) hears its own events, not the tab's page.
    const frame = event.senderFrame
    const subframe = frame && frame !== sender.mainFrame ? frame : null
    const frameAlive = (): boolean => {
      try {
        return !!subframe && !subframe.isDestroyed() && !subframe.detached
      } catch {
        return false
      }
    }
    const caller: ShimCaller = {
      extensionId,
      webContents: sender,
      send: (name: ExtShimEvent, ...args: unknown[]) => {
        if (sender.isDestroyed()) return
        if (!subframe) return sender.send(EXT_SHIM_EVENT, name, ...args)
        if (frameAlive()) subframe.send(EXT_SHIM_EVENT, name, ...args)
      },
      keepAlive: () => () => {},
      ...(subframe ? { frameKey: subframe, alive: () => !sender.isDestroyed() && frameAlive() } : {}),
    }
    return settle(() => runShimOp(host, profileId, caller, String(op), payload))
  })
  return () => ipcMain.removeHandler(EXT_SHIM_INVOKE)
}
