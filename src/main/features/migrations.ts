/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { app, shell } from 'electron'
import { setupMigrations, type Migrations } from '../migrations/service'
import type { Feature } from './types'

// The migrations feature module: chat-store migrations and the report. It
// fills ctx.maintenance.migrations, which the problem report reads.

let current: Migrations | null = null

export const migrationsFeature: Feature = {
  name: 'migrations',
  app(ctx) {
    const { services, migrations } = setupMigrations({
      chats: ctx.maintenance.chats,
      dataDir: ctx.dataDir,
      // Optional chaining keeps the module loadable where electron is a stub (unit tests).
      appVersion: app?.getVersion?.() ?? '0.0.0',
      view: (chatId) => ctx.agent.view(chatId),
      broadcast: (event) => ctx.broadcast(event),
      reveal: (path) => shell?.showItemInFolder?.(path),
    })
    current = migrations
    ctx.maintenance.migrations = services.migrations
    return services
  },
  // The background pass resumes at the next start.
  dispose() {
    current?.stop()
    current = null
  },
}
