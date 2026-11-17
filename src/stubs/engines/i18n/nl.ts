/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Dutch } from '../../../shared/i18n/nl/types'
import type { engines as en } from './en'

// `@internal/engines/i18n/nl` in a build from public code: empty, as in English.
export const engines = {} as const satisfies Dutch<typeof en>
