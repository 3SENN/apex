/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The `apps` service: list, versions and restore,
// open in a tab, export, Recently Deleted (the `app` adapter), the New app
// flow, and the preview still the chat card shows.
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { BrowserWindow, dialog } from 'electron'
import { appRunUrl } from '@shared/url'
import { appVersionUrl, type AppSummary, type AppsService } from '@shared/apps'
import { log } from '../log'
import { registerTrashAdapter, trash } from '../workspace/adapters'
import { buildBrief } from './brief'
import type { AppSandbox } from './protocol'
import type { AppStore } from './store'

export interface AppsServiceDeps {
  store: AppStore
  sandbox: AppSandbox
  broadcast(event: { type: 'apps'; items: AppSummary[] }): void
  /** Opens (or shows) a URL in a tab of the focused window. */
  openTab(url: string): void
  /** startChat: the New app flow's chat, opened as a page. */
  startChat(text: string, options: { companionId?: string; context: string; open: 'page' }): string
  activeCompanion(): string
  savePath?: (name: string) => string | null
}

const PREVIEW_TIMEOUT_MS = 8_000
const PREVIEW_SIZE = { width: 960, height: 640 }

export function createAppsService(deps: AppsServiceDeps): AppsService & { changed(): void } {
  const { store } = deps
  const changed = (): void => deps.broadcast({ type: 'apps', items: store.list() })
  // Versions never change once written, so a still can be kept for the session.
  const stills = new Map<string, string>()

  registerTrashAdapter({
    kind: 'app',
    title: (id) => store.get(id).name,
    snapshot: (id) => ({ payload: { id, name: store.get(id).name }, files: [store.dirOf(id)] }),
    restore(payload, files) {
      const { id, name } = payload as { id: string; name: string }
      const from = files[0]
      const to = store.dirOf(id)
      if (from && existsSync(from) && from !== to && !existsSync(to)) renameSync(from, to)
      if (!store.has(id)) throw new Error('The saved files for this app are missing.')
      changed()
      return name
    },
  })

  const render = (appId: string, versionId: string): Promise<string | null> =>
    new Promise((resolve) => {
      const prefs = deps.sandbox.preferencesFor(appVersionUrl(appId, versionId))
      if (!prefs) return resolve(null)
      const win = new BrowserWindow({ show: false, ...PREVIEW_SIZE, webPreferences: { ...prefs, offscreen: true } })
      deps.sandbox.harden(win.webContents, appId)
      win.webContents.setAudioMuted(true)
      let done = false
      const finish = (value: string | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (!win.isDestroyed()) win.destroy()
        resolve(value)
      }
      const timer = setTimeout(() => finish(null), PREVIEW_TIMEOUT_MS)
      win.webContents.once('did-finish-load', () => {
        // Give the app's first script a moment to draw.
        setTimeout(() => {
          if (done || win.isDestroyed()) return
          win.webContents
            .capturePage()
            .then((image) => finish(image.isEmpty() ? null : image.resize({ width: 480 }).toDataURL()))
            .catch(() => finish(null))
        }, 500)
      })
      win.webContents.once('did-fail-load', () => finish(null))
      void win.loadURL(appVersionUrl(appId, versionId)).catch(() => finish(null))
    })

  return {
    changed,
    list: (owner) => store.list(owner),
    get: (id) => store.get(id),
    save(input) {
      const app = store.save(input, deps.activeCompanion())
      changed()
      return app
    },
    saveDraft(id, versionId) {
      const app = store.saveDraft(id, versionId)
      changed()
      return app
    },
    remove(id) {
      store.get(id)
      trash.put('app', id)
      // Recently Deleted moved the folder; anything left behind goes.
      if (store.has(id)) store.purge(id)
      changed()
    },
    restoreVersion(id, versionId) {
      const app = store.restoreVersion(id, versionId)
      changed()
      return app
    },
    open(id, versionId) {
      const app = store.get(id)
      if (!versionId && !app.currentVersionId && !app.draftVersionId) throw new Error('This app has no version to open yet.')
      deps.openTab(versionId ? appVersionUrl(id, versionId) : appRunUrl(id))
    },
    startBuild(description, companionId) {
      const brief = buildBrief(description)
      return deps.startChat(brief.text, { companionId, context: brief.context, open: 'page' })
    },
    async exportHtml(id) {
      const app = store.get(id)
      const html = store.html(id)
      const safe = app.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'app'
      let path: string | null
      if (deps.savePath) path = deps.savePath(safe)
      else {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const options: Electron.SaveDialogOptions = { defaultPath: `${safe}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] }
        const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        path = picked.canceled || !picked.filePath ? null : picked.filePath
      }
      if (!path) return null
      writeFileSync(path, html, 'utf8')
      return path
    },
    async preview(id, versionId) {
      const key = `${id}:${versionId}`
      const cached = stills.get(key)
      if (cached) return cached
      if (!store.get(id).versions.some((v) => v.id === versionId)) throw new Error('That version no longer exists.')
      try {
        const still = await render(id, versionId)
        if (still) stills.set(key, still)
        return still
      } catch (err) {
        log.warn('apps', 'preview failed', { error: err instanceof Error ? err.message : String(err) })
        return null
      }
    },
  }
}
