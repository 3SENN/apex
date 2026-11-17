/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'
import { PasteSurface } from './PasteSurface'

// The composer surfaces (the add-context menu, mentions, # records, the paste preview).
// The paste preview is a window modal, so it draws in the overlay layer and
// covers the page too. The + menu, the @ list and the # list open from the
// composer and stay inside its column, so they draw in the chrome's own
// renderer (DS-94: a menu that fits inside its renderer draws there); their
// ids stay reserved for a layout where they would cross a page.

const uuid = z.string().regex(/^[0-9a-f-]{36}$/)

const pastePreview: SurfaceModule<{ chatId: string; attachmentId: string }> = {
  component: PasteSurface,
  props: z.object({ chatId: uuid, attachmentId: z.string().uuid() }).strict(),
  policy: { ...MODAL_POLICY, size: 'fill-window' },
}

export const COMPOSER_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; each schema checks props at open.
  'paste-preview': pastePreview as unknown as SurfaceModule<never>,
}
