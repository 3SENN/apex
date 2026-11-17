/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DownloadsServiceAdditions, MenuServices } from '@shared/services/menus'
import { DOWNLOADS_SERVICE, attachDownloads, wireDownloads } from '../downloads'
import { setupMainMenu } from '../menuFeature'
import { dialogsTab, dialogsWindowServices, setupDialogs } from '../dialogsFeature'
import type { Feature, ServiceParts } from './types'

// Menus, dialogs, toasts, page actions and downloads.
// Served by main/downloads.ts
export const DOWNLOADS_ADDITIONS: DownloadsServiceAdditions = DOWNLOADS_SERVICE

export const menusFeature: Feature = {
  name: 'menus',
  // Private windows' downloads are tracked too
  session(session, info) {
    attachDownloads(session, info.private)
  },
  app(ctx): MenuServices & ServiceParts {
    return {
      // First, so its commands win over the menus' fallbacks
      ...setupDialogs(ctx),
      // The menus service; also registers the Edit and Tools commands
      menus: setupMainMenu(ctx),
      // Wires settings, tab attribution and the chrome's events into the manager.
      downloads: wireDownloads(ctx),
    }
  },
  // Services routed to the sender's window; page dialogs and Leave this page?
  window(win) {
    return dialogsWindowServices(win)
  },
  tab(tab, win) {
    return dialogsTab(tab, win)
  },
}
