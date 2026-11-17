/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { LoginItemApproval } from '../../../system/LoginItemApproval'
import { MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'

// System surfaces: the open-at-login approval dialog (OV-09), a
// fixed modal: Esc and Not now close it, a click outside does not.

const loginItemApproval: SurfaceModule<Record<string, never>> = {
  component: LoginItemApproval,
  props: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  policy: { ...MODAL_POLICY, size: 'fixed' },
}

export const SYSTEM_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; each schema checks props at open.
  'login-item-approval': loginItemApproval as unknown as SurfaceModule<never>,
}
