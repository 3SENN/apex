/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { contextBridge, ipcRenderer } from 'electron'
import { PAGE, type PageDialogMessage, type PageDialogReply } from '@shared/ipc'
import { PAGE_LEAVE_INTENT, type PageLeaveIntentMessage } from '@shared/pageDialogs'

// Styled alert, confirm and prompt (OV-08): overrides installed
// with contextBridge.executeInMainWorld, answered over PAGE.dialog with
// sendSync, so the page blocks exactly as it would on a native dialog while
// main shows Apex's own. The overrides are non-configurable, so a page can't
// delete them to reach a native box (tabs also run with disableDialogs, so
// anything that slips past fails closed). Also reports the page's own
// cross-document navigations for "Leave this page?".

const MAX_TEXT = 10_000

/** Runs in the isolated world: the page never sees ipcRenderer, only this function's proxy. */
function ask(kind: PageDialogMessage['kind'], message: unknown, defaultValue: unknown): PageDialogReply {
  const msg: PageDialogMessage = { kind, message: String(message ?? '').slice(0, MAX_TEXT) }
  if (kind === 'prompt') msg.defaultValue = String(defaultValue ?? '').slice(0, MAX_TEXT)
  try {
    return ipcRenderer.sendSync(PAGE.dialog, msg) as PageDialogReply
  } catch {
    // No answer is a cancel: the page carries on rather than hanging.
    return null
  }
}

/** Runs in the page's main world. It must be self-contained: only its arguments cross over. */
function override(asker: typeof ask): void {
  const define = (name: string, fn: (...args: unknown[]) => unknown): void => {
    try {
      Object.defineProperty(window, name, { value: fn, writable: false, configurable: false, enumerable: true })
    } catch {
      // Already defined by an earlier run of this preload.
    }
  }
  // Spec arity and coercion: alert() and confirm() with no argument ask with an empty message.
  define('alert', function alert(message?: unknown) {
    asker('alert', arguments.length ? message : '', undefined)
  })
  define('confirm', function confirm(message?: unknown) {
    return asker('confirm', arguments.length ? message : '', undefined) === true
  })
  define('prompt', function prompt(message?: unknown, defaultValue?: unknown) {
    const reply = asker('prompt', arguments.length ? message : '', defaultValue === undefined ? '' : defaultValue)
    return typeof reply === 'string' ? reply : null
  })
}

/** The Navigation API's navigate event arrives before beforeunload, with the target and whether it posts a form. */
function reportLeaveIntents(): void {
  const nav = (window as unknown as { navigation?: EventTarget }).navigation
  if (!nav) return
  nav.addEventListener('navigate', (event) => {
    const e = event as Event & { destination?: { url?: string; sameDocument?: boolean }; hashChange?: boolean; downloadRequest?: string | null; formData?: FormData | null }
    if (e.hashChange || e.destination?.sameDocument || e.downloadRequest) return
    const url = e.destination?.url
    if (!url || !/^https?:/i.test(url)) return
    const msg: PageLeaveIntentMessage = { url: url.slice(0, 8192), form: e.formData != null }
    try {
      ipcRenderer.sendSync(PAGE_LEAVE_INTENT, msg)
    } catch {
      // Without the intent, Leave just lets you try again.
    }
  })
}

/** `mainWorld: false` (sign-in pages) leaves the page's own alert, confirm and prompt alone. */
export function installDialogs({ mainWorld = true }: { mainWorld?: boolean } = {}): void {
  try {
    if (mainWorld) contextBridge.executeInMainWorld({ func: override, args: [ask] })
  } catch {
    // A world that can't be reached keeps disableDialogs' fail-closed behaviour.
  }
  try {
    reportLeaveIntents()
  } catch {
    // Older engines without the Navigation API: Leave falls back to "try again".
  }
}
