/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { setupProfiles, type Profiles } from '../profiles/service'
import type { Feature } from './types'

// The profiles feature module, first of the ctx.content features in FEATURES.
// It fills ctx.content.profiles before the others run, so every later one can ask
// for a profile's session or data folder. Services.profiles.current() is window-scoped: the
// profile of the window that asks.
export function createProfilesFeature(): Feature {
  let profiles: Profiles | null = null
  return {
    name: 'profiles',
    app(ctx) {
      profiles = setupProfiles({
        dataDir: ctx.dataDir,
        settings: ctx.settings,
        broadcast: ctx.broadcast,
        windows: ctx.windows,
        stopChat: (chatId) => void ctx.agent.stop(chatId),
      })
      ctx.content.profiles = profiles.manager
      return profiles.services
    },
    window: (win) => (profiles ? { profiles: profiles.windowServices(win.id) } : undefined),
    dispose: () => profiles?.dispose(),
  }
}
