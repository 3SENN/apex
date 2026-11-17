/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The profile hue: Atelier's own set of colours for the chrome's ground (the
// sidebar tint), the footer's avatar ring and its capsule. It belongs to the
// person, not the companion, so switching companion never recolours the chrome.
import { contrastRatio, parseHex, toHex } from './accent'

export const PROFILE_HUES = [
  { id: 'stone', label: 'Stone', base: '#8c8378' },
  { id: 'fig', label: 'Fig', base: '#8e5f6c' },
  { id: 'moss', label: 'Moss', base: '#6a7c4c' },
  { id: 'tide', label: 'Tide', base: '#3c7d8e' },
  { id: 'clay', label: 'Clay', base: '#b06a4b' },
  { id: 'dusk', label: 'Dusk', base: '#5d68a3' },
  { id: 'plum', label: 'Plum', base: '#7c4f92' },
  { id: 'sun', label: 'Sun', base: '#c4972b' },
  { id: 'peony', label: 'Peony', base: '#c45b87' },
] as const

export type ProfileHue = (typeof PROFILE_HUES)[number]['id']
export const PROFILE_HUE_IDS = PROFILE_HUES.map((h) => h.id) as [ProfileHue, ...ProfileHue[]]
export const DEFAULT_PROFILE_HUE: ProfileHue = 'stone'

/**
 * The neutral grounds every hue is washed into: a warm pale grey, and in dark
 * mode a warm slate a step lighter than the sheet, so the planes swap order
 * and the sheet is the darkest plane (design-spec "Dark").
 */
export const GROUND = { light: '#eeece8', dark: '#302d2a' } as const
/** How much of the hue reaches the ground. Stone stays the plain ground. */
const GROUND_WASH = { light: 0.11, dark: 0.12 } as const
const WHITE = '#ffffff'
/** White semibold text on the capsule must stay readable (WCAG AA). */
export const CAPSULE_CONTRAST = 4.5

export interface ProfileTokens {
  /** The sidebar's flat tint (the window's ground). */
  ground: string
  /** The capsule fill and the avatar ring; white text reads on it. */
  hue: string
  /** The hue as text and rings on the card surfaces (links, focus, the selected settings row): 4.5:1 in either mode. */
  text: string
}

type Rgb = [number, number, number]

function mixHex(color: string, base: string, amount: number): string {
  const c = parseHex(color) ?? [0, 0, 0]
  const b = parseHex(base) ?? [0, 0, 0]
  return toHex([0, 1, 2].map((i) => b[i]! + (c[i]! - b[i]!) * amount) as Rgb)
}

/** Darkens toward black in small steps until white text reaches the contrast floor. */
function readableOnWhite(color: string): string {
  let out = color
  for (let step = 0; step < 40 && contrastRatio(WHITE, out) < CAPSULE_CONTRAST; step++) out = mixHex('#000000', out, 0.04)
  return out
}

/** The lightest card surface in each mode (--bg-raised); text that reads there reads on the rest. */
const TEXT_SURFACE = { light: '#ffffff', dark: '#2b2a28' } as const

/** Moves toward ink (light mode) or paper (dark mode) until the text reaches the contrast floor. */
function readableText(color: string, mode: 'light' | 'dark'): string {
  const toward = mode === 'light' ? '#000000' : '#ffffff'
  let out = color
  for (let step = 0; step < 50 && contrastRatio(out, TEXT_SURFACE[mode]) < CAPSULE_CONTRAST; step++) out = mixHex(toward, out, 0.05)
  return out
}

export function isProfileHue(value: unknown): value is ProfileHue {
  return typeof value === 'string' && (PROFILE_HUE_IDS as readonly string[]).includes(value)
}

/** The ground and capsule colours of a hue, for one mode. */
export function profileTokens(hue: ProfileHue, mode: 'light' | 'dark'): ProfileTokens {
  const base = PROFILE_HUES.find((h) => h.id === hue)?.base ?? PROFILE_HUES[0].base
  const ground = hue === 'stone' ? GROUND[mode] : mixHex(base, GROUND[mode], GROUND_WASH[mode])
  // Dark mode lifts the capsule a little so it reads on the charcoal, then checks the text again.
  const lifted = mode === 'dark' ? mixHex('#ffffff', base, 0.08) : base
  return { ground, hue: readableOnWhite(lifted), text: readableText(base, mode) }
}

/** CSS custom properties for both modes; styles.css picks one per mode with light-dark(). */
export function profileVariables(hue: ProfileHue): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const mode of ['light', 'dark'] as const) {
    const t = profileTokens(hue, mode)
    vars[`--profile-ground-${mode}`] = t.ground
    vars[`--profile-hue-${mode}`] = t.hue
    vars[`--profile-text-${mode}`] = t.text
  }
  return vars
}
