/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { TaskManagerSurfaceProps } from '@shared/dialogs'
import { MODAL_POLICY, type SurfaceModule } from '../../../types'
import { TaskManagerSheet } from './TaskManagerSheet'

// The `task-manager` module: a window sheet over a scrim. Esc, the
// close button and a press on the scrim close it; it stays across tab switches.

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0), height: z.number().finite().min(0) }).strict()

export const taskManagerSurface: SurfaceModule<TaskManagerSurfaceProps> = {
  component: TaskManagerSheet,
  props: z.object({ area: rect }).strict(),
  policy: MODAL_POLICY,
}
