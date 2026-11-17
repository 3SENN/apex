/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, powerMonitor } from 'electron'
import { hapticsAddonPaths } from '../native/haptics'
import { setupNative, type NativeSetup } from '../native/service'
import { appRoot } from '../resources'
import type { Feature } from './types'

// The native feature module: trackpad haptics and the lid pause for meeting recordings.
let native: NativeSetup | null = null

export const nativeFeature: Feature = {
  name: 'native',
  app(ctx) {
    native = setupNative({
      settings: ctx.settings,
      broker: ctx.personal.broker,
      recorder: ctx.personal.recorder,
      notify: (n) => ctx.notify(n),
      // Undefined outside Electron (unit tests), where nothing sleeps.
      power: powerMonitor ?? undefined,
      addonPaths: () => (app ? hapticsAddonPaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: appRoot() }) : []),
    })
    return native.services
  },
  dispose() {
    native?.dispose()
    native = null
  },
}
