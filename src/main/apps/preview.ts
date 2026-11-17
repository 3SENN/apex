/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// build_app's look at its own draft (APP-UI): the draft opened off-screen in
// its own sandbox, captured in light and then in dark, with the errors its
// console showed, so the model sees what the person will see and fixes it
// before saying it's done. Nothing here is shown to the person.
import { BrowserWindow } from 'electron'
import { appVersionUrl } from '@shared/apps'
import { cdp } from '../cdp'
import type { AppSandbox } from './protocol'

/** About a tab's content area, so the layout is the one the person gets. */
const SIZE = { width: 1000, height: 700 }
const LOAD_MS = 8000
/** Time for fonts, the first script run and a theme switch to settle. */
const SETTLE_MS = 450
const SHOT_WIDTH = 800

export interface DraftPreview {
  images: Array<{ mediaType: 'image/jpeg'; data: string }>
  /** Console errors and crashes while it loaded (at most five). */
  errors: string[]
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function previewDraft(sandbox: Pick<AppSandbox, 'preferencesFor' | 'harden'>, appId: string, versionId: string): Promise<DraftPreview> {
  const url = appVersionUrl(appId, versionId)
  const prefs = sandbox.preferencesFor(url)
  if (!prefs) return { images: [], errors: [] }
  const win = new BrowserWindow({ show: false, ...SIZE, useContentSize: true, webPreferences: { ...prefs, offscreen: true } })
  const wc = win.webContents
  sandbox.harden(wc, appId)
  const errors: string[] = []
  wc.on('console-message', (event) => {
    if (event.level === 'error' && errors.length < 5) errors.push(event.message.slice(0, 300))
  })
  wc.on('render-process-gone', () => errors.push('The app’s page crashed.'))
  let release: (() => void) | null = null
  try {
    await Promise.race([win.loadURL(url), wait(LOAD_MS).then(() => Promise.reject(new Error('The draft did not load in time.')))])
    release = cdp.acquire(wc)
    const images: DraftPreview['images'] = []
    for (const scheme of ['light', 'dark'] as const) {
      await cdp.send(wc, 'Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
      await wait(SETTLE_MS)
      if (wc.isDestroyed()) break
      const image = await wc.capturePage()
      if (!image.isEmpty()) images.push({ mediaType: 'image/jpeg', data: image.resize({ width: SHOT_WIDTH }).toJPEG(74).toString('base64') })
    }
    return { images, errors }
  } catch (err) {
    return { images: [], errors: [...errors, err instanceof Error ? err.message : String(err)].slice(0, 5) }
  } finally {
    release?.()
    if (!win.isDestroyed()) win.destroy()
  }
}
