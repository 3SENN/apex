/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import type { CompanionLook, CompanionMood } from '@shared/companion'
import { FaceAvatar } from '../../companion'

/** A companion's face in its own colour (CO-18), rendered off-screen and cached; its initial until it is ready. */
export function CompanionAvatar({ look, name, size = 44, dimmed = false, mood }: { look: CompanionLook; name: string; size?: number; dimmed?: boolean; mood?: CompanionMood }): ReactElement {
  return <FaceAvatar look={look} name={name} size={size} mood={mood} dimmed={dimmed} label="" />
}
