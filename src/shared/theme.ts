/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The theme contract between main, the preloads and the chrome. Main owns the
// choice (nativeTheme.themeSource) and resolves the mode and accent; the
// chrome only applies them, before React renders and live afterwards.

export type ThemePreference = 'system' | 'light' | 'dark'
export type ThemeMode = 'light' | 'dark'

/** Atelier's own named accent hues, offered next to "follow the companion". */
export const ACCENT_HUES = [
  { id: 'lavender', label: 'Lavender', color: '#6a4bff' },
  { id: 'ocean', label: 'Ocean', color: '#2f6bff' },
  { id: 'lagoon', label: 'Lagoon', color: '#0f9fa8' },
  { id: 'fern', label: 'Fern', color: '#2e9b5a' },
  { id: 'honey', label: 'Honey', color: '#d9890f' },
  { id: 'ember', label: 'Ember', color: '#ef5a43' },
  { id: 'blossom', label: 'Blossom', color: '#e2468f' },
  { id: 'slate', label: 'Slate', color: '#5b5f73' },
] as const

export type AccentHue = (typeof ACCENT_HUES)[number]['id']
/** `pack:<packId>/<themeId>`: an accent an installed pack adds (docs/packs.md). */
export type PackAccentChoice = `pack:${string}`
export type AccentChoice = 'companion' | AccentHue | PackAccentChoice
export const ACCENT_CHOICES = ['companion', ...ACCENT_HUES.map((h) => h.id)] as ['companion' | AccentHue, ...Array<'companion' | AccentHue>]
export const PACK_ACCENT_PATTERN = /^pack:[a-z0-9][a-z0-9-]{1,31}\/[a-z0-9][a-z0-9-]{0,31}$/

export function packAccentChoice(packId: string, themeId: string): PackAccentChoice {
  return `pack:${packId}/${themeId}`
}

// Accents from enabled packs, set by main's packs runtime; a choice whose pack is off follows the companion.
let packAccents = new Map<string, string>()

export function setPackAccents(entries: Iterable<[PackAccentChoice, string]>): void {
  packAccents = new Map(entries)
}

export interface ThemeState {
  preference: ThemePreference
  /** What the preference resolves to right now. */
  mode: ThemeMode
  accentChoice: AccentChoice
  /** The resolved accent colour ('#rrggbb'): the active companion's or a named hue. */
  accent: string
}

/**
 * The native window background before the chrome paints and while resizing.
 * Mirrors the default ground (--profile-ground, Stone) in styles.css so
 * nothing flashes between the two.
 */
export const CHROME_BACKGROUND: Record<ThemeMode, string> = { light: '#eeece8', dark: '#302d2a' }

export function resolveAccent(choice: AccentChoice, companionAccent: string): string {
  if (choice === 'companion') return companionAccent
  if (choice.startsWith('pack:')) return packAccents.get(choice) ?? companionAccent
  return ACCENT_HUES.find((h) => h.id === choice)?.color ?? companionAccent
}
