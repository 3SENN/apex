/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The site-suggestion overlay surface: a popover in the toolbar (OV-23).
export const SITE_SUGGESTION_SURFACES = ['site-suggestion'] as const

export type SiteSuggestionSurfaceId = (typeof SITE_SUGGESTION_SURFACES)[number]

export interface SiteSuggestionSurfaceProps {
  'site-suggestion': { tabId: string; chatId: string | null }
}
