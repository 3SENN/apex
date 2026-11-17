/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The interface's own size and density settings as DOM attributes and CSS
// variables (ST-26, ST-27). Pure, so the ranges are unit-tested;
// ui/appearance.ts puts them on <html>.

export interface InterfaceSettings {
  density: 'comfortable' | 'compact'
  fontSize: number
  sidebarTint: boolean
  chatZoom: number
}

export const FONT_SIZE = { min: 12, max: 16, default: 13 } as const
export const CHAT_ZOOM = { min: 0.3, max: 2 } as const

const clamp = (n: number, min: number, max: number, fallback: number): number => (Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback)

/** The type ramp for an interface text size: every step moves with the base (13 is Apex's default). */
export function typeScale(fontSize: number): Record<string, string> {
  const delta = Math.round(clamp(fontSize, FONT_SIZE.min, FONT_SIZE.max, FONT_SIZE.default)) - FONT_SIZE.default
  return {
    '--text-xs': `${11 + delta}px`,
    '--text-sm': `${12 + delta}px`,
    '--text-md': `${13 + delta}px`,
    '--text-lg': `${15 + delta}px`,
    '--text-xl': `${18 + delta}px`,
  }
}

export function interfaceTokens(s: InterfaceSettings): { attributes: Record<string, string>; variables: Record<string, string> } {
  return {
    attributes: {
      density: s.density === 'compact' ? 'compact' : 'comfortable',
      sidebarTint: s.sidebarTint ? 'on' : 'off',
    },
    variables: {
      ...typeScale(s.fontSize),
      '--chat-zoom': String(clamp(s.chatZoom, CHAT_ZOOM.min, CHAT_ZOOM.max, 1)),
    },
  }
}

/** The interface zoom choices (30 to 100%) and chat text zoom choices (30 to 200%), for the selects. */
export const UI_ZOOM_CHOICES = [0.3, 0.5, 0.67, 0.75, 0.8, 0.9, 1] as const
export const CHAT_ZOOM_CHOICES = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const

/** The nearest listed choice, so a value set by ⌘+ and ⌘− still shows in the select. */
export function nearestChoice(value: number, choices: readonly number[]): number {
  let best = choices[0] ?? 1
  for (const c of choices) if (Math.abs(c - value) < Math.abs(best - value)) best = c
  return best
}

export const percent = (value: number): string => `${Math.round(value * 100)}%`
