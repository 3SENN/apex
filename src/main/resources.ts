/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { BRANDING } from '@shared/branding'

// Runtime resources: the branding's icons and tray images, in
// branding/<official|unofficial>/resources/, which electron-builder copies to
// <resourcesPath>/resources when packaged (scripts/branding.mjs). Native
// helpers (atelier-speech, the haptics addon) have their own paths beside them.

/**
 * The pure root finder, for tests: the app path when packaged; in dev, the
 * nearest folder at or above it with a package.json. `electron-vite dev
 * --outDir out-dev --entry out-dev/main/index.js` makes the app path
 * `<repo>/out-dev/main`, where native/, resources/ and src/ don't exist.
 */
export function resolveAppRoot(o: { packaged: boolean; appPath: string; exists?: (path: string) => boolean }): string {
  if (o.packaged) return o.appPath
  const exists = o.exists ?? existsSync
  for (let dir = o.appPath; ; dir = dirname(dir)) {
    if (exists(join(dir, 'package.json'))) return dir
    if (dirname(dir) === dir) return o.appPath
  }
}

/** The project folder in dev, the app path when packaged. Dev-only paths (native helper builds, source assets) start here. */
export function appRoot(): string {
  return resolveAppRoot({ packaged: app.isPackaged, appPath: app.getAppPath() })
}

/** The pure resolver, for tests. `branding` is the branding's id (BRANDING.id). */
export function resolveResourcePath(o: { packaged: boolean; resourcesPath: string; appPath: string; branding: string }, segments: string[]): string {
  return o.packaged ? join(o.resourcesPath, 'resources', ...segments) : join(o.appPath, 'branding', o.branding, 'resources', ...segments)
}

/** `<resourcesPath>/resources/...` when packaged, `<appRoot>/branding/<id>/resources/...` in dev. */
export function resourcePath(...segments: string[]): string {
  return resolveResourcePath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: appRoot(), branding: BRANDING.id }, segments)
}
