/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { ConnectorsSurfaceProps } from '@shared/overlay/connectors'
import { MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { ConnectorAddSurface, ConnectorLocalApprovalSurface } from './ConnectorSurfaces'

// Connectors (the custom server dialog, the local server approval): window
// modals. Props are checked at open; the approval carries only names and
// flags for environment variables, never their values.

const connectorId = z.string().min(1).max(128)

const add: SurfaceModule<ConnectorsSurfaceProps['connector-add-dialog']> = {
  component: ConnectorAddSurface,
  props: z.object({ connectorId: connectorId.optional(), mode: z.enum(['remote', 'local', 'json']).optional() }).strict(),
  policy: { ...MODAL_POLICY, size: 'fill-window' },
}

const approval: SurfaceModule<ConnectorsSurfaceProps['connector-local-approval']> = {
  component: ConnectorLocalApprovalSurface,
  props: z
    .object({
      connectorId,
      name: z.string().max(200),
      command: z.string().min(1).max(1024),
      args: z.array(z.string().max(4096)).max(64),
      cwd: z.string().max(4096).nullable(),
      env: z.array(z.object({ name: z.string().max(128), secret: z.boolean() }).strict()).max(100),
    })
    .strict(),
  policy: { ...MODAL_POLICY, size: 'fill-window' },
}

export const CONNECTORS_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; each schema checks props at open.
  'connector-add-dialog': add as unknown as SurfaceModule<never>,
  'connector-local-approval': approval as unknown as SurfaceModule<never>,
}
