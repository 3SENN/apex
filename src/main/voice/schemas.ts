/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { HUD_ACTIONS, type VoiceServices } from '@shared/voice'
import type { SchemaMap } from '../schemas/types'

// Argument schemas for the voice service.
export const VOICE_SCHEMAS: SchemaMap<VoiceServices> = {
  voice: {
    status: z.tuple([]),
    launcherToggle: z.tuple([]),
    hudAction: z.tuple([z.enum(HUD_ACTIONS)]),
    shortcutStatus: z.tuple([]),
  },
}
