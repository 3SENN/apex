/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { cardPermissionBody, detectMeeting, formatElapsed, missingPermissions } from '../src/shared/meetingCapture'
import { audioOnlyFallback } from '../src/shared/meetings'
import { rowActions, statusBadge, transcribeLabel } from '../src/renderer/src/meetings/logic'

// The detection table (MV-09). Meetings match with a stable key; landing
// and home pages never do.

const MATCH: Array<[url: string, provider: string, key: string]> = [
  ['https://meet.google.com/abc-defg-hij', 'meet', 'meet:abc-defg-hij'],
  ['https://meet.google.com/abc-defg-hij?authuser=1&pli=1', 'meet', 'meet:abc-defg-hij'],
  ['https://meet.google.com/ABC-DEFG-HIJ', 'meet', 'meet:abc-defg-hij'],
  ['https://meet.google.com/lookup/team-standup', 'meet', 'meet:lookup/team-standup'],
  ['https://zoom.us/j/1234567890?pwd=abc', 'zoom', 'zoom:1234567890'],
  ['https://us02web.zoom.us/j/81234567890', 'zoom', 'zoom:81234567890'],
  ['https://app.zoom.us/wc/81234567890/join?fromPWA=1', 'zoom', 'zoom:81234567890'],
  ['https://zoom.us/wc/join/81234567890', 'zoom', 'zoom:81234567890'],
  ['https://company.zoom.us/s/81234567890', 'zoom', 'zoom:81234567890'],
  ['https://zoom.us/my/jane.doe', 'zoom', 'zoom:my/jane.doe'],
  ['https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=%7b%7d', 'teams', 'teams:19:meeting_ABC@thread.v2'],
  ['https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_XYZ@thread.v2/0', 'teams', 'teams:19:meeting_XYZ@thread.v2'],
  ['https://teams.live.com/meet/9876543210123?p=secret', 'teams', 'teams:meet/9876543210123'],
  ['https://teams.microsoft.com/meet/2345678901234?p=abc', 'teams', 'teams:meet/2345678901234'],
  ['https://acme.webex.com/meet/jdoe', 'webex', 'webex:acme.webex.com/jdoe'],
  ['https://acme.webex.com/acme/j.php?MTID=m0123456789abcdef', 'webex', 'webex:m0123456789abcdef'],
  ['https://acme.webex.com/wbxmjs/joinservice/sites/acme/meeting/download/0123456789abcdef0123456789abcdef', 'webex', 'webex:0123456789abcdef0123456789abcdef'],
  ['https://whereby.com/team-sync', 'whereby', 'whereby:whereby.com/team-sync'],
  ['https://acme.whereby.com/Design-Review', 'whereby', 'whereby:acme.whereby.com/design-review'],
  ['https://meet.jit.si/WeeklyPlanning', 'jitsi', 'jitsi:meet.jit.si/weeklyplanning'],
  ['https://8x8.vc/vpaas-magic-cookie-123/Standup', 'jitsi', 'jitsi:8x8.vc/vpaas-magic-cookie-123/standup'],
]

const NO_MATCH = [
  'https://meet.google.com/',
  'https://meet.google.com/landing',
  'https://meet.google.com/new',
  'https://meet.google.com/abc-defg',
  'http://meet.google.com/abc-defg-hij',
  'https://zoom.us/',
  'https://zoom.us/pricing',
  'https://zoom.us/j/123',
  'https://zoom.us/wc/81234567890/leave',
  'https://teams.microsoft.com/',
  'https://teams.microsoft.com/v2/',
  'https://teams.live.com/',
  'https://www.webex.com/',
  'https://acme.webex.com/acme/j.php',
  'https://whereby.com/',
  'https://whereby.com/information/pricing',
  'https://whereby.com/user',
  'https://whereby.com/login',
  'https://docs.whereby.com/room',
  'https://meet.jit.si/',
  'https://meet.jit.si/static/close.html',
  'https://meet.jit.si/external_api.js',
  'https://8x8.vc/',
  'https://example.com/meet/abc-defg-hij',
  'https://notzoom.us/j/1234567890',
  'not a url',
  'apex://meetings',
]

describe('detectMeeting', () => {
  it.each(MATCH)('matches %s', (url, provider, key) => {
    const found = detectMeeting(url)
    expect(found).toMatchObject({ provider, key })
    expect(found?.title.length).toBeGreaterThan(0)
  })

  it.each(NO_MATCH)('never matches %s', (url) => {
    expect(detectMeeting(url)).toBeNull()
  })

  it('gives the same key for the same meeting however it is opened', () => {
    expect(detectMeeting('https://us02web.zoom.us/j/81234567890')?.key).toBe(detectMeeting('https://app.zoom.us/wc/81234567890/join')?.key)
  })

  it('accepts the smoke fixture pattern only in smoke mode, on loopback', () => {
    const fixture = 'http://127.0.0.1:5123/meet/abc-defg-hij'
    expect(detectMeeting(fixture)).toBeNull()
    expect(detectMeeting(fixture, { smoke: true })).toMatchObject({ provider: 'meet', key: 'meet:abc-defg-hij' })
    expect(detectMeeting('http://localhost:5124/meet/abc-defg-hij', { smoke: true })?.provider).toBe('meet')
    expect(detectMeeting('http://example.com/meet/abc-defg-hij', { smoke: true })).toBeNull()
    expect(detectMeeting('http://127.0.0.1:5123/meet/', { smoke: true })).toBeNull()
  })
})

describe('capture helpers', () => {
  it('lists missing permissions in checklist order', () => {
    expect(missingPermissions({ microphone: 'granted', speech: 'granted', screen: 'granted' })).toEqual([])
    expect(missingPermissions({ microphone: 'not-determined', speech: 'denied', screen: 'denied' })).toEqual(['microphone', 'speech', 'screen'])
    expect(missingPermissions({ microphone: 'granted', speech: 'granted', screen: 'denied' })).toEqual(['screen'])
  })

  it('says what recording gives you without the missing permissions', () => {
    expect(cardPermissionBody({ missing: ['screen'] })).toBe('capture.card.screenOnlyBody')
    expect(cardPermissionBody({ missing: ['speech'] })).toBe('capture.card.speechOffBody')
    expect(cardPermissionBody({ missing: ['speech', 'screen'] })).toBe('capture.card.speechScreenOffBody')
  })

  it('falls back to audio only only when transcription is what failed', () => {
    expect(audioOnlyFallback('speech-denied')).toBe('speech-denied')
    expect(audioOnlyFallback('locale-unsupported')).toBe('locale-unsupported')
    for (const code of ['mic-denied', 'mic-busy', 'device-missing', 'helper-missing', 'failed'] as const) expect(audioOnlyFallback(code)).toBeNull()
  })

  it('offers an audio-only meeting Transcribe, play and export audio, and nothing that needs a transcript', () => {
    expect(rowActions({ status: 'recorded', hasAudio: true })).toEqual({ summarize: false, retranscribe: true, attach: false, exportMarkdown: false, exportAudio: true, remove: true })
    expect(rowActions({ status: 'summarized', hasAudio: true })).toMatchObject({ summarize: true, retranscribe: false, attach: true, exportMarkdown: true })
    expect(statusBadge('recorded')).toEqual({ label: 'meetings.status.audioOnly', tone: 'quiet' })
    expect(transcribeLabel('recorded')).toBe('meetings.row.transcribe')
    expect(transcribeLabel('failed')).toBe('meetings.row.retranscribe')
  })

  it('formats elapsed time as a clock', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(5_400)).toBe('0:05')
    expect(formatElapsed(754_000)).toBe('12:34')
    expect(formatElapsed(3_723_000)).toBe('1:02:03')
    expect(formatElapsed(-50)).toBe('0:00')
  })
})
