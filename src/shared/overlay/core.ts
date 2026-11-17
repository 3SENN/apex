/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The core overlay surfaces. `cover` is the legacy holdOverlay shim; it
// goes once every caller has migrated.
export const CORE_SURFACES = ['tooltip', 'fullscreen-notice', 'shortcuts-sheet', 'cover'] as const

export type CoreSurfaceId = (typeof CORE_SURFACES)[number]

export interface CoreSurfaceProps {
  tooltip: { label: string; shortcutId?: string | null; side?: 'top' | 'bottom' | 'left' | 'right' }
  /** `host` is null when the page has no host to name ("this page"). */
  'fullscreen-notice': { host: string | null }
  /** `runtime` lists shortcuts registered at run time (extension commands), shown under their owner. */
  'shortcuts-sheet': { platform: string; runtime?: { id: string; title: string; accelerator: string; owner: string }[] }
  cover: Record<string, never>
}
