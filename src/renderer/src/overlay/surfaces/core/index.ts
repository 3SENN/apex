/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { CoreSurfaceProps } from '@shared/overlay/core'
import { HINT_POLICY, MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { FullscreenNotice } from './FullscreenNotice'
import { ShortcutsSheet } from './ShortcutsSheet'
import { TooltipSurface } from './TooltipSurface'
import './core.css'

// The core surfaces (tooltip, fullscreen notice, shortcuts sheet, cover).

const tooltip: SurfaceModule<CoreSurfaceProps['tooltip']> = {
  component: TooltipSurface,
  props: z.object({ label: z.string().min(1).max(200), shortcutId: z.string().max(64).nullable().optional(), side: z.enum(['top', 'bottom', 'left', 'right']).optional() }).strict(),
  // Passive, so it never catches a click; any tab switch or press hides it.
  policy: { ...HINT_POLICY, onTabSwitch: 'close' },
  placement: (p) => (p.side === 'top' ? 'above' : p.side === 'left' ? 'left' : p.side === 'right' ? 'right' : 'below'),
  gap: 7,
}

const fullscreenNotice: SurfaceModule<CoreSurfaceProps['fullscreen-notice']> = {
  component: FullscreenNotice,
  props: z.object({ host: z.string().max(253).nullable() }).strict(),
  // It fades out (OV-13), unlike other hints.
  policy: { ...HINT_POLICY, onTabSwitch: 'close', exitMs: 240 },
  placement: 'top-center',
  gap: 16,
}

const shortcutsSheet: SurfaceModule<CoreSurfaceProps['shortcuts-sheet']> = {
  component: ShortcutsSheet,
  props: z
    .object({
      platform: z.string().max(32),
      runtime: z.array(z.object({ id: z.string().max(128), title: z.string().max(200), accelerator: z.string().max(64), owner: z.string().max(128) }).strict()).max(500).optional(),
    })
    .strict(),
  policy: { ...MODAL_POLICY, onTabSwitch: 'stay' },
}

// The legacy holdOverlay shim: draws nothing and takes no room; main hides the page views while it is open.
const cover: SurfaceModule<CoreSurfaceProps['cover']> = {
  component: () => null,
  props: z.object({}).strict(),
  policy: { tier: 'interactive', size: 'fixed', outsideClick: 'ignore', blocksPage: true, onTabSwitch: 'stay', layer: 'hint', focus: false, exitMs: 0 },
}

export const CORE_SURFACE_MAP: SurfaceMap = {
  tooltip: tooltip as unknown as SurfaceModule<never>,
  'fullscreen-notice': fullscreenNotice as unknown as SurfaceModule<never>,
  'shortcuts-sheet': shortcutsSheet as unknown as SurfaceModule<never>,
  cover: cover as unknown as SurfaceModule<never>,
}
