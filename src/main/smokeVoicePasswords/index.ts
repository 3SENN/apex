/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SmokeGroup, ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import { assert } from '../smokeKit'
import * as autofill from './autofill'
import * as meetingCapture from './meetingCapture'
import * as meetings from './meetings'
import * as passwords from './passwords'
import * as speech from './speech'
import * as voice from './voice'
import { crossSiteFixtures } from './fixtures'

// The voice and passwords smoke group's checks and screenshot specs: speech,
// passwords, autofill, meetings, meeting capture and voice
// (APEX_SMOKE_ONLY=VOICE-PASSWORDS runs only these). Under APEX_SMOKE the
// speech helper is the fake one, the authenticator says 'ok', the global
// launcher shortcut is never registered and the meeting card waits 300 ms.

// The group's own check: every speech, passwords, meetings and voice service answers through the chrome's
// validated channel, and the second fixture origin is up for cross-site frames.
const contracts: SmokeCheck = {
  name: 'services answer',
  async run(ctx: SmokeContext) {
    const status = await ctx.chrome.invoke<{ available: boolean }>('speech', 'status')
    assert(typeof status.available === 'boolean', 'speech.status answered')
    const vault = await ctx.chrome.invoke<{ locked: boolean }>('passwords', 'status')
    assert(typeof vault.locked === 'boolean', 'passwords.status answered')
    const capture = await ctx.chrome.invoke<{ state: string }>('meetingCapture', 'status')
    assert(typeof capture.state === 'string', 'meetingCapture.status answered')
    const voiceStatus = await ctx.chrome.invoke<{ state: string }>('voice', 'status')
    assert(typeof voiceStatus.state === 'string', 'voice.status answered')
    assert(Array.isArray(await ctx.chrome.invoke('meetings', 'list')), 'meetings.list answered')
    const fixtures = await crossSiteFixtures(ctx.server)
    assert(fixtures.second.startsWith('http://localhost:'), 'the second fixture origin is up')
  },
}

// In order: speech, passwords, autofill, meetings, meetingCapture, voice.
const PARTS = [speech, passwords, autofill, meetings, meetingCapture, voice]

export const checks: SmokeCheck[] = [contracts, ...PARTS.flatMap((l) => l.checks)]
export const shots: ShotSpec[] = PARTS.flatMap((l) => l.shots)

export const voicePasswordsSmoke: SmokeGroup = { group: 'VOICE-PASSWORDS', checks, shots }
