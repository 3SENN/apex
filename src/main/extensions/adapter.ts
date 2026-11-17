/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Session } from 'electron'
import { NATIVE_APIS } from './compat'

// The seam between Apex's extensions layer and the runtime that loads them
// (a day-one decision). Today it is Electron 45's own
// session.extensions plus Apex's preload shims; electron-chrome-extensions
// (MIT from 4.10.0, pinnable from 2026-11-08) can replace it by
// implementing this interface and widening `apis`. Nothing else in
// src/main/extensions touches session.extensions directly.

export interface LoadedExtension {
  id: string
  name: string
  version: string
  path: string
  url: string
  manifest: unknown
}

export interface ExtensionsAdapter {
  readonly name: string
  /** chrome.* namespaces this runtime provides (the compatibility classifier reads it). */
  readonly apis: ReadonlySet<string>
  load(session: Session, dir: string): Promise<LoadedExtension>
  unload(session: Session, id: string): void
  get(session: Session, id: string): LoadedExtension | null
  all(session: Session): LoadedExtension[]
  /** Fires when Chromium unloads one on its own (a crash it gives up on, or chrome.management). */
  onUnloaded(session: Session, cb: (id: string) => void): () => void
  /** Registers the service-worker and frame preloads that fill the API gaps. */
  installPreloads(session: Session, paths: { worker: string; frame: string }): void
}

const view = (e: Electron.Extension): LoadedExtension => ({ id: e.id, name: e.name, version: e.version, path: e.path, url: e.url, manifest: e.manifest })

export const nativeAdapter: ExtensionsAdapter = {
  name: 'electron',
  apis: NATIVE_APIS,
  async load(session, dir) {
    // allowFileAccess stays off: file:// pages need the person's say-so.
    return view(await session.extensions.loadExtension(dir, { allowFileAccess: false }))
  },
  unload(session, id) {
    if (session.extensions.getExtension(id)) session.extensions.removeExtension(id)
  },
  get(session, id) {
    const e = session.extensions.getExtension(id)
    return e ? view(e) : null
  },
  all(session) {
    return session.extensions.getAllExtensions().map(view)
  },
  onUnloaded(session, cb) {
    const listener = (_e: unknown, ext: Electron.Extension): void => cb(ext.id)
    session.extensions.on('extension-unloaded', listener)
    return () => {
      session.extensions.off('extension-unloaded', listener)
    }
  },
  installPreloads(session, paths) {
    const existing = new Set(session.getPreloadScripts().map((p) => p.id))
    if (!existing.has('apex-extension-worker')) session.registerPreloadScript({ id: 'apex-extension-worker', type: 'service-worker', filePath: paths.worker })
    // Only extension pages and the Web Store run the frame preload; every other page never sees it.
    if (!existing.has('apex-extension-frame')) {
      // Globs match the whole URL for any scheme; the preload re-checks the exact origin itself.
      session.registerPreloadScript({ id: 'apex-extension-frame', type: 'frame', filePath: paths.frame, includeGlobs: ['chrome-extension://*', 'https://chromewebstore.google.com/*'] })
    }
  },
}
