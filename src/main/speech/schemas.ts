/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { SpeechServices } from '@shared/speech'
import type { SchemaMap } from '../schemas/types'

// Argument schemas for the speech and transcription services.
const permissionKind = z.enum(['microphone', 'speech', 'screen'])
const sessionId = z.string().uuid()

export const SPEECH_SCHEMAS: SchemaMap<SpeechServices> = {
  speech: {
    status: z.tuple([]),
    permissions: z.tuple([]),
    request: z.tuple([permissionKind]),
    openPrivacySettings: z.tuple([permissionKind]),
    screenAccess: z.tuple([]),
    requestScreen: z.tuple([]),
    relaunch: z.tuple([]),
    devices: z.tuple([]),
    locales: z.tuple([]),
    startDictation: z.tuple([]),
    stop: z.tuple([sessionId]),
    cancel: z.tuple([sessionId]),
  },
  transcription: {
    testStart: z.tuple([]),
    testStop: z.tuple([]),
    testInfo: z.tuple([]),
    testDelete: z.tuple([]),
    resetCapture: z.tuple([]),
    calendarAvailable: z.tuple([]),
    desktopCalls: z.tuple([]),
    assets: z.tuple([]),
    prepareAssets: z.tuple([]),
  },
}
