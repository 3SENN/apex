/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SURFACE_IDS, isSurfaceId, type SurfaceId } from '@shared/overlay'
import { ADDRESS_SURFACE_MAP } from './surfaces/address'
import { CHAT_SURFACE_MAP } from './surfaces/chat'
import { CORE_SURFACE_MAP } from './surfaces/core'
import { MENUS_SURFACE_MAP } from './surfaces/menus'
import { SETTINGS_SURFACE_MAP } from './surfaces/settings'
import { SITES_SURFACE_MAP } from './surfaces/sites'
import { TABS_SURFACE_MAP } from './surfaces/tabs'
import type { SurfaceMap, SurfaceModule } from './types'
import { AUTOFILL_SURFACE_MAP } from './surfaces/autofill'
import { COMPOSER_SURFACE_MAP } from './surfaces/composer'
import { CONNECTORS_SURFACE_MAP } from './surfaces/connectors'
import { EXTENSIONS_SURFACE_MAP } from './surfaces/extensions'
import { FILES_SURFACE_MAP } from './surfaces/files'
import { PROFILES_SURFACE_MAP } from './surfaces/profiles'
import { ACTIVITY_SURFACE_MAP } from './surfaces/activity'
import { CHAT_POPOVER_SURFACE_MAP } from './surfaces/chat-popover'
import { SITE_SUGGESTION_SURFACE_MAP } from './surfaces/site-suggestions'
import { WORKSPACE_SURFACE_MAP } from './surfaces/workspace'
import { DIAGNOSTICS_SURFACE_MAP } from './surfaces/diagnostics'
import { SYSTEM_SURFACE_MAP } from './surfaces/system'
import { UPDATES_SURFACE_MAP } from './surfaces/updates'
// ── media hub surface map ── (MD-01)
import { MEDIA_SURFACE_MAP } from './surfaces/media'
// ── translate surface map ── (TR-11)
import { TRANSLATE_SURFACE_MAP } from './surfaces/translate'
// ── packs surface map ── (atelier.server's bar)
import { PACKS_SURFACE_MAP } from './surfaces/packs'

// Every domain's surface map, merged. An id that two maps
// claim is a build error caught by tests; an unknown id is rejected.
export const SURFACE_MAPS: readonly SurfaceMap[] = [
  CORE_SURFACE_MAP,
  ADDRESS_SURFACE_MAP,
  TABS_SURFACE_MAP,
  SITES_SURFACE_MAP,
  MENUS_SURFACE_MAP,
  CHAT_SURFACE_MAP,
  SETTINGS_SURFACE_MAP,
  AUTOFILL_SURFACE_MAP,
  COMPOSER_SURFACE_MAP,
  FILES_SURFACE_MAP,
  EXTENSIONS_SURFACE_MAP,
  CONNECTORS_SURFACE_MAP,
  PROFILES_SURFACE_MAP,
  CHAT_POPOVER_SURFACE_MAP,
  ACTIVITY_SURFACE_MAP,
  SITE_SUGGESTION_SURFACE_MAP,
  WORKSPACE_SURFACE_MAP,
  DIAGNOSTICS_SURFACE_MAP,
  UPDATES_SURFACE_MAP,
  SYSTEM_SURFACE_MAP,
  // ── media hub surface map list ──
  MEDIA_SURFACE_MAP,
  // ── translate surface map list ──
  TRANSLATE_SURFACE_MAP,
  // ── packs surface map list ──
  PACKS_SURFACE_MAP,
]

const registry = new Map<SurfaceId, SurfaceModule<never>>()
for (const map of SURFACE_MAPS) {
  for (const [id, module] of Object.entries(map)) {
    if (!isSurfaceId(id) || !module) continue
    registry.set(id, module)
  }
}

export function surfaceModule(id: string): SurfaceModule<never> | null {
  return isSurfaceId(id) ? (registry.get(id) ?? null) : null
}

/** Ids in SURFACE_IDS that no map implements (they fall back to the chrome's own paths). */
export function unimplementedSurfaces(): SurfaceId[] {
  return SURFACE_IDS.filter((id) => !registry.has(id))
}
