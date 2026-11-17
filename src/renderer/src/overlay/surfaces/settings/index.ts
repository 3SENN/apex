/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { SettingsSurfaceProps } from '@shared/overlay/settings'
import { MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { ClearDataSurface } from './ClearDataSurface'

// The settings surfaces (clear browsing data). Each surface
// is registered here.

const clearData: SurfaceModule<SettingsSurfaceProps['clear-data']> = {
  component: ClearDataSurface,
  props: z.object({ range: z.enum(['hour', 'day', 'week', 'month', 'all']).optional() }).strict(),
  policy: { ...MODAL_POLICY, size: 'fill-window' },
}

export const SETTINGS_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; the schema checks props at open.
  'clear-data': clearData as unknown as SurfaceModule<never>,
}
