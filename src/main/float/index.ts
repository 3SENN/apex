/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { join } from 'node:path'
import type { FloatKind } from '@shared/float'
import { APP_ORIGIN, devRendererUrl } from '../appProtocol'
import { FloatManager, type FloatManagerDeps } from './manager'
import { loadFloatShim } from './native'

export { FloatManager } from './manager'
export type { FloatManagerDeps } from './manager'

/** The float page for a kind: the dev server under electron-vite dev, app://atelier otherwise. */
export function floatUrl(kind: FloatKind): string {
  const dev = devRendererUrl()
  const base = dev ? dev.replace(/\/$/, '') : APP_ORIGIN
  return `${base}/float.html?kind=${encodeURIComponent(kind)}`
}

/** Builds the app's FloatManager with the bundled preload and page; call start() after ready. */
export function createFloatManager(deps: Omit<FloatManagerDeps, 'preload' | 'url' | 'shim'>): FloatManager {
  return new FloatManager({ ...deps, preload: join(__dirname, '../preload/float.js'), url: floatUrl, shim: loadFloatShim() })
}
