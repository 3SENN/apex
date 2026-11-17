/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { setupAutofill, type AutofillSetup } from '../autofill'
import type { Feature } from './types'

// The capture masker, the per-tab autofill controller and the autofill service.
let setup: AutofillSetup | null = null

export const autofillFeature: Feature = {
  name: 'autofill',
  app(ctx) {
    setup = setupAutofill(ctx, { vault: ctx.personal.vault, wallet: ctx.personal.wallet, auth: ctx.personal.auth })
    ctx.personal.masker = setup.masker
    return setup.services
  },
  window(win) {
    setup?.window(win)
  },
  tab(tab, win) {
    return setup?.tab(tab, win)
  },
  dispose() {
    setup?.dispose()
    setup = null
  },
}
