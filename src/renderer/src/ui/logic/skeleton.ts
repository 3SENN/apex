/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// DS-106: timing rules for loading skeletons. A load that finishes within
// the grace never shows one (no flash on fast loads); once a skeleton is on
// screen it stays at least the hold, so it never blinks in and out.

/** A skeleton appears only once loading has taken this long. */
export const SKELETON_GRACE_MS = 100
/** Once shown, a skeleton stays at least this long. */
export const SKELETON_HOLD_MS = 100

/** Whether the skeleton shows `elapsed` ms into a load that is still running. */
export function skeletonVisible(elapsed: number, grace = SKELETON_GRACE_MS): boolean {
  return elapsed >= grace
}

/**
 * How long content that arrived `elapsed` ms into its load waits before it
 * replaces the skeleton: nothing when the skeleton never showed or has been
 * up for the hold already, otherwise the rest of the hold.
 */
export function skeletonHoldLeft(elapsed: number, grace = SKELETON_GRACE_MS, hold = SKELETON_HOLD_MS): number {
  if (!(elapsed >= grace)) return 0
  const shownFor = elapsed - grace
  return shownFor >= hold ? 0 : Math.ceil(hold - shownFor)
}
