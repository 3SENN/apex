/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import { FILE_KINDS, type DownloadFlightProps, type FileKind } from '@shared/downloads'
import { HINT_POLICY, type SurfaceModule } from '../../../types'
import { DownloadFlight } from './DownloadFlight'

// The `download-flight` cue module (passive tier). It covers the
// window, takes no clicks and closes itself when the flight ends.

const coordinate = z.number().finite().min(-100_000).max(100_000)
const point = z.object({ x: coordinate, y: coordinate }).strict()

export const downloadFlightSurface: SurfaceModule<DownloadFlightProps> = {
  component: DownloadFlight,
  props: z.object({ from: point, to: point, kind: z.enum(FILE_KINDS as [FileKind, ...FileKind[]]) }).strict(),
  policy: { ...HINT_POLICY, size: 'fill-window', onTabSwitch: 'stay', exitMs: 0 },
}
