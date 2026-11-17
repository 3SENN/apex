/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { UpdateRestartRunning, WhatsNewEntry } from '../updates'

// The update overlay surfaces: the what's-new card, the restart card
// and the unsupported-version prompt.
export const UPDATES_SURFACES = ['whats-new', 'update-restart', 'update-unsupported'] as const

export type UpdatesSurfaceId = (typeof UPDATES_SURFACES)[number]

export interface UpdatesSurfaceProps {
  /** `since` is true when the entry combines several versions since the last one seen. */
  'whats-new': { entry: WhatsNewEntry; since?: boolean }
  'update-restart': { version: string | null; running: UpdateRestartRunning }
  'update-unsupported': { below: string; message: string | null }
}

/** What each card resolves with; Esc and a click outside dismiss without a value. */
export interface UpdatesSurfaceResults {
  'whats-new': 'done'
  'update-restart': 'now' | 'when-idle'
  'update-unsupported': 'update' | 'later'
}
