/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { setupMeetingsLibrary, type MeetingsLibrarySetup } from '../meetings'
import type { Feature } from './types'

// The meetings library feature: the meetings store, summarizer and resolver, and the meetings service.
let setup: MeetingsLibrarySetup | null = null

export const meetingsLibraryFeature: Feature = {
  name: 'meetingsLibrary',
  app(ctx) {
    setup = setupMeetingsLibrary(ctx, { broker: ctx.personal.broker })
    ctx.personal.meetings = { store: setup.store, summarizer: setup.summarizer, resolver: setup.resolver }
    return setup.services
  },
  dispose() {
    setup?.dispose()
    setup = null
  },
}
