/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { setupMeetingCapture, type MeetingCaptureSetup } from '../meetings/capture'
import type { Feature } from './types'

// The meeting capture feature: meeting detection, the meeting card, the recorder and the widget.
let setup: MeetingCaptureSetup | null = null

export const meetingCaptureFeature: Feature = {
  name: 'meetingCapture',
  app(ctx) {
    setup = setupMeetingCapture(ctx, { broker: ctx.personal.broker, store: ctx.personal.meetings.store, summarizer: ctx.personal.meetings.summarizer })
    ctx.personal.recorder = setup.recorder
    return setup.services
  },
  // Navigations raise the card (MV-09); tab switches and focus decide the widget (MV-10).
  window(win) {
    setup?.attachWindow(win)
  },
  dispose() {
    setup?.dispose()
    setup = null
  },
}
