/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The activity overlay surface: the activity-memory status
// popover from the toolbar glyph (OV-24, DS-24).
export const ACTIVITY_SURFACES = ['activity-status'] as const

export type ActivitySurfaceId = (typeof ACTIVITY_SURFACES)[number]

export interface ActivitySurfaceProps {
  /** The popover loads the live status itself; it takes no props. */
  'activity-status': Record<string, never>
}
