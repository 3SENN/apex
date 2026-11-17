/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { attributeCalls, bundleMatches, watchedBundles, type CallAudioProcess, type CallRunningApp, type CallsSnapshot } from '../src/shared/desktopCalls'
import type { CalendarEvent, CardPayload } from '../src/shared/meetingCapture'
import type { HelperCommand, HelperLine, TranscriptionSettings } from '../src/shared/speech'
import { appCardFor, appMutePatch, callKey, cardAllowed, mutePatch, type CardSettings } from '../src/main/meetings/capture/cards'
import { CallTracker, DesktopCallWatcher, calendarEventForCall, callTitle, type CallTiming, type DesktopCall } from '../src/main/meetings/capture/desktopCalls'
import { createSpeechBroker } from '../src/main/speech/broker'
import { createFakeSpeechHelper } from '../src/main/speech/fake'
import { HelperLink } from '../src/main/speech/helper'
import { parseHelperLine } from '../src/main/speech/protocol'

// Calls in desktop apps: the snapshot's attribution,
// the start and end rules (mic flaps, mutes, quitting), one offer per call,
// Apex's own microphone never counting, the calendar name, the card and
// mute rules, and the helper protocol and broker plumbing.

const OWN = { ownPids: new Set([100, 101]), ownBundles: ['com.sennechin.apex'] }
const TIMING: CallTiming = { startMs: 3000, flapMs: 1500, endMs: 20_000 }

function proc(over: Partial<CallAudioProcess>): CallAudioProcess {
  return { pid: 500, bundleId: null, exe: null, appPid: null, appBundleId: null, input: true, output: false, ...over }
}
const ZOOM_APP: CallRunningApp = { pid: 500, bundleId: 'us.zoom.xos', name: 'zoom.us' }
const zoom = (o: { input?: boolean; output?: boolean; running?: boolean } = {}): CallsSnapshot => ({
  supported: true,
  audio: o.input || o.output ? [proc({ bundleId: 'us.zoom.xos', appPid: 500, appBundleId: 'us.zoom.xos', input: o.input ?? false, output: o.output ?? false })] : [],
  apps: o.running === false ? [] : [ZOOM_APP],
})

describe('attributing a snapshot', () => {
  it('matches bundle ids with their helpers, never a longer name', () => {
    expect(bundleMatches('com.microsoft.teams2.helper', 'com.microsoft.teams2')).toBe(true)
    expect(bundleMatches('com.microsoft.teams2', 'com.microsoft.teams')).toBe(false)
    expect(bundleMatches('com.google.Chrome.app.abc', 'com.google.Chrome.app.')).toBe(true)
    expect(watchedBundles()).toEqual(expect.arrayContaining(['us.zoom.xos', 'com.apple.FaceTime', 'com.google.Chrome.app.']))
  })

  it('counts a known app’s microphone, and a helper process for its app', () => {
    const uses = attributeCalls(
      {
        supported: true,
        audio: [proc({ bundleId: 'us.zoom.xos' }), proc({ pid: 600, bundleId: 'com.tinyspeck.slackmacgap.helper', appPid: 601, appBundleId: 'com.tinyspeck.slackmacgap', output: true })],
        apps: [ZOOM_APP],
      },
      OWN,
    )
    expect(uses.get('zoom')).toEqual({ app: 'zoom', input: true, output: false, running: true, audio: ['us.zoom.xos'] })
    expect(uses.get('slack')).toMatchObject({ input: true, output: true, audio: ['com.tinyspeck.slackmacgap'] })
  })

  it('never counts Apex’s own microphone, by process or by bundle', () => {
    const uses = attributeCalls(
      {
        supported: true,
        audio: [
          proc({ pid: 100, bundleId: 'us.zoom.xos' }),
          proc({ pid: 700, bundleId: 'com.sennechin.apex.helper', appPid: 100, appBundleId: 'com.sennechin.apex' }),
          proc({ pid: 701, bundleId: 'com.google.Chrome.helper', appPid: 101, appBundleId: 'com.google.Chrome' }),
        ],
        apps: [{ pid: 101, bundleId: 'com.google.Chrome.app.meet', name: 'Google Meet' }],
      },
      OWN,
    )
    expect(uses.size).toBe(0)
  })

  it('reads FaceTime’s audio service as FaceTime only while FaceTime is open, recording the Mac’s sound', () => {
    const service = proc({ pid: 800, bundleId: 'com.apple.avconferenced', exe: 'avconferenced' })
    expect(attributeCalls({ supported: true, audio: [service], apps: [] }, OWN).size).toBe(0)
    const uses = attributeCalls({ supported: true, audio: [service], apps: [{ pid: 801, bundleId: 'com.apple.FaceTime', name: 'FaceTime' }] }, OWN)
    expect(uses.get('facetime')).toEqual({ app: 'facetime', input: true, output: false, running: true, audio: [] })
  })

  it('reads a browser’s microphone as the Google Meet app only while that app is open', () => {
    const chrome = proc({ pid: 900, bundleId: 'com.google.Chrome.helper', appPid: 901, appBundleId: 'com.google.Chrome' })
    expect(attributeCalls({ supported: true, audio: [chrome], apps: [] }, OWN).size).toBe(0)
    const uses = attributeCalls({ supported: true, audio: [chrome], apps: [{ pid: 902, bundleId: 'com.google.Chrome.app.kjgfgldnnfoeklkmfkjfagphfepbbdan', name: 'Google Meet' }] }, OWN)
    expect(uses.get('meet-app')).toMatchObject({ input: true, running: true, audio: ['com.google.Chrome'] })
  })
})

describe('call tracking', () => {
  const at = (tracker: CallTracker, snapshot: CallsSnapshot, now: number) => tracker.observe(attributeCalls(snapshot, OWN), now)

  it('starts a call once the microphone has stayed on, not on a quick check', () => {
    const tracker = new CallTracker(TIMING)
    expect(at(tracker, zoom({ input: true }), 0)).toEqual([])
    expect(tracker.nextAt()).toBe(3000)
    expect(tracker.tick(2999)).toEqual([])
    const [started] = tracker.tick(3000)
    expect(started).toEqual({ type: 'started', call: { id: 'zoom:0', app: 'zoom', startedAt: 0, audio: ['us.zoom.xos'] } })

    const quick = new CallTracker(TIMING)
    at(quick, zoom({ input: true }), 0)
    at(quick, zoom(), 1000)
    expect(quick.tick(1000 + TIMING.flapMs)).toEqual([])
    at(quick, zoom({ input: true }), 4000)
    expect(quick.tick(5000)).toEqual([])
    expect(quick.tick(7000).map((t) => t.type)).toEqual(['started'])
  })

  it('rides out a short microphone flap while waiting', () => {
    const tracker = new CallTracker(TIMING)
    at(tracker, zoom({ input: true }), 0)
    at(tracker, zoom(), 1000)
    at(tracker, zoom({ input: true }), 1500)
    expect(tracker.tick(3000).map((t) => t.call.id)).toEqual(['zoom:0'])
  })

  it('offers each call once, through flaps and a mute that keeps the sound', () => {
    const tracker = new CallTracker(TIMING)
    const transitions = [
      ...at(tracker, zoom({ input: true }), 0),
      ...tracker.tick(3000),
      ...at(tracker, zoom({ output: true }), 10_000),
      ...at(tracker, zoom({ input: true, output: true }), 11_000),
      ...at(tracker, zoom(), 12_000),
      ...at(tracker, zoom({ input: true }), 25_000),
      ...tracker.tick(60_000),
    ]
    expect(transitions.map((t) => t.type)).toEqual(['started'])
    expect(tracker.calls()).toHaveLength(1)
  })

  it('ends after a quiet spell, or at once when the app quits; the next call is a new one', () => {
    const tracker = new CallTracker(TIMING)
    at(tracker, zoom({ input: true }), 0)
    tracker.tick(3000)
    expect(at(tracker, zoom(), 5000)).toEqual([])
    expect(tracker.nextAt()).toBe(25_000)
    expect(tracker.tick(25_000).map((t) => t.type)).toEqual(['ended'])
    expect(tracker.calls()).toEqual([])

    at(tracker, zoom({ input: true }), 30_000)
    const [again] = tracker.tick(33_000)
    expect(again?.call.id).toBe('zoom:30000')
    expect(at(tracker, zoom({ running: false }), 40_000).map((t) => `${t.type}:${t.call.id}`)).toEqual(['ended:zoom:30000'])
  })

  it('ignores Apex’s own microphone even while another app is open', () => {
    const tracker = new CallTracker(TIMING)
    at(tracker, { supported: true, audio: [proc({ pid: 101, bundleId: 'us.zoom.xos' })], apps: [ZOOM_APP] }, 0)
    expect(tracker.tick(10_000)).toEqual([])
    expect(tracker.nextAt()).toBeNull()
  })
})

describe('naming a call from the calendar', () => {
  const NOW = 1_000_000_000
  const ev = (id: string, startsIn: number, over: Partial<CalendarEvent> = {}): CalendarEvent => ({ id, title: id, startsAt: NOW + startsIn, endsAt: NOW + startsIn + 30 * 60_000, url: null, ...over })

  it('prefers the running event with a link to the app’s service', () => {
    const events = [ev('Standup', 0), ev('Zoom review', -25 * 60_000, { url: 'https://acme.zoom.us/j/123456789' })]
    expect(calendarEventForCall(events, { now: NOW, provider: 'zoom' })?.id).toBe('Zoom review')
    expect(calendarEventForCall(events, { now: NOW, provider: null })?.id).toBe('Standup')
  })

  it('skips all-day events and ones that began long ago', () => {
    expect(calendarEventForCall([ev('Offsite', -60_000, { allDay: true }), ev('Old', -40 * 60_000, { endsAt: NOW + 60_000 })], { now: NOW, provider: 'zoom' })).toBeNull()
    expect(callTitle('teams', null, (name) => `${name} call`)).toBe('Microsoft Teams call')
    expect(callTitle('zoom', ev('  Design   sync ', 0), (name) => `${name} call`)).toBe('Design sync')
  })
})

describe('the desktop call card', () => {
  const GRANTED = { microphone: 'granted', speech: 'granted', screen: 'granted' } as const
  const settings = (tr: Partial<TranscriptionSettings> = {}, all = false): CardSettings => ({
    meetingCards: { all, kinds: [], sites: [] },
    transcription: { alertMeetingSites: true, alertCalendar: true, alertDesktopCalls: true, desktopCallsMuted: [], ...tr },
  })
  const card = (over: Partial<Parameters<typeof appCardFor>[0]> = {}) =>
    appCardFor({ app: 'zoom', callId: 'zoom:1', title: 'Zoom call', recording: false, available: true, permissions: GRANTED, seen: () => false, settings: settings(), ...over })

  it('offers notes once per call, unless off, muted for the app, recording or every card is off', () => {
    expect(card()).toEqual({ key: 'call:zoom:1', payload: { mode: 'app', provider: 'zoom', title: 'Zoom call', host: null, app: 'zoom' } })
    expect(card({ seen: (k) => k === callKey('zoom:1') })).toBeNull()
    expect(card({ settings: settings({ alertDesktopCalls: false }) })).toBeNull()
    expect(card({ settings: settings({ desktopCallsMuted: ['zoom'] }) })).toBeNull()
    expect(card({ app: 'teams', settings: settings({ desktopCallsMuted: ['zoom'] }) })?.payload.app).toBe('teams')
    expect(card({ recording: true })).toBeNull()
    expect(card({ available: false })).toBeNull()
    expect(card({ settings: settings({}, true) })).toBeNull()
  })

  it('asks for missing permissions first, keeping the app', () => {
    expect(card({ permissions: { ...GRANTED, screen: 'denied' } })?.payload).toMatchObject({ mode: 'permissions', app: 'zoom', canRecord: true, missing: ['screen'] })
    expect(card({ eventStartsAt: 5 })?.payload.startsAt).toBe(5)
  })

  it('mutes the app or every desktop app in transcription settings; mute-all stays a card setting', () => {
    const payload: CardPayload = { mode: 'app', provider: 'zoom', title: 'Zoom call', host: null, app: 'zoom' }
    expect(appMutePatch('mute-app', payload, { desktopCallsMuted: [] })).toEqual({ desktopCallsMuted: ['zoom'] })
    expect(appMutePatch('mute-app', payload, { desktopCallsMuted: ['zoom'] })).toBeNull()
    expect(appMutePatch('mute-kind', payload, { desktopCallsMuted: [] })).toEqual({ alertDesktopCalls: false })
    expect(appMutePatch('mute-all', payload, { desktopCallsMuted: [] })).toBeNull()
    expect(mutePatch('mute-all', payload, { all: false, kinds: [], sites: [] })).toEqual({ all: true })
    expect(mutePatch('mute-kind', payload, { all: false, kinds: [], sites: [] })).toBeNull()
    expect(cardAllowed('app', null, settings({}, true))).toBe(false)
  })
})

describe('the watcher', () => {
  afterEach(() => vi.useRealTimers())

  function watcher(enabled = true) {
    let listener: ((line: HelperLine) => void) | null = null
    const watches: Array<string[] | null> = []
    const started: DesktopCall[] = []
    const ended: DesktopCall[] = []
    let on = enabled
    const w = new DesktopCallWatcher({
      broker: {
        onLine: (fn) => {
          listener = fn
          return () => (listener = null)
        },
        watchCalls: (apps) => watches.push(apps),
      },
      enabled: () => on,
      own: () => OWN,
      started: (c) => started.push(c),
      ended: (c) => ended.push(c),
      timing: TIMING,
    })
    return { w, watches, started, ended, send: (s: CallsSnapshot) => listener?.({ type: 'calls', ...s }), toggle: (v: boolean) => ((on = v), w.sync()) }
  }

  it('follows the setting and offers a call after the wait, once', () => {
    vi.useFakeTimers()
    const { w, watches, started, ended, send, toggle } = watcher()
    expect(watches).toEqual([watchedBundles()])
    send(zoom({ input: true }))
    expect(w.supported()).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(started).toEqual([])
    vi.advanceTimersByTime(1100)
    expect(started.map((c) => c.app)).toEqual(['zoom'])
    send(zoom({ output: true }))
    send(zoom({ input: true }))
    vi.advanceTimersByTime(60_000)
    expect(started).toHaveLength(1)
    send(zoom({ running: false }))
    expect(ended.map((c) => c.id)).toEqual([started[0]?.id])

    toggle(false)
    expect(watches.at(-1)).toBeNull()
    send(zoom({ input: true }))
    vi.advanceTimersByTime(10_000)
    expect(started).toHaveLength(1)
    w.dispose()
  })
})

describe('protocol and broker', () => {
  it('reads a calls line and drops a malformed one', () => {
    const line = { type: 'calls', supported: true, audio: [{ pid: 5, bundleId: 'us.zoom.xos', exe: 'zoom.us', appPid: 5, appBundleId: 'us.zoom.xos', input: true, output: false }], apps: [{ pid: 5, bundleId: 'us.zoom.xos', name: 'zoom.us' }] }
    expect(parseHelperLine(JSON.stringify(line))).toEqual(line)
    expect(parseHelperLine(JSON.stringify({ ...line, audio: [{ pid: -1 }] }))).toBeNull()
  })

  it('keeps the watch across a helper restart and passes the call’s apps to a meeting start', async () => {
    const spawn = createFakeSpeechHelper()
    const link = new HelperLink({ path: 'fake', assumeExists: true, spawn, handshakeMs: 200, retryAfterMs: 0 })
    const settings = { mic: 'system', locale: 'en-US', secondaryLocale: null, vocabulary: '', autoSummarize: true, alertCalendar: true, alertMeetingSites: true, micSensitivity: 1, systemSensitivity: 1, recordAudio: false, recordOnly: false, setupDismissed: false, alertDesktopCalls: true, desktopCallsMuted: [] } satisfies TranscriptionSettings
    const broker = createSpeechBroker({ link, platform: 'darwin', settings: () => settings, startTimeoutMs: 300, stopTimeoutMs: 300, replyTimeoutMs: 300 })
    const lines: HelperLine[] = []
    broker.onLine((l) => lines.push(l))
    const watches = (): HelperCommand[] => (spawn.last()?.commands ?? []).filter((c) => c.cmd === 'watch-calls')
    const until = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
      expect(check()).toBe(true)
    }

    broker.watchCalls(['us.zoom.xos'])
    await until(() => watches().length === 1)
    await until(() => lines.some((l) => l.type === 'calls'))
    const first = spawn.last()
    link.recycle()
    await until(() => spawn.last() !== first && watches().length === 1)
    expect(watches()[0]).toEqual({ cmd: 'watch-calls', apps: ['us.zoom.xos'] })

    const session = await broker.begin({ purpose: 'meeting', mode: 'meeting', apps: ['us.zoom.xos'] })
    expect(spawn.last()?.commands.find((c) => c.cmd === 'start')).toMatchObject({ mode: 'meeting', apps: ['us.zoom.xos'] })
    await session.stop()
    broker.watchCalls(null)
    await until(() => watches().at(-1)?.cmd === 'watch-calls' && (watches().at(-1) as { apps: unknown }).apps === null)
    broker.dispose()
  })
})
