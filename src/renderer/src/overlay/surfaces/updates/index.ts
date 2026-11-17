/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { UpdatesSurfaceProps } from '@shared/overlay/updates'
import { RestartCard } from '../../../updates/RestartCard'
import { UnsupportedPrompt } from '../../../updates/UnsupportedPrompt'
import { WhatsNewCard } from '../../../updates/WhatsNewCard'
import { MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'

// The update surfaces: the what's-new card (a window card in the
// bottom-right corner that doesn't block the page), the restart card and the
// unsupported-version prompt (centred modals). Main opens them on a window's
// overlay host; each resolves with UpdatesSurfaceResults. What's new is not a
// dialog: menus and popovers open beside it, it never takes focus from what
// you are typing, and it stays until you close it.

const modal = { ...MODAL_POLICY, size: 'fixed' as const }
const version = z.string().min(1).max(32)

const whatsNew: SurfaceModule<UpdatesSurfaceProps['whats-new']> = {
  component: WhatsNewCard,
  props: z
    .object({
      entry: z
        .object({
          version,
          date: z.string().max(10),
          title: z.string().max(200),
          highlights: z.array(z.object({ title: z.string().max(200), body: z.string().max(2000) }).strict()).max(20),
        })
        .strict(),
      since: z.boolean().optional(),
    })
    .strict(),
  policy: { ...modal, layer: 'menu', blocksPage: false, focus: false },
  placement: 'corner',
  gap: 16,
}

const restart: SurfaceModule<UpdatesSurfaceProps['update-restart']> = {
  component: RestartCard,
  props: z
    .object({
      version: version.nullable(),
      running: z.object({ chats: z.number().int().min(0), routines: z.number().int().min(0), meeting: z.boolean() }).strict(),
    })
    .strict(),
  policy: modal,
  placement: 'center',
}

const unsupported: SurfaceModule<UpdatesSurfaceProps['update-unsupported']> = {
  component: UnsupportedPrompt,
  props: z.object({ below: version, message: z.string().max(500).nullable() }).strict(),
  policy: modal,
  placement: 'center',
}

export const UPDATES_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; each schema checks props at open.
  'whats-new': whatsNew as unknown as SurfaceModule<never>,
  'update-restart': restart as unknown as SurfaceModule<never>,
  'update-unsupported': unsupported as unknown as SurfaceModule<never>,
}
