/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { motionReduced, useMotion } from '../ui/motion'
import { parseDuration } from './logic/saves'

// The card's JS timing (exits, the figure's arrival) follows Atelier's one
// Reduce Motion switch (ui/motion: the OS setting or Atelier's own) and the CSS
// motion tokens, so CSS transitions and JS timers always agree.

export function lessMotion(): boolean {
  return motionReduced()
}

/** A motion token in ms, the fallback if it isn't defined, and 0 under Reduce Motion. */
export function motionMs(token: '--motion-enter' | '--motion-exit' | '--motion-glide' | '--motion-settle', fallback: number): number {
  if (motionReduced()) return 0
  return parseDuration(getComputedStyle(document.documentElement).getPropertyValue(token)) ?? fallback
}

/** True while either Reduce Motion switch is on; kept live. */
export function useLessMotion(): boolean {
  return useMotion().reduced
}
