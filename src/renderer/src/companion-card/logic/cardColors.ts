/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_LOOK, type CompanionLook } from '@shared/companion'
import { contrastRatio, MIN_CONTRAST } from '@shared/accent'
import { darkenHex, hexToRgb, isHexColor } from '@shared/companionLogic'

// The few companion colours the card uses (docs/design-spec.md, colour
// roles): the hero wash is the head colour, and the primary pill is the
// look's deepest colour, darkened until a white label reads on it. Everything
// else in the card is neutral and comes from the design tokens.

/** The colour the hero wash and the field are tinted with: the head (skin). */
export function heroTint(look: CompanionLook): string {
  return look.colors.skin
}

export interface PillColors {
  rest: string
  hover: string
  press: string
  /** The label: always white, which is what the fill is darkened against. */
  text: string
}

const WHITE = '#ffffff'

/** WCAG relative luminance, to pick the deeper of two colours. */
function luminance(hex: string): number {
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/**
 * The darker of outfit and hair, darkened in small steps until white text on
 * it passes 4.5:1; hover and press each go a step darker still.
 */
export function primaryPillColors(look: CompanionLook): PillColors {
  const candidates = [look.colors.outfit, look.colors.hair].filter(isHexColor)
  let rest = candidates.length ? candidates.reduce((a, b) => (luminance(b) < luminance(a) ? b : a)) : DEFAULT_LOOK.colors.hair
  for (let i = 0; i < 24 && contrastRatio(WHITE, rest) < MIN_CONTRAST; i++) rest = darkenHex(rest, 0.92)
  return { rest, hover: darkenHex(rest, 0.9), press: darkenHex(rest, 0.8), text: WHITE }
}
