/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { RELEASE } from '@shared/release'
import type { AboutInfo } from '@shared/services/settings'
import { systemLanguages } from './languages'

// Settings › About (ST-56): the version and what it runs on. The
// licence list is a static file the chrome reads (licenses.json, written by
// scripts/licenses.mjs at build time); Chromium's own licences are the
// LICENSES.chromium.html Electron ships. The website comes from the release
// defines; a build without one shows no link.

const CHROMIUM_LICENSES = 'LICENSES.chromium.html'

/**
 * Electron's LICENSES.chromium.html, or null. electron-builder puts it in
 * Resources on macOS and next to the executable on Windows and Linux; a dev
 * run finds it beside Electron's own app (node_modules/electron/dist).
 */
export function chromiumLicensesFile(paths: { resourcesPath: string; execPath: string } = { resourcesPath: process.resourcesPath, execPath: process.execPath }, exists: (path: string) => boolean = existsSync): string | null {
  const candidates = [join(paths.resourcesPath, CHROMIUM_LICENSES), join(dirname(paths.execPath), CHROMIUM_LICENSES), join(paths.resourcesPath, '..', '..', '..', CHROMIUM_LICENSES)]
  return candidates.find((file) => exists(file)) ?? null
}

export function aboutInfo(): AboutInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chromium: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    website: /^https:\/\//.test(RELEASE.website) ? RELEASE.website : '',
    chromiumLicenses: chromiumLicensesOnce(),
    systemLanguages: systemLanguages(),
  }
}

let chromiumLicenses: string | undefined
/** The file URL, looked up once: the file doesn't move while the app runs. */
function chromiumLicensesOnce(): string {
  if (chromiumLicenses === undefined) {
    const file = chromiumLicensesFile()
    chromiumLicenses = file ? pathToFileURL(file).href : ''
  }
  return chromiumLicenses
}
