/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { ProfilesSurfaceProps } from '@shared/overlay/profiles'
import { MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { ProfileCreateSurface, ProfileDeleteSurface } from './ProfileSurfaces'

// The profile surfaces (create and delete profile): window modals over the
// whole window, like clear browsing data.

const create: SurfaceModule<ProfilesSurfaceProps['profile-create']> = {
  component: ProfileCreateSurface,
  props: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  policy: { ...MODAL_POLICY, size: 'fill-window' },
}

const remove: SurfaceModule<ProfilesSurfaceProps['profile-delete']> = {
  component: ProfileDeleteSurface,
  props: z.object({ profileId: z.string().regex(/^(default|[a-z0-9]{8,32})$/) }).strict(),
  policy: { ...MODAL_POLICY, size: 'fill-window' },
}

export const PROFILES_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; each schema checks props at open.
  'profile-create': create as unknown as SurfaceModule<never>,
  'profile-delete': remove as unknown as SurfaceModule<never>,
}
