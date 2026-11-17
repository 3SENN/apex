/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The extension frame preload, registered on each profile session
// for chrome-extension:// pages and the Chrome Web Store only. Extension
// pages (popups, options, tabs) get the same chrome.* shim as their
// service worker. The Web Store, checked by exact origin in the main frame
// (a prefix match would trust look-alike hosts), gets the
// webstorePrivate and management calls its install button uses, answered
// by Atelier: every install goes through Atelier's prompt.
import { BRAND_NAME } from '@shared/branding'
import { contextBridge, ipcRenderer } from 'electron'
import { EXT_SHIM_EVENT, EXT_SHIM_INVOKE, WEB_STORE_INVOKE } from '@shared/extensionShim'
import { installStorageSync } from '@shared/extensionStorageSync'
import { installShim, type ShimBridge } from './extensionShim'

function installWebStore(): void {
  type Fn = (...args: unknown[]) => unknown
  const g = globalThis as unknown as { __atelierWebStore?: { invoke(op: string, ...args: unknown[]): Promise<unknown> }; chrome?: Record<string, unknown> }
  const bridge = g.__atelierWebStore
  if (!bridge) return
  const chrome = (g.chrome ??= {}) as Record<string, Record<string, unknown> | undefined>
  const setLastError = (message: string | null): void => {
    const value = message ? { message } : undefined
    chrome.extension = { ...(chrome.extension ?? {}), lastError: value }
    try {
      chrome.runtime = chrome.runtime ?? {}
      Object.defineProperty(chrome.runtime, 'lastError', { configurable: true, writable: true, value })
    } catch {
      // Read-only here; chrome.extension.lastError still carries it.
    }
  }
  const call =
    (op: string, arity: number): Fn =>
    (...args: unknown[]) => {
      const cb = typeof args[arity] === 'function' ? (args[arity] as Fn) : null
      const p = bridge.invoke(op, ...args.slice(0, arity))
      if (cb) p.then((v) => cb(v), () => cb())
      return p
    }
  const quietEvent = { addListener: () => {}, removeListener: () => {}, hasListener: () => false }
  // Chrome's own enum values for the store's API.
  const webstorePrivate = {
    Result: { SUCCESS: 'success', USER_CANCELLED: 'user_cancelled', UNSUPPORTED_EXTENSION_TYPE: 'unsupported_extension_type', INSTALL_ERROR: 'install_error', UNKNOWN_ERROR: 'unknown_error', ALREADY_INSTALLED: 'already_installed', INVALID_ID: 'invalid_id', MANIFEST_ERROR: 'manifest_error', ICON_ERROR: 'icon_error', FEATURE_DISABLED: 'feature_disabled', INSTALL_IN_PROGRESS: 'install_in_progress', BLOCKED_BY_POLICY: 'blocked_by_policy' },
    ExtensionInstallStatus: { INSTALLABLE: 'installable', ENABLED: 'enabled', DISABLED: 'disabled', TERMINATED: 'terminated', BLOCKED_BY_POLICY: 'blocked_by_policy', CAN_REQUEST: 'can_request', REQUEST_PENDING: 'request_pending', CORRUPTED: 'corrupted' },
    WebGlStatus: { WEBGL_ALLOWED: 'webgl_allowed', WEBGL_BLOCKED: 'webgl_blocked' },
    MV2DeprecationStatus: { INACTIVE: 'inactive', WARNING: 'warning', SOFT_DISABLE: 'soft_disable' },
    beginInstallWithManifest3: (details: unknown, cb?: Fn) => {
      const p = bridge.invoke('beginInstall', details).then((r) => {
        const { result, message } = r as { result: string; message?: string }
        setLastError(result === 'success' ? null : (message ?? result))
        cb?.(result)
        return result
      })
      return p
    },
    completeInstall: call('completeInstall', 1),
    getExtensionStatus: call('getExtensionStatus', 2),
    getFullChromeVersion: call('getFullChromeVersion', 0),
    getBrowserLogin: call('getBrowserLogin', 0),
    getStoreLogin: call('getStoreLogin', 0),
    setStoreLogin: call('setStoreLogin', 1),
    isInIncognitoMode: call('isInIncognitoMode', 0),
    getIsLauncherEnabled: call('getIsLauncherEnabled', 0),
    enableAppLauncher: call('enableAppLauncher', 1),
    getMV2DeprecationStatus: call('getMV2DeprecationStatus', 0),
    getWebGLStatus: call('getWebGLStatus', 0),
    isPendingCustodianApproval: call('isPendingCustodianApproval', 1),
    getReferrerChain: call('getReferrerChain', 0),
    install: call('install', 2),
  }
  chrome.webstorePrivate = webstorePrivate as unknown as Record<string, unknown>
  chrome.management = {
    ...(chrome.management ?? {}),
    getAll: call('management.getAll', 0),
    setEnabled: call('management.setEnabled', 2),
    uninstall: call('management.uninstall', 1),
    onInstalled: quietEvent,
    onUninstalled: quietEvent,
    onEnabled: quietEvent,
    onDisabled: quietEvent,
  }
}

const here = globalThis.location
if (here.protocol === 'chrome-extension:') {
  // One IPC listener fans out to every part of the shim that listens (tabs, webNavigation, privacy, menus…).
  const listeners = new Set<(name: string, args: unknown[]) => void>()
  ipcRenderer.on(EXT_SHIM_EVENT, (_e, name: string, ...args: unknown[]) => {
    for (const listener of [...listeners]) listener(name, args)
  })
  const bridge: ShimBridge = {
    invoke: (op, payload) => ipcRenderer.invoke(EXT_SHIM_INVOKE, op, payload),
    on: (listener) => {
      listeners.add(listener)
    },
  }
  try {
    contextBridge.exposeInMainWorld('__atelierExtensionShim', bridge)
    contextBridge.executeInMainWorld({ func: installShim })
    // chrome.storage.sync stays on this computer, shared with the extension's pages and content scripts.
    contextBridge.executeInMainWorld({ func: installStorageSync })
  } catch (err) {
    console.warn(`${BRAND_NAME} extension shim unavailable:`, err instanceof Error ? err.message : String(err))
  }
} else if (here.protocol === 'https:' && here.host === 'chromewebstore.google.com' && process.isMainFrame) {
  contextBridge.exposeInMainWorld('__atelierWebStore', { invoke: (op: string, ...args: unknown[]) => ipcRenderer.invoke(WEB_STORE_INVOKE, op, ...args) })
  contextBridge.executeInMainWorld({ func: installWebStore })
}
