/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mainT } from '../i18n/mainT'
import { permissionLists, type Manifest } from './manifest'

// The compatibility classifier (OV-16): an extension that needs an
// API the runtime lacks gets an acknowledge-only notice instead of
// half-working. The set of available APIs comes from the adapter, so
// swapping in electron-chrome-extensions later only widens that set.

export interface Compat {
  supported: boolean
  reason: string | null
  /** The permissions that made it unsupported (for logs and the notice). */
  missing: string[]
}

/** Permissions that ask for no API at all, or that the web platform already covers. */
const ALWAYS_FINE = new Set(['activeTab', 'background', 'unlimitedStorage', 'clipboardRead', 'clipboardWrite', 'geolocation', 'webRequestBlocking', 'declarativeNetRequestWithHostAccess', 'declarativeNetRequestFeedback'])

/**
 * What Electron 45's own session.extensions provides, plus Atelier's shims
 * (action, commands, context menus, native messaging, permissions, privacy,
 * declarativeContent, webNavigation, windows, storage.sync and tabs.create
 * through the service-worker and frame preloads).
 */
export const NATIVE_APIS: ReadonlySet<string> = new Set([
  'alarms',
  'i18n',
  'runtime',
  'storage',
  'scripting',
  'tabs',
  'management',
  'offscreen',
  'declarativeNetRequest',
  'webRequest',
  // Atelier shims.
  'action',
  'commands',
  'nativeMessaging',
  'permissions',
  // Items show in the page's context menu; clicks reach contextMenus.onClicked.
  'contextMenus',
  // Password saving can be held by an extension; address and card autofill stay Atelier's (not controllable).
  'privacy',
  // Page rules: URL conditions are evaluated, ShowAction turns the action on.
  'declarativeContent',
  // Frames and navigation events from Electron's frame events, with Chromium's own frame ids.
  'webNavigation',
  'windows',
])

/** Manifest keys that need browser UI Atelier doesn't draw. */
const UNSUPPORTED_KEYS: Array<[keyof Manifest, string]> = [
  ['side_panel', 'sidePanel'],
  ['devtools_page', 'devtools'],
  ['chrome_url_overrides', 'chrome_url_overrides'],
]

export function classifyCompat(m: Manifest, available: ReadonlySet<string> = NATIVE_APIS): Compat {
  if (m.theme) return { supported: false, reason: mainT('extensions.unsupported.theme'), missing: [] }
  if (m.app) return { supported: false, reason: mainT('extensions.unsupported.app'), missing: [] }
  if (m.manifest_version !== 3) return { supported: false, reason: mainT('extensions.unsupported.mv2'), missing: [] }
  const missing: string[] = []
  for (const [key, api] of UNSUPPORTED_KEYS) if (m[key] !== undefined && !available.has(api)) missing.push(api)
  // Only required permissions count: optional ones are asked for later, and refusing them is allowed.
  for (const api of permissionLists(m).apis) {
    if (ALWAYS_FINE.has(api) || available.has(api) || available.has(api.split('.')[0] ?? api)) continue
    missing.push(api)
  }
  if (missing.length === 0) return { supported: true, reason: null, missing }
  const unique = [...new Set(missing)]
  return { supported: false, reason: mainT('extensions.unsupported.apis', { apis: unique.join(', '), count: unique.length }), missing: unique }
}
