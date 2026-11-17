/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { copyFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { FilesEvent, FilesServices, LibraryFileRef, ViewerTarget } from '@shared/files'
import type { MeetingResolver } from '@shared/meetings'
import type { AttachmentStore, ChatFilesReader } from '../intake/types'
import { LibraryStore } from './library'
import type { LibraryFiles, ViewerHooks } from './types'
import { Viewer } from './viewer'
import { mainT } from '../i18n/mainT'

// The Library Files store, viewer and the main-side APIs. Electron's
// shell and dialogs come in through deps, so the whole service runs in unit
// tests; the feature module (features/files.ts) supplies the real ones and
// the window-scoped artifact tabs.

export interface FilesDeps {
  dataDir: string
  broadcast(event: FilesEvent): void
  attachments?: () => AttachmentStore
  chatFiles?: () => ChatFilesReader
  meetings?: () => MeetingResolver
  /** Moves a file to the Trash; without it, files are deleted. */
  trash?: (path: string) => Promise<void>
  reveal?: (path: string) => void
  saveDialog?: (defaultName: string) => Promise<string | null>
  openDialog?: () => Promise<string | null>
  /** Opens a Library file as an artifact tab; the window feature replaces it per window. */
  openArtifact?: (fileId: string) => void
  now?: () => number
}

export interface Files {
  services: FilesServices
  library: LibraryFiles
  viewer: ViewerHooks
  /** The store and viewer themselves, for the protocols and the feature module. */
  store: LibraryStore
  documents: Viewer
  dispose(): void
}

/** "Q3 plan" + markdown → "Q3 plan.md". */
const EXTENSIONS = { markdown: 'md', html: 'html', svg: 'svg', csv: 'csv', json: 'json', text: 'txt' } as const
const MEDIA = { markdown: 'text/markdown', html: 'text/html', svg: 'image/svg+xml', csv: 'text/csv', json: 'application/json', text: 'text/plain' } as const

export function artifactFileName(title: string, format: keyof typeof EXTENSIONS): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Artifact'
  return `${base}.${EXTENSIONS[format]}`
}

/** Throws a plain sentence unless the Library file can open as an artifact tab now. */
export function assertArtifactOpenable(store: LibraryStore, id: string): void {
  const file = store.get(id)
  if (!file) throw new Error(mainT('files.error.gone'))
  if (!/^(text\/html|image\/svg\+xml|text\/markdown)$/.test(file.mediaType)) throw new Error(mainT('files.error.notArtifact'))
  if (file.state !== 'ready') throw new Error(mainT('files.error.writing'))
}

/** Whether `path` is `root` or inside it (both already real paths). */
function within(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * A file dropped onto the window: granted for this
 * session like a picked one, so it opens in the viewer. The path comes from
 * the renderer, so it must be absolute, a regular file, and outside Apex's own
 * data folder (profiles, keys and the library's store are never opened this way).
 */
export function grantDropped(viewer: Pick<Viewer, 'grantLocal'>, dataDir: string, path: string): ViewerTarget | null {
  if (!isAbsolute(path)) return null
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    return null
  }
  let root = dataDir
  try {
    root = realpathSync(dataDir)
  } catch {
    // A data folder that isn't there yet holds nothing to protect.
  }
  if (within(root, real)) return null
  return viewer.grantLocal(real)
}

export function setupFiles(deps: FilesDeps): Files {
  const builtListeners = new Set<(file: LibraryFileRef) => void>()
  // Report updates can stream in quickly; one event per animation-ish beat is enough.
  let pending: ReturnType<typeof setTimeout> | null = null
  const store = new LibraryStore(join(deps.dataDir, 'library'), {
    trash: deps.trash,
    now: deps.now,
    onChange: () => {
      if (pending) return
      pending = setTimeout(() => {
        pending = null
        deps.broadcast({ type: 'library-files', items: store.list() })
      }, 60)
    },
  })
  const viewer = new Viewer({ dataDir: deps.dataDir, library: store, attachments: deps.attachments, chatFiles: deps.chatFiles, meetings: deps.meetings, trash: deps.trash, reveal: deps.reveal, saveDialog: deps.saveDialog, openDialog: deps.openDialog, now: deps.now })

  const built = (result: { file: LibraryFileRef; first: boolean }): LibraryFileRef => {
    if (result.first) for (const fn of builtListeners) fn(result.file)
    return result.file
  }

  const exportPath = async (path: string, name: string): Promise<string | null> => {
    const dest = await deps.saveDialog?.(name)
    if (!dest) return null
    copyFileSync(path, dest)
    return dest
  }

  const openArtifact = (id: string): void => {
    assertArtifactOpenable(store, id)
    if (!deps.openArtifact) throw new Error(mainT('files.error.noWindow'))
    deps.openArtifact(id)
  }

  const library: LibraryFiles = {
    addGenerated: (input) => store.addGenerated(input),
    beginReport: (input) => store.beginReport(input),
    updateReport: (id, content) => store.updateReport(id, content),
    finishReport: (id, content) => built(store.finishReport(id, content)),
    fail: (id, message) => store.fail(id, message),
    listByChat: (chatId) => store.listByChat(chatId),
    sizes: () => store.sizes(),
    get: (id) => store.get(id),
    forgetChat: (chatId) => store.forgetChat(chatId),
    saveArtifact: ({ chatId, companionId, title, format, content }) => built(store.saveArtifact({ chatId, companionId, name: artifactFileName(title, format), mediaType: MEDIA[format], content })),
    onArtifactBuilt: (fn) => {
      builtListeners.add(fn)
      return () => builtListeners.delete(fn)
    },
  }

  const services: FilesServices = {
    files: {
      list: (filter) => store.list(filter),
      rename: (id, name) => store.rename(id, name),
      remove: async (id) => {
        const { file, trashedPath } = await store.remove(id)
        viewer.notifyDeleted({ name: file.name, mediaType: file.mediaType, trashedPath, target: { kind: 'library', id } })
      },
      reveal: (id) => deps.reveal?.(store.pathOf(id)),
      export: async (id) => {
        const file = store.get(id)
        if (!file) throw new Error(mainT('files.error.gone'))
        return exportPath(store.pathOf(id), file.name)
      },
      openArtifact,
    },
    viewer: {
      open: (target, owner) => viewer.open(target, owner ?? null),
      save: (token, text) => viewer.save(token, text),
      rename: (token, name) => viewer.rename(token, name),
      remove: (token) => viewer.remove(token),
      reveal: (token) => {
        viewer.revealPath(token)
      },
      export: (token) => viewer.export(token),
      pickLocal: () => viewer.pickLocal(),
      grantDropped: (path) => grantDropped(viewer, deps.dataDir, path),
      release: (token) => viewer.release(token),
      bytes: async (token) => viewer.bytes(token),
      openArtifact: (token) => openArtifact(viewer.artifactIdFor(token)),
    },
  }

  return {
    services,
    library,
    viewer: {
      onDelete: (fn) => viewer.onDelete(fn),
      grantLocal: (path) => viewer.grantLocal(path),
    },
    store,
    documents: viewer,
    dispose: () => {
      if (pending) clearTimeout(pending)
      builtListeners.clear()
      viewer.dispose()
    },
  }
}
