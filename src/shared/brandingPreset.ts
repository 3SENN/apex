/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The branding's own companion in the app language. Its preset file
// (branding/<id>/companion.json) is written in English; where a field is the
// text the catalogues translate, the app shows the translation, and any other
// text (a fork's own companion) as the file writes it, as with About's
// trademark line. presets.json's presets are names and taglines of their own
// and stay as written.
import { BRANDING, type Branding } from './branding'
import type { CompanionPreset } from './companion'
import { t as translate, type MessageKey } from './i18n/core'
import { EN } from './i18n/en'

/** The own companion's fields the catalogues translate. */
export const OWN_PRESET_TEXT = [
  ['name', 'galleries.ownCompanion.name'],
  ['tagline', 'galleries.ownCompanion.tagline'],
  ['summary', 'galleries.ownCompanion.summary'],
] as const satisfies ReadonlyArray<readonly [keyof CompanionPreset, MessageKey]>

/** `preset` in the app language when it is the branding's own companion; every other preset as it is. */
export function localizedPreset(preset: CompanionPreset, branding: Branding = BRANDING, t: (key: MessageKey) => string = translate): CompanionPreset {
  if (!branding.ownPreset || preset.id !== branding.ownPreset.id) return preset
  let out = preset
  for (const [field, key] of OWN_PRESET_TEXT) if (preset[field] === EN[key]) out = { ...out, [field]: t(key) }
  return out
}
