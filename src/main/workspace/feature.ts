/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The workspace feature module (`workspace` in FEATURES): search everything,
// watched folders, version history, Recently Deleted, projects, spaces and
// the Workspace hub. The stores come from index.ts as AppContext.workspaceStores;
// without them (unit tests that build a bare context) every method stays a
// "Not available yet" stub.
import { BrowserWindow, dialog, shell } from 'electron'
import type { WorkspaceServices } from '@shared/workspace'
import { stubMethods } from '../serviceKit'
import type { Feature } from '../features/types'
import { log } from '../log'
import { mainT } from '../i18n/mainT'
import { createWorkspace, type Workspace } from './service'

type W = WorkspaceServices

/** The workspace client tools are registered by createWorkspace once its stores exist (search_everything and the folder tools). */
export function registerWorkspaceTools(): void {}

function stubs(): Partial<W> {
  return {
    search: stubMethods<W['search']>(['query', 'recent', 'state', 'rebuild']),
    folders: stubMethods<W['folders']>(['list', 'pick', 'grant', 'update', 'revoke', 'entries', 'readText', 'reveal', 'open']),
    versions: stubMethods<W['versions']>(['list', 'read', 'restore', 'refFor']),
    projects: stubMethods<W['projects']>(['list', 'get', 'save', 'remove', 'addChats', 'removeChats', 'addFiles', 'removeFiles', 'newChat', 'contextFiles']),
    spaces: stubMethods<W['spaces']>(['list', 'switchTo', 'moveTabs']),
    trash: stubMethods<W['trash']>(['list', 'restore', 'purge', 'empty']),
  }
}

let current: Workspace | null = null

/** The running workspace, for the workspace smoke checks. */
export function runningWorkspace(): Workspace | null {
  return current
}

export function createWorkspaceFeatures(): Feature {
  const pending: Parameters<Workspace['attachWindow']>[0][] = []
  return {
    name: 'workspace',
    app(ctx) {
      registerWorkspaceTools()
      const stores = ctx.workspaceStores
      if (!ctx.dataDir || !stores) return stubs()
      try {
        current = createWorkspace({
          dataDir: ctx.dataDir,
          stores,
          broadcast: ctx.broadcast,
          windows: ctx.windows,
          agent: { create: (options) => ctx.agent.create(options), start: (text, options) => ctx.agent.start(text, options) },
          content: ctx.content,
          smoke: ctx.smoke,
          shell: {
            async pickFolder() {
              const parent = BrowserWindow.getFocusedWindow()
              const options = { title: mainT('workspace.folder.pickTitle'), buttonLabel: mainT('workspace.folder.pickButton'), properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
              const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
              return result.canceled ? null : (result.filePaths[0] ?? null)
            },
            reveal: (path) => shell.showItemInFolder(path),
            openPath: (path) => shell.openPath(path),
          },
        })
      } catch (err) {
        log.error('workspace', 'The workspace could not start', { error: err instanceof Error ? err.message : String(err) })
        return stubs()
      }
      for (const win of pending.splice(0)) current.attachWindow(win)
      return current.services
    },
    window(win) {
      if (current) current.attachWindow(win)
      else pending.push(win)
    },
    dispose() {
      current?.dispose()
      current = null
    },
  }
}
