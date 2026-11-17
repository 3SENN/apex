/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { app, nativeImage, type AboutPanelOptionsOptions, type NativeImage } from 'electron'
import { BRANDING } from '@shared/branding'
import { mainT } from './i18n/mainT'
import { resourcePath } from './resources'

// The app's name and icon wherever the system shows the app: the menu bar,
// the Dock, the app switcher, the About panel, notifications, login items and
// dialogs. Both come from the branding the build was made with (official Apex
// or the unofficial Summit; scripts/branding.mjs). The packaged app's bundle
// carries the name (electron-builder's productName); a dev run starts
// Electron's own bundle, which scripts/dev-branding.mjs renames on `predev`
// and which gets the branding's Dock icon here. app.name also names the
// profile folder, so each branding keeps its own.

export const APP_NAME = BRANDING.name

/** The branding's standard icon file (resources/icons). */
export const APP_ICON_FILE = 'app-512.png'

/** First thing main does, before anything reads app.name or the profile folder. */
export function applyAppName(): void {
  if (app.getName() !== APP_NAME) app.setName(APP_NAME)
  // On macOS the bundle name names the process: libuv's title setter there
  // marks the app a background daemon, which would cost it its Dock icon.
  if (process.platform === 'darwin') return
  try {
    process.title = APP_NAME
  } catch {
    // Some hosts keep the title read-only.
  }
}

/** The About panel's options (macOS, Linux, Windows). */
export function aboutPanelOptions(o: { version: string; credits: string; platform: NodeJS.Platform; iconPath?: string | null }): AboutPanelOptionsOptions {
  return {
    applicationName: APP_NAME,
    applicationVersion: o.version,
    // macOS adds the bundle's build number in brackets; in a dev run that is Electron's version.
    ...(o.platform === 'darwin' ? { version: '' } : {}),
    credits: o.credits,
    // macOS shows the app's own icon; the others take a file.
    ...(o.platform !== 'darwin' && o.iconPath ? { iconPath: o.iconPath } : {}),
  }
}

/** Shows the About panel in the current app language. */
export function showAboutPanel(): void {
  const iconPath = resourcePath('icons', APP_ICON_FILE)
  app.setAboutPanelOptions(aboutPanelOptions({ version: app.getVersion(), credits: mainT('updates.about.panelCredits'), platform: process.platform, iconPath: existsSync(iconPath) ? iconPath : null }))
  app.showAboutPanel()
}

/** The branding's standard icon (resources/icons), or null when the file is missing. */
export function standardAppIcon(): NativeImage | null {
  const path = resourcePath('icons', APP_ICON_FILE)
  if (!existsSync(path)) return null
  const image = nativeImage.createFromPath(path)
  return image.isEmpty() ? null : image
}

/** A dev run's Dock tile, until a companion icon takes its place: the branding's, not Electron's. */
export function applyDevDockIcon(): void {
  if (process.platform !== 'darwin' || app.isPackaged || !app.dock) return
  const icon = standardAppIcon()
  if (icon) app.dock.setIcon(icon)
}
