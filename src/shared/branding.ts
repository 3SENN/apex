/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The branding this build was made with: official Apex, or the unofficial
// Summit every build from source gets unless official branding is switched on
// (TRADEMARKS.md; scripts/branding.mjs decides it, from branding/<id>/branding.json).
// The build sets __APEX_BRANDING__; code reads the names through BRANDING, and
// user-facing text through the catalogues' {brand} placeholder, which t()
// fills in from here.
//
// Without the define (a tool that bundles shared code on its own), it is the
// unofficial branding: nothing claims the Apex marks unless a build asks for them.
import type { CompanionPreset } from './companion'

declare const __APEX_BRANDING__: unknown

export type BrandingId = 'official' | 'unofficial'

export interface Branding {
  id: BrandingId
  /** Whether this is the official Apex branding. */
  official: boolean
  /** The product name: the app, its bundle and its profile folder. */
  name: string
  /** The name in running text, as Firefox's -brand-short-name ({brand} in the catalogues). */
  shortName: string
  /** The app id (APEX_BUNDLE_ID can still replace it; src/shared/release.ts). */
  bundleId: string
  /** The copyright line, as Brave's "Copyright © … The Brave Authors" (Settings › About). */
  copyright: string
  /** Firefox's trademarkInfo: the trademark line About shows, with {brand} for the name; '' for a branding that claims no marks. */
  trademarkInfo: string
  /** The first-run and fallback companion: a preset's id, name and look (a CompanionLook). */
  companion: { id: string; name: string; look: unknown }
  /**
   * The branding's own default companion as a whole preset (branding/<id>/companion.json), offered
   * before presets.json's: the unofficial branding's neutral companion. Null when the default is one of presets.json's.
   */
  ownPreset: CompanionPreset | null
  /** Presets from presets.json this branding doesn't offer (the unofficial branding leaves out all six of Apex's characters). */
  hiddenPresets: readonly string[]
  /** Whether the logo is a drawn wordmark (branding/<id>/renderer/logo.svg); else the name beside the mark. */
  wordmark: boolean
}

const UNOFFICIAL: Branding = {
  id: 'unofficial',
  official: false,
  name: 'Summit',
  shortName: 'Summit',
  bundleId: 'dev.summit.browser',
  copyright: 'Copyright © 2026 The Apex Authors',
  trademarkInfo: '',
  companion: { id: 'companion', name: 'Companion', look: null },
  ownPreset: null,
  hiddenPresets: ['pip', 'juniper', 'bolt', 'mochi', 'sage', 'pepper'],
  wordmark: false,
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isName = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= 40

/** The define's own preset when it has a preset's shape (main checks it fully before offering it); else null. */
function ownPresetFrom(raw: unknown, companionId: string): CompanionPreset | null {
  if (!isObject(raw) || raw.id !== companionId || !isName(raw.name) || typeof raw.tagline !== 'string' || typeof raw.personality !== 'string' || !isObject(raw.look)) return null
  return {
    id: raw.id,
    name: raw.name,
    tagline: raw.tagline,
    personality: raw.personality,
    look: raw.look as unknown as CompanionPreset['look'],
    ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
    ...(Array.isArray(raw.starterSkills) ? { starterSkills: raw.starterSkills as CompanionPreset['starterSkills'] } : {}),
    ...(Array.isArray(raw.starterRoutines) ? { starterRoutines: raw.starterRoutines as CompanionPreset['starterRoutines'] } : {}),
    ...(typeof raw.version === 'string' ? { version: raw.version } : {}),
  }
}

/** Reads the define's value; anything malformed falls back to the unofficial branding. Exported for tests. */
export function brandingFrom(raw: unknown): Branding {
  if (!isObject(raw) || (raw.id !== 'official' && raw.id !== 'unofficial') || !isName(raw.name) || !isName(raw.shortName)) return UNOFFICIAL
  const companion = isObject(raw.companion) && typeof raw.companion.id === 'string' && isName(raw.companion.name) ? { id: raw.companion.id, name: raw.companion.name, look: raw.companion.look ?? null } : UNOFFICIAL.companion
  return {
    id: raw.id,
    official: raw.id === 'official',
    name: raw.name,
    shortName: raw.shortName,
    bundleId: typeof raw.bundleId === 'string' && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(raw.bundleId) ? raw.bundleId : UNOFFICIAL.bundleId,
    copyright: typeof raw.copyright === 'string' && raw.copyright.trim() !== '' ? raw.copyright.trim() : UNOFFICIAL.copyright,
    // A malformed or missing line claims nothing.
    trademarkInfo: typeof raw.trademarkInfo === 'string' ? raw.trademarkInfo.trim() : '',
    companion,
    ownPreset: ownPresetFrom(raw.ownPreset, companion.id),
    hiddenPresets: Array.isArray(raw.hiddenPresets) ? raw.hiddenPresets.filter((id): id is string => typeof id === 'string') : UNOFFICIAL.hiddenPresets,
    wordmark: raw.wordmark === true,
  }
}

export const BRANDING: Branding = brandingFrom(typeof __APEX_BRANDING__ === 'object' ? __APEX_BRANDING__ : undefined)

/** The app's name in running text ({brand} in the catalogues). */
export const BRAND_NAME: string = BRANDING.shortName

/** Text shipped as files (help notes, guides, built-in skills) with its {brand} placeholders filled in. */
export function withBrand(text: string): string {
  return text.split('{brand}').join(BRAND_NAME)
}

/** Whether this branding offers the preset `id` (the gallery, first run and the guides). */
export function presetOffered(id: string, branding: Branding = BRANDING): boolean {
  return !branding.hiddenPresets.includes(id)
}

/**
 * The presets this branding offers: its own companion first when it has one,
 * then presets.json's in their order, less the ones it leaves out. The
 * unofficial branding offers its own neutral companion and none of Apex's six.
 */
export function offeredPresets(presets: readonly CompanionPreset[], branding: Branding = BRANDING): CompanionPreset[] {
  const own = branding.ownPreset
  const rest = presets.filter((p) => presetOffered(p.id, branding) && p.id !== own?.id)
  return own ? [own, ...rest] : rest
}
