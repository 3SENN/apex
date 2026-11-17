/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { CrashNotice } from '../../../diagnostics/CrashNotice'
import { ProblemReportDialog } from '../../../diagnostics/ProblemReportDialog'
import { MODAL_POLICY, type SurfaceMap, type SurfaceModule } from '../../types'

// Diagnostics surfaces: the problem report, a whole-window modal that
// blurs the sidebar and toolbar too (OV-30), and the crash notice, a window
// card. The blur reaches the chrome through the window veil: the
// overlay host tells the chrome to blur and wash itself and swaps the
// showing pages for stills, since a backdrop-filter can't reach other views.

const problemReport: SurfaceModule<{ chatId: string | null; chatTitle: string | null; tabId: string | null; preselectCrashDumps: boolean }> = {
  component: ProblemReportDialog,
  props: z
    .object({
      chatId: z.string().regex(/^[0-9a-f-]{36}$/).nullable(),
      chatTitle: z.string().max(200).nullable(),
      tabId: z.string().min(1).max(64).nullable(),
      preselectCrashDumps: z.boolean(),
    })
    .strict(),
  policy: { ...MODAL_POLICY, veil: true },
}

const crashNotice: SurfaceModule<{ dumps: number; crashReportsOn: boolean }> = {
  component: CrashNotice,
  props: z.object({ dumps: z.number().int().min(0).max(10_000), crashReportsOn: z.boolean() }).strict(),
  policy: { ...MODAL_POLICY, size: 'fixed', blocksPage: false },
}

export const DIAGNOSTICS_SURFACE_MAP: SurfaceMap = {
  // The registry keeps modules with their props type erased; each schema checks props at open.
  'problem-report': problemReport as unknown as SurfaceModule<never>,
  'crash-notice': crashNotice as unknown as SurfaceModule<never>,
}
