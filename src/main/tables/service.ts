/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The `tables` service and its Recently Deleted adapter.
// Imports go file picker → preview (types and header, editable) → confirm;
// deletes go through the workspace trash as a CSV snapshot, so Restore brings the
// rows back.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { SHARED_OWNER } from '@shared/chats'
import type { TableColumn, TableSummary, TablesService } from '@shared/tables'
import { log } from '../log'
import { registerTrashAdapter, trash } from '../workspace/adapters'
import type { TableStore } from './store'

export interface TablesServiceDeps {
  store: TableStore
  dataDir: string
  broadcast(event: { type: 'tables'; items: TableSummary[] }): void
  /** Smoke runs pick this file instead of showing the open dialog. */
  pickPath?: () => string | null
  /** And save exports here. */
  savePath?: (name: string) => string | null
}

interface TableTrashPayload {
  owner: string
  name: string
  columns: TableColumn[]
}

export function createTablesService(deps: TablesServiceDeps): TablesService & { changed(): void } {
  const { store } = deps
  const changed = (): void => deps.broadcast({ type: 'tables', items: store.list() })
  const trashDir = join(deps.dataDir, 'tables', '.snapshots')

  registerTrashAdapter({
    kind: 'table',
    title: (id) => store.get(id).name,
    snapshot(id) {
      const table = store.get(id)
      mkdirSync(trashDir, { recursive: true })
      const path = join(trashDir, `${id}.csv`)
      store.writeCsv(id, path)
      return { payload: { owner: table.owner, name: table.name, columns: table.columns } satisfies TableTrashPayload, files: [path] }
    },
    restore(payload, files) {
      const p = payload as TableTrashPayload
      const csv = files[0]
      if (!csv || !existsSync(csv)) throw new Error('The saved rows for this table are missing.')
      const name = store.restoreFrom(p.owner, p.name, p.columns, csv)
      changed()
      return name
    },
  })

  const window = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

  return {
    changed,
    list: (owner) => store.list(owner),
    get: (id) => store.get(id),
    async pickCsv(owner = SHARED_OWNER) {
      let path: string | null
      if (deps.pickPath) path = deps.pickPath()
      else {
        const win = window()
        const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }] }
        const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
        path = picked.canceled ? null : (picked.filePaths[0] ?? null)
      }
      if (!path) return null
      return store.preview(path, owner)
    },
    async confirmImport(token, input) {
      const summary = await store.confirm(token, input)
      log.info('tables', `imported ${summary.rowCount} rows into ${summary.name}`)
      changed()
      return summary
    },
    previewColumns: (token, hasHeader) => store.columnsFor(token, hasHeader),
    rows: (id, q) => store.rows(id, q),
    rename(id, name) {
      const summary = store.rename(id, name)
      changed()
      return summary
    },
    remove(id) {
      trash.put('table', id)
      store.drop(id)
      rmSync(join(trashDir, `${id}.csv`), { force: true })
      changed()
    },
    async exportCsv(id) {
      const table = store.get(id)
      let path: string | null
      if (deps.savePath) path = deps.savePath(table.name)
      else {
        const win = window()
        const options: Electron.SaveDialogOptions = { defaultPath: `${table.name}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] }
        const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        path = picked.canceled || !picked.filePath ? null : picked.filePath
      }
      if (!path) return null
      store.writeCsv(id, path)
      return path
    },
  }
}
