/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { MEDIA_ARTWORK_MAX, MEDIA_RATE_MAX, MEDIA_RATE_MIN } from '@shared/media'
import type { NowPlayingSurfaceProps } from '@shared/overlay/media'
import { MENU_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { NowPlayingPopover } from './NowPlayingPopover'

// The media hub's surfaces (MD-01): the now-playing popover. It stays open
// across tab switches (its own controls may switch tabs) and closes on an
// outside click or Esc.

const source = z
  .object({
    tabId: z.string().min(1).max(64),
    title: z.string().max(2000),
    artist: z.string().max(2000),
    site: z.string().max(2000),
    favicon: z.string().max(200_000).nullable(),
    artwork: z.string().max(MEDIA_ARTWORK_MAX).nullable(),
    playing: z.boolean(),
    muted: z.boolean(),
    video: z.boolean(),
    rate: z.number().finite().min(MEDIA_RATE_MIN).max(MEDIA_RATE_MAX),
    pip: z.boolean(),
    canPip: z.boolean(),
    canPrevious: z.boolean(),
    canNext: z.boolean(),
    visible: z.boolean(),
    elsewhere: z.boolean(),
    active: z.boolean(),
  })
  .strict()

export const nowPlayingSurface: SurfaceModule<NowPlayingSurfaceProps> = {
  component: NowPlayingPopover,
  props: z.object({ state: z.object({ sources: z.array(source).max(500), cardId: z.string().max(64).nullable() }).strict() }).strict(),
  policy: { ...MENU_POLICY, onTabSwitch: 'stay' },
  placement: 'below',
  gap: 6,
}

export const MEDIA_SURFACE_MAP: SurfaceMap = {
  'now-playing': nowPlayingSurface as unknown as SurfaceModule<never>,
}
