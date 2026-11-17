/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { contextBridge, ipcRenderer } from 'electron'
import { PAGE, type PageConfig } from '@shared/ipc'

// The page-side privacy: navigator.globalPrivacyControl in
// the page's own world, from PAGE.config. It is read synchronously before any
// page script runs, so a site's first check already sees the answer; the
// Sec-GPC header itself is added in main for every request.
export function installPrivacy(): void {
  let config: PageConfig | null = null
  try {
    config = ipcRenderer.sendSync(PAGE.config) as PageConfig | null
  } catch {
    // Main didn't answer (a page outside a tab); the page keeps the browser's default.
  }
  if (!config?.gpc) return
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true, enumerable: true })
      },
    })
  } catch {
    // A world that can't be reached keeps the default; the header still goes out.
  }
}
