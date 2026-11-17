/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { call } from '../api'
import { isMac, motionReduced } from '../ui'

// The haptic tick for the split seam (SH-41). The split view passes
//   <Seam snapPoints={SPLIT_SNAP_POINTS} onSnap={snapHaptic} … />
// with the seam's value as the primary side's share of the width.

/** Apex's split stops: thirds either side of the even split. */
export const SPLIT_SNAP_POINTS: readonly number[] = [1 / 3, 1 / 2, 2 / 3]

/** The seam's onSnap: one alignment tick, never under Reduce Motion or off macOS. Main rate-limits and honours settings.haptics. */
export function snapHaptic(): void {
  if (!isMac || motionReduced()) return
  void call('haptics', 'perform', 'alignment').catch(() => undefined)
}
