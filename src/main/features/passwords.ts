/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { setupPasswords, type PasswordsSetup } from '../passwords'
import type { Feature } from './types'

// The vault, wallet and authenticator, and the passwords and wallet services.
let setup: PasswordsSetup | null = null

export const passwordsFeature: Feature = {
  name: 'passwords',
  app(ctx) {
    setup = setupPasswords(ctx, { broker: ctx.personal.broker })
    ctx.personal.vault = setup.vault
    ctx.personal.wallet = setup.wallet
    ctx.personal.auth = setup.auth
    return setup.services
  },
  dispose() {
    setup?.dispose()
    setup = null
  },
}
