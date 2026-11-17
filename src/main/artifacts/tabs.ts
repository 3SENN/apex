/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import type { Session } from 'electron'
import { ARTIFACT_SCHEME, artifactIdOf, artifactUrl } from '@shared/files'
import type { WindowContext } from '../features/types'
import type { LibraryStore } from '../files/library'
import { log } from '../log'
import type { Tab } from '../tabs'
import { artifactDocument, artifactHeaders, artifactNavigationAllowed } from './policy'

// Artifact tabs: a Library file shown as a real tab, rendered in the
// in-memory apex-artifacts partition with no preload. The partition is locked
// down (webRequest.lockdown and a deny-all permission override, see
// features/sandboxSessions.ts); here each tab also refuses navigation, popups and
// downloads, and the scheme serves only the artifact's own document.

/** Serves apex-artifact://<fileId>/ from the Library on the artifacts session. */
export function handleArtifactProtocol(session: Session, library: LibraryStore): () => void {
  session.protocol.handle(ARTIFACT_SCHEME, (request) => {
    const id = artifactIdOf(request.url)
    const file = id ? library.get(id) : null
    if (!id || !file || file.state !== 'ready') return new Response('Not found', { status: 404 })
    try {
      const doc = artifactDocument(file, readFileSync(library.pathOf(id), 'utf8'))
      if (!doc) return new Response('Not found', { status: 404 })
      return new Response(doc.body, { headers: artifactHeaders(doc.contentType) })
    } catch (err) {
      log.warn('files', 'artifact could not be served', { error: err instanceof Error ? err.message : String(err) })
      return new Response('Not found', { status: 404 })
    }
  })
  // Nothing an artifact makes is ever saved to disk.
  const noDownloads = (event: Electron.Event): void => event.preventDefault()
  session.on('will-download', noDownloads)
  return () => {
    session.protocol.unhandle(ARTIFACT_SCHEME)
    session.off('will-download', noDownloads)
  }
}

/** Locks one artifact tab to its own document: no navigation elsewhere, no new windows. */
export function confineArtifactTab(tab: Tab): void {
  const wc = tab.view.webContents
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  const guard = (event: Electron.Event, url: string): void => {
    if (!artifactNavigationAllowed(wc.getURL() || url, url)) event.preventDefault()
  }
  wc.on('will-navigate', (event) => guard(event, event.url))
  wc.on('will-redirect', (event) => guard(event, event.url))
  wc.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) event.preventDefault()
  })
}

/** Opens (or focuses) the artifact tab for a Library file in this window, right after the active tab. */
export function openArtifactTab(win: WindowContext, fileId: string, session: Session): Tab {
  const url = artifactUrl(fileId)
  const existing = win.tabs.all().find((t) => artifactIdOf(t.view.webContents.getURL() || t.requestedUrl) === fileId.toLowerCase())
  if (existing) {
    win.tabs.activate(existing.id)
    return existing
  }
  const tab = win.tabs.create(url, { activate: true, afterId: win.tabs.activeId() ?? undefined, sandbox: { session } })
  confineArtifactTab(tab)
  return tab
}
