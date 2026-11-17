/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { registerMenuContribution } from '@shared/menuModel'
import { setupSystem, type SystemRuntime } from '../system/service'
import type { Feature } from './types'

// The system feature module: background mode, the tray, the login item and the
// Windows and Linux runtime. The tray menu is the 'tray' target's
// contributions, this module's first.
let unregister: Array<() => void> = []
let runtime: SystemRuntime | null = null

export const systemFeature: Feature = {
  name: 'system',
  app(ctx) {
    const system = setupSystem({
      settings: ctx.settings,
      routines: ctx.maintenance.routines,
      meetings: ctx.personal.recorder,
      windows: ctx.windows,
      attention: ctx.maintenance.attention,
      commands: ctx.commands,
      broadcast: (event) => ctx.broadcast(event),
      // Filled by the updates feature, which runs first.
      updates: () => ctx.maintenance.updates ?? null,
      dataDir: ctx.dataDir,
      smoke: ctx.smoke,
    })
    runtime = system.runtime
    unregister = [registerMenuContribution({ id: 'system:tray', target: 'tray', build: () => system.runtime.trayItems() })]
    // The unit tests load features outside Electron; the runtime only starts inside it.
    if (process.versions.electron) system.runtime.start()
    return system.services
  },
  dispose() {
    for (const off of unregister) off()
    unregister = []
    runtime?.stop()
    runtime = null
  },
}
