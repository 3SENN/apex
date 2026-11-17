/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The media hub's overlay surface (MD-01): the now-playing popover under the
// toolbar's button (or beside the sidebar card), with every source of the window.
import type { MediaHubState } from '../media'

export const MEDIA_SURFACES = ['now-playing'] as const

export type MediaSurfaceId = (typeof MEDIA_SURFACES)[number]

export interface NowPlayingSurfaceProps {
  state: MediaHubState
}

export type MediaSurfaceProps = { 'now-playing': NowPlayingSurfaceProps }
