/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { WorkspaceSurfaceProps } from '@shared/overlay/workspace'
import { MENU_POLICY, MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { FolderAccessSurface } from './FolderAccessSurface'
import { SpaceSwitcher } from './SpaceSwitcher'

// Workspace surfaces: `space-switcher`, the Space row's menu of spaces,
// drawn below the row; and `folder-access` (CH-43), a MODAL_POLICY surface
// mounting FolderAccessDialog. Props are in @shared/overlay/workspace.

const spaceSwitcher: SurfaceModule<WorkspaceSurfaceProps['space-switcher']> = {
  component: SpaceSwitcher,
  // The surface lists its host's own window; a window id here is only a hint.
  props: z.object({ windowId: z.number().int().nonnegative().optional() }).strict(),
  policy: MENU_POLICY,
  placement: 'below',
  gap: 4,
}

const folderAccess: SurfaceModule<WorkspaceSurfaceProps['folder-access']> = {
  component: FolderAccessSurface,
  props: z.object({ path: z.string().min(1).max(4096), chatId: z.string().min(1).max(128).nullable() }).strict(),
  policy: { ...MODAL_POLICY, size: 'fill-window' },
}

export const WORKSPACE_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; the schema checks props at open.
  'space-switcher': spaceSwitcher as unknown as SurfaceModule<never>,
  'folder-access': folderAccess as unknown as SurfaceModule<never>,
}
