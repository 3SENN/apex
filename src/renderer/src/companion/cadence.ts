/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The live companion's idle cadence (DS-135): breathing bob, snap blinks
// (sometimes doubled), a held sideways glance that shifts now and then, and
// the blinks around listening. Pure, so it is unit-tested in node; view.ts
// runs it. Times are in seconds of view time.

import type { Rng } from '@shared/companionLogic'
import type { Gaze } from '@shared/companionLogic'

export const BOB_PERIOD_S = 1.5
/** CSS pixels at the peak: inside the 0.5–1.5 px the figure should breathe. */
export const BOB_PX = 1
/** Pupils and head swing to a new target in about 180 ms, and track the pointer a few frames behind. */
export const GAZE_RATE = 16
const BLINK_MIN_S = 3
const BLINK_MAX_S = 5
const DOUBLE_CHANCE = 0.25
const DOUBLE_GAP_S = 0.4
const GLANCE_MIN_S = 4
const GLANCE_MAX_S = 8

/** Vertical breathing offset in CSS pixels; still under Reduce Motion. */
export function bobPixels(time: number, reduced: boolean): number {
  if (reduced) return 0
  return Math.sin((time / BOB_PERIOD_S) * Math.PI * 2) * BOB_PX
}

/** The next idle blinks from `time`: one, or two about 400 ms apart. */
export function idleBlinks(time: number, rng: Rng): number[] {
  const at = time + BLINK_MIN_S + rng() * (BLINK_MAX_S - BLINK_MIN_S)
  return rng() < DOUBLE_CHANCE ? [at, at + DOUBLE_GAP_S] : [at]
}

/**
 * Blinks around listening: entering it, a quick blink at once and a double
 * blink about 1.8 s later; leaving it, one blink about 2 s later.
 */
export function listenBlinks(time: number, entering: boolean): number[] {
  return entering ? [time + 0.05, time + 1.8, time + 1.8 + DOUBLE_GAP_S] : [time + 2]
}

/** A held sideways glance; the next one is on the other side more often than not. */
export function nextGlance(previous: Gaze | null, rng: Rng): { gaze: Gaze; holdFor: number } {
  const side = previous && previous.x !== 0 ? (rng() < 0.7 ? -Math.sign(previous.x) : Math.sign(previous.x)) : rng() < 0.5 ? -1 : 1
  return {
    gaze: { x: side * (0.25 + rng() * 0.2), y: rng() * 0.15 - 0.03 },
    holdFor: GLANCE_MIN_S + rng() * (GLANCE_MAX_S - GLANCE_MIN_S),
  }
}

/** How far the gaze moves toward its target this frame: eased, or at once under Reduce Motion. */
export function gazeStep(dt: number, reduced: boolean): number {
  return reduced ? 1 : 1 - Math.exp(-dt * GAZE_RATE)
}
