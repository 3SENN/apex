/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { ServerBarProps } from '@shared/overlay/packs'
import type { SurfaceMap, SurfaceModule } from '../../types'
import { ServerBar } from './ServerBar'
import './server-bar.css'

// Packs' surface: Atelier's bar over an app whose web server runs (atelier.server).
// Like the sharing bar: at the top of the app's pane, never in the way of a
// click elsewhere, hidden while another tab shows and back with the app's.

export const serverBar: SurfaceModule<ServerBarProps> = {
  component: ServerBar,
  props: z
    .object({
      tabId: z.string().min(1).max(128),
      app: z.string().min(1).max(80),
      lan: z.boolean(),
      connections: z.number().int().min(0).max(1_000),
      hint: z.boolean(),
    })
    .strict(),
  policy: { tier: 'interactive', size: 'fixed', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'hide-until-return', layer: 'hint', focus: false, exitMs: 120 },
  placement: 'top-center',
  // The bar's own frame holds the 8 px to the pane's top, with room for its shadow.
  gap: 0,
}

export const PACKS_SURFACE_MAP: SurfaceMap = {
  'server-bar': serverBar as unknown as SurfaceModule<never>,
}
