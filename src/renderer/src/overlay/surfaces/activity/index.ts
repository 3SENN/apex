/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { ActivitySurfaceProps } from '@shared/overlay/activity'
import { ActivityStatusPopover } from '../../../activity/ActivityStatusPopover'
import { MENU_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'

// The activity surfaces (`activity-status`, OV-24: the activity-memory status popover
// from the toolbar glyph; a MENU_POLICY surface). Props are in
// @shared/overlay/activity.

const status: SurfaceModule<ActivitySurfaceProps['activity-status']> = {
  component: ActivityStatusPopover,
  // It loads the live status itself, so it takes no props.
  props: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  // Esc or a click outside closes it; another tab closes it too.
  policy: MENU_POLICY,
  placement: 'below',
  gap: 6,
}

export const ACTIVITY_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; the schema checks props at open.
  'activity-status': status as unknown as SurfaceModule<never>,
}
