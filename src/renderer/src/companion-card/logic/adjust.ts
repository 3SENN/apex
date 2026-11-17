/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CompanionLook, LookAdjustKey } from '@shared/companion'
import { normalizeAdjust } from '@shared/companionLogic'

// DS-120: setting and clearing the look's part adjustments, normalised the
// same way main and the files do.

/** The look with one adjustment set (normalised: clamped, stepped, zeros dropped). */
export function withAdjust(look: CompanionLook, key: LookAdjustKey, value: number): CompanionLook {
  const adjust = normalizeAdjust({ ...look.adjust, [key]: value })
  const { adjust: _old, ...rest } = look
  return adjust ? { ...rest, adjust } : rest
}

/** The look with every adjustment back at the default. */
export function withoutAdjust(look: CompanionLook): CompanionLook {
  const { adjust: _old, ...rest } = look
  return rest
}
