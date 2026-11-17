/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { setupVoice, type VoiceSetup } from '../voice'
import type { Feature } from './types'

// Hold-to-talk, the HUD and the launcher. It fills no
// runtime slot, and reads the others through getters so it always uses the
// filled ones.
let setup: VoiceSetup | null = null

export const voiceFeature: Feature = {
  name: 'voice',
  app(ctx) {
    setup = setupVoice(ctx, { broker: () => ctx.personal.broker, masker: () => ctx.personal.masker, recorder: () => ctx.personal.recorder })
    return setup.services
  },
  dispose() {
    setup?.dispose()
    setup = null
  },
}
