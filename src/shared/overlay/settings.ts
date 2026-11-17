/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings overlay surfaces: the clear-browsing-data dialog (⇧⌘⌫).
import type { ClearRange } from '../services/settings'

export const SETTINGS_SURFACES = ['clear-data'] as const

export type SettingsSurfaceId = (typeof SETTINGS_SURFACES)[number]

export type SettingsSurfaceProps = {
  /** The range to start on; the dialog remembers nothing between openings. */
  'clear-data': { range?: ClearRange }
}
