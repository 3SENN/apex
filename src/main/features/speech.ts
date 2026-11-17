/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { setupSpeech, type SpeechSetup } from '../speech'
import type { Feature } from './types'

// The speech feature: the speech broker and the speech and transcription services.
let setup: SpeechSetup | null = null

export const speechFeature: Feature = {
  name: 'speech',
  app(ctx) {
    setup = setupSpeech(ctx)
    ctx.personal.broker = setup.broker
    return setup.services
  },
  dispose() {
    setup?.dispose()
    setup = null
  },
}
