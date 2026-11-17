/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { float as en } from '../en/float'
import type { Dutch } from './types'

// Dutch for the float.* strings: every English key, in English order.
export const float = {
  'float.error.title': 'Er ging iets mis',
  'float.error.close': 'Sluit',
} as const satisfies Dutch<typeof en>
