/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DECISIONS_DEFAULTS, type DecisionsSettings } from '@shared/decisions'

/** Smoke's stand-in model (feature.ts answers offline) as a server of yours, chosen and switched on. */
export const SMOKE_SERVER: DecisionsSettings = {
  ...DECISIONS_DEFAULTS,
  on: true,
  servers: [{ id: 'server-1', name: 'Smoke server', url: 'http://127.0.0.1:9' }],
  models: [{ provider: 'server-1', model: 'kev-latest' }],
}
