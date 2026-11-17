/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { PROFILE_HUE_IDS } from '@shared/profile'
import { PROFILE_ID, PROFILE_NAME_MAX, type ProfilesServices } from '@shared/profiles'
import type { SchemaMap } from '../schemas/types'

// Argument schemas for Services.profiles. main/services.ts spreads them.

const profileId = z.union([z.literal('default'), z.string().regex(PROFILE_ID)])
const name = z.string().trim().min(1).max(PROFILE_NAME_MAX)
const hue = z.enum(PROFILE_HUE_IDS)

export const PROFILES_SCHEMAS: SchemaMap<ProfilesServices> = {
  profiles: {
    list: z.tuple([]),
    current: z.tuple([]),
    create: z.tuple([z.object({ name, hue }).strict()]),
    rename: z.tuple([profileId, name]),
    setHue: z.tuple([profileId, hue]),
    switchTo: z.tuple([profileId]),
    deletionSummary: z.tuple([profileId]),
    // The typed name is compared exactly, so it is not trimmed here.
    remove: z.tuple([profileId, z.string().max(PROFILE_NAME_MAX + 8)]),
  },
}
