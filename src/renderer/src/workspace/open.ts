/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where workspace things open: hub sections (on the destination surface),
// files in the file viewer, chats and web results. Failures become a toast.
import { fileViewerUrl } from '@shared/files'
import { appRunUrl, workspaceUrl } from '@shared/url'
import { fileRefName, type FileRef, type SearchHit, type WatchedFolder, type WorkspaceSection } from '@shared/workspace'
import { atelier, call, errorText } from '../api'
import { toast } from '../ui'
import { searchPageUrl, viewerTargetOf } from './logic'

export function fail(err: unknown): void {
  toast.show({ message: errorText(err), tone: 'error' })
}

/** Shows a hub section (and item) on the Workspace destination. */
export function goWorkspace(section: WorkspaceSection, id?: string): void {
  Promise.resolve(call('pages', 'open', workspaceUrl(section, id))).catch(fail)
}

/** The search section with a query filled in. */
export function goSearch(query: string): void {
  Promise.resolve(call('pages', 'open', searchPageUrl(query))).catch(fail)
}

/** Opens a file in the file viewer (apps run in their own tab). */
export function openFileRef(ref: FileRef, folders: readonly WatchedFolder[], name?: string): void {
  if (ref.kind === 'app') {
    atelier.tabs.create(appRunUrl(ref.appId)).catch(fail)
    return
  }
  const target = viewerTargetOf(ref, folders)
  if (!target) {
    fail(new Error('This file’s folder is no longer shared.'))
    return
  }
  Promise.resolve(call('pages', 'open', fileViewerUrl(target, { name: name ?? fileRefName(ref) }))).catch(fail)
}

/** Opens a search result where it lives. */
export function openHit(hit: SearchHit, folders: readonly WatchedFolder[], options: { newTab?: boolean } = {}): void {
  if ((hit.source === 'history' || hit.source === 'bookmarks') && hit.url) {
    atelier.tabs.create(hit.url).catch(fail)
    return
  }
  if (hit.source === 'chats' && hit.url) {
    Promise.resolve(call('pages', 'open', hit.url, options.newTab ? { newTab: true } : undefined)).catch(fail)
    return
  }
  if (hit.ref) openFileRef(hit.ref, folders, hit.title)
}
