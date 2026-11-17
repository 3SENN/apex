/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The extension service-worker preload, registered with
// session.registerPreloadScript({ type: 'service-worker' }) on each profile
// session. It fills the chrome.* gaps Electron leaves (action, commands,
// native messaging, permissions, tabs, windows) and aliases `browser` to
// `chrome`. Calls reach main through this worker's own IPC
// (ServiceWorkerMain.ipc), so main knows exactly which extension asked.
import { BRAND_NAME } from '@shared/branding'
import { contextBridge, ipcRenderer } from 'electron'
import { EXT_SHIM_EVENT, EXT_SHIM_INVOKE } from '@shared/extensionShim'
import { installStorageSync } from '@shared/extensionStorageSync'
import { installShim, type ShimBridge } from './extensionShim'

/**
 * The worker's own address. A service-worker preload's world has no
 * `location` of its own (Electron 45), so ask the worker's main world.
 */
function workerUrl(): string {
  try {
    return String(contextBridge.executeInMainWorld({ func: () => String((globalThis as { location?: { href?: string } }).location?.href ?? '') }) ?? '')
  } catch {
    return ''
  }
}

// Only extension workers: a website's service worker in the same session gets nothing.
if (workerUrl().startsWith('chrome-extension://')) {
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
    contextBridge.exposeInMainWorld('__apexExtensionShim', bridge)
    contextBridge.executeInMainWorld({ func: installShim })
    // chrome.storage.sync stays on this computer, shared with the extension's pages and content scripts.
    contextBridge.executeInMainWorld({ func: installStorageSync })
  } catch (err) {
    // Without the shim the extension still runs on Electron's own APIs; its calls to the gaps fail with Electron's errors.
    console.warn(`${BRAND_NAME} extension shim unavailable:`, err instanceof Error ? err.message : String(err))
  }
}
