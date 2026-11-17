/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure choices for the welcome flow (DS-78): where the one companion stands
// on each step, how it is framed, and the timing of the opening "dawn".

import type { CompanionFraming } from '../companion/layout'

export interface WelcomePlacement {
  /** 'center' above the step, 'side' beside it, 'corner' small at the top left. */
  where: 'center' | 'side' | 'corner'
  framing: Exclude<CompanionFraming, 'auto' | 'face'>
  /** Of the figure's full size; the figure glides and scales instead of remounting. */
  scale: number
}

const PLACEMENTS: readonly WelcomePlacement[] = [
  { where: 'center', framing: 'full', scale: 0.92 },
  { where: 'side', framing: 'full', scale: 1 },
  { where: 'center', framing: 'bust', scale: 0.62 },
  { where: 'corner', framing: 'bust', scale: 0.46 },
  { where: 'center', framing: 'full', scale: 0.78 },
]

export function welcomePlacement(step: number): WelcomePlacement {
  const index = Math.max(0, Math.min(PLACEMENTS.length - 1, Math.floor(Number.isFinite(step) ? step : 0)))
  return PLACEMENTS[index] as WelcomePlacement
}

export interface WelcomeIntro {
  /** 'mark': the glow rises and the Atelier logo (Pip's head) pops in; 'rise': the companion pops up and waves; 'done'. */
  phase: 'mark' | 'rise' | 'done'
  /** When the companion starts to rise. */
  markMs: number
  /** When the steps appear. */
  totalMs: number
}

/** The dawn, or straight to the first step under Reduce Motion. */
export function welcomeIntro(reduced: boolean): WelcomeIntro {
  return reduced ? { phase: 'done', markMs: 0, totalMs: 0 } : { phase: 'mark', markMs: 1100, totalMs: 1900 }
}
