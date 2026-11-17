/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BrowserWindow, app, dialog, protocol, shell, type Session } from 'electron'
import { ARTIFACTS_PARTITION, FILE_SCHEME } from '@shared/files'
import { handleArtifactProtocol, openArtifactTab } from '../artifacts/tabs'
import { artifactRequestAllowed } from '../artifacts/policy'
import { fileTokenOf, serveFile } from '../files/fileProtocol'
import { assertArtifactOpenable, setupFiles, type Files } from '../files/service'
import { mainT } from '../i18n/mainT'
import { log } from '../log'
import { registerStorageCategory } from '../storage'
import { sandboxSession } from './sandboxSessions'
import type { Feature } from './types'

// The files feature module: Library › Files, the viewer, the apex-file and
// apex-artifact schemes and artifact tabs. It fills ctx.content.libraryFiles and
// ctx.content.viewer.

/** ON-13: the getting-started signal the first artifact sends. */
export const ARTIFACT_BUILT_SIGNAL = 'artifact-built' as const

let active: Files | null = null

/** The running files service, for the smoke checks only. */
export function filesForSmoke(): Files | null {
  return active
}

export function createFilesFeature(): Feature {
  const undo: (() => void)[] = []
  let files: Files | null = null
  let artifacts: Session | null = null
  return {
    name: 'files',
    app(ctx) {
      // Smoke runs never touch the person's real Trash: deletions go to a folder in the smoke profile.
      const trash = ctx.smoke
        ? async (path: string): Promise<void> => {
            const bin = join(ctx.dataDir, '.smoke-trash')
            mkdirSync(bin, { recursive: true })
            renameSync(path, join(bin, `${Date.now()}-${basename(path)}`))
          }
        : (path: string): Promise<void> => shell.trashItem(path)
      const parent = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      files = setupFiles({
        dataDir: ctx.dataDir,
        broadcast: ctx.broadcast,
        attachments: () => ctx.content.attachments,
        // The chat files reader (ctx.content.chatFiles throws "Not available yet" until intake fills it).
        chatFiles: () => ctx.content.chatFiles,
        meetings: () => ctx.personal.meetings.resolver,
        trash,
        reveal: (path) => shell.showItemInFolder(path),
        saveDialog: async (defaultName) => {
          const win = parent()
          const options = { title: mainT('files.export.title'), defaultPath: join(app.getPath('downloads'), defaultName), buttonLabel: mainT('files.export.button') }
          const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
          return picked.canceled || !picked.filePath ? null : picked.filePath
        },
        openDialog: async () => {
          const win = parent()
          const options = { title: mainT('files.pick.title'), properties: ['openFile' as const] }
          const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
          return picked.canceled ? null : (picked.filePaths[0] ?? null)
        },
      })
      active = files
      ctx.content.libraryFiles = files.library
      ctx.content.viewer = files.viewer
      const done = files

      // apex-file://<token>/: the chrome's and its overlays' session.
      protocol.handle(FILE_SCHEME, (request) => {
        const token = fileTokenOf(request.url)
        return serveFile(request, token ? done.documents.served(token) : null)
      })
      // Artifacts get no network, navigation or popups: only their own apex-artifact: document.
      artifacts = sandboxSession(ARTIFACTS_PARTITION, artifactRequestAllowed)
      undo.push(handleArtifactProtocol(artifacts, files.store))
      undo.push(
        () => protocol.unhandle(FILE_SCHEME),
        // ON-13: the first artifact ever built is a getting-started signal, through the same
        // once-per-launch channel as the other signals; index.ts maps it onto the 'build-artifact' checklist item.
        files.library.onArtifactBuilt((file) => {
          log.info('files', 'first artifact built', { id: file.id })
          ctx.signal(ARTIFACT_BUILT_SIGNAL)
        }),
        registerStorageCategory({
          id: 'library-files',
          label: mainT('files.storage.libraryFiles'),
          order: 26,
          measure: async () => done.library.sizes().libraryFiles,
        }),
        files.dispose,
      )
      return files.services
    },
    window(win) {
      if (!files || !artifacts) return
      const { documents, store } = files
      const session = artifacts
      // The caller's window opens the tab; the app-level method can't know which window asked.
      const open = (id: string): void => {
        assertArtifactOpenable(store, id)
        openArtifactTab(win, id, session)
      }
      return {
        files: { openArtifact: open },
        viewer: { openArtifact: (token: string) => open(documents.artifactIdFor(token)) },
      }
    },
    tab(tab) {
      // A viewer token expires with the tab that showed it.
      return () => files?.documents.releaseOwner(tab.id)
    },
    dispose: () => {
      active = null
      for (const fn of undo.splice(0)) fn()
    },
  }
}
