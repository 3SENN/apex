/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CallsSnapshot } from '@shared/desktopCalls'
import type { CaptureStatus, CardPayload, RecordingPayload } from '@shared/meetingCapture'
import type { MeetingDetail } from '@shared/meetings'
import type { HelperCommand } from '@shared/speech'
import { captureSmokeHooks, type CaptureSmokeHooks } from '../meetings/capture'
import { smokeSpeechHelper } from '../speech/fake'
import type { ShotSpec, SmokeCheck, SmokeContext } from '../smokeBrowser/types'
import { assert, sleep, waitFor } from '../smokeKit'
import { crossSiteFixtures } from './fixtures'

// Meeting capture: the fixture meeting URL's card after the short
// delay, once per meeting; recording with the fake helper, with mic and
// system lines reaching the store; the widget once the tab is out of view;
// pause and resume keeping the elapsed time; stop leading to the wrap-up and
// the smoke client's summary. Offline only: the fixture servers, the fake
// speech helper and the offline client.

const MEETING_HTML = '<!doctype html><title>Smoke meeting</title><main><h1>Team sync</h1><p>A pretend video call.</p></main>'

function letters(n: number): string {
  return Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('')
}

/** A fresh meeting page each run, so the seen-meetings file never hides the card. */
async function meetingPage(ctx: SmokeContext): Promise<string> {
  const fixtures = await crossSiteFixtures(ctx.server)
  return fixtures.addFixture(`/meet/${letters(3)}-${letters(4)}-${letters(3)}`, MEETING_HTML)
}

function hooks(): CaptureSmokeHooks {
  const h = captureSmokeHooks()
  assert(h, 'meeting capture is running under APEX_SMOKE')
  return h
}

const status = (ctx: SmokeContext): Promise<CaptureStatus> => ctx.chrome.invoke<CaptureStatus>('meetingCapture', 'status')

const cardOnce: SmokeCheck = {
  name: 'meeting card: shows on the fixture meeting after its delay, once per meeting',
  async run(ctx) {
    const h = hooks()
    const url = await meetingPage(ctx)
    const tab = ctx.tabs.create(url, { activate: true })
    try {
      await waitFor(() => h.card()?.payload.mode === 'site', 5000, 'the meeting card to be queued')
      assert(h.card()?.payload.provider === 'meet', 'the card names the provider')
      await waitFor(() => h.float.window('meeting-card')?.isVisible() === true, 5000, 'the meeting card to show after its delay')
      await h.cardAction('dismiss')
      await waitFor(() => h.float.window('meeting-card')?.isVisible() !== true, 3000, 'the card to close')
      const again = ctx.tabs.create(url, { activate: true })
      await sleep(900)
      assert(h.card() === null, 'the same meeting raises no second card')
      ctx.tabs.close(again.id)
    } finally {
      ctx.tabs.close(tab.id)
    }
  },
}

const recordFlow: SmokeCheck = {
  name: 'meeting capture: record, segments, widget out of view, pause and resume, stop and wrap-up',
  async run(ctx) {
    const h = hooks()
    const url = await meetingPage(ctx)
    const tab = ctx.tabs.create(url, { activate: true })
    const other: string[] = []
    try {
      await waitFor(() => h.card()?.payload.mode === 'site', 5000, 'the meeting card')
      await h.cardAction('record')
      await waitFor(async () => (await status(ctx)).state === 'recording', 5000, 'the recording to start')
      const started = await status(ctx)
      const id = started.meetingId
      assert(id, 'the recording has a meeting')
      assert(started.origin.tabId === tab.id, 'the recording remembers its tab')

      // The fake helper's lines, as it would send them for each side of the call.
      h.recorder.feed({ type: 'final', source: 'mic', text: 'Shall we move the launch to Friday?', startMs: 0, endMs: 1800 })
      h.recorder.feed({ type: 'final', source: 'system', text: 'Friday works for the whole team.', startMs: 2000, endMs: 3600 })
      const detail = await ctx.chrome.invoke<MeetingDetail>('meetings', 'get', id)
      assert(detail.segments.some((s) => s.source === 'mic') && detail.segments.some((s) => s.source === 'system'), 'mic and system lines reached the store')

      // Out of view: another tab in front shows the widget after the debounce.
      other.push(ctx.tabs.create('about:blank', { activate: true }).id)
      await waitFor(() => h.widgetShown() && h.float.isOpen('recording'), 4000, 'the recording widget')

      await ctx.chrome.invoke('meetingCapture', 'pause')
      const paused = await status(ctx)
      assert(paused.state === 'paused' && paused.pausedBy === 'user', 'pause holds')
      await sleep(400)
      assert((await status(ctx)).elapsedMs === paused.elapsedMs, 'a pause leaves the elapsed time alone')
      await ctx.chrome.invoke('meetingCapture', 'resume')
      await sleep(300)
      const resumed = await status(ctx)
      assert(resumed.state === 'recording' && resumed.elapsedMs > paused.elapsedMs && resumed.elapsedMs < paused.elapsedMs + 2000, 'resume counts on from the pause')

      await ctx.chrome.invoke('meetingCapture', 'stop')
      const wrap = (): RecordingPayload['wrapUp'] => h.widget().wrapUp
      assert(wrap()?.meetingId === id, 'stopping grows the widget into the wrap-up')
      await waitFor(() => wrap()?.phase === 'ready', 20_000, 'the summary from the smoke client')
      assert(wrap()?.summarized === true, 'the wrap-up says the notes are ready')
      const done = await ctx.chrome.invoke<MeetingDetail>('meetings', 'get', id)
      assert(done.status === 'summarized' && done.summary !== null, 'the meeting has its summary')
      h.recorder.dismissWrapUp()
      await waitFor(() => !h.float.isOpen('recording'), 3000, 'the wrap-up to close')
    } finally {
      if (h.recorder.isLive()) await h.recorder.stop().catch(() => undefined)
      h.recorder.dismissWrapUp()
      for (const id of other) ctx.tabs.close(id)
      ctx.tabs.close(tab.id)
    }
  },
}

// Desktop calls: the fake helper's `calls` snapshots stand in for Zoom; nothing real is watched or recorded.
const ZOOM_PID = 4242
const zoomCall = (input: boolean): CallsSnapshot => ({
  supported: true,
  audio: [{ pid: ZOOM_PID, bundleId: 'us.zoom.xos', exe: 'zoom.us', appPid: ZOOM_PID, appBundleId: 'us.zoom.xos', input, output: true }],
  apps: [{ pid: ZOOM_PID, bundleId: 'us.zoom.xos', name: 'zoom.us' }],
})
const NO_CALLS: CallsSnapshot = { supported: true, audio: [], apps: [] }

const desktopCall: SmokeCheck = {
  name: 'desktop calls: a Zoom call offers notes once, records Zoom’s sound and wraps up when the call ends',
  async run(ctx) {
    const h = hooks()
    try {
      assert(h.calls.supported() === true, 'the helper reported whether calls can be watched')
      smokeSpeechHelper.push({ type: 'calls', ...zoomCall(true) })
      await waitFor(() => h.card()?.payload.mode === 'app', 5000, 'the desktop call card')
      const card = h.card()
      assert(card?.payload.app === 'zoom' && card.payload.provider === 'zoom' && card.payload.title.length > 0, 'the card names the Zoom call')
      // Muted on this side (sound only), then back: still the same call, so no second card.
      smokeSpeechHelper.push({ type: 'calls', ...zoomCall(false) })
      smokeSpeechHelper.push({ type: 'calls', ...zoomCall(true) })
      await sleep(600)
      assert(h.card()?.id === card.id && h.calls.calls().length === 1, 'one call, one card')

      await h.cardAction('record')
      await waitFor(async () => (await status(ctx)).state === 'recording', 5000, 'the notes to start')
      const id = (await status(ctx)).meetingId
      assert(id, 'the call has a meeting')
      const start = smokeSpeechHelper
        .commands()
        .filter((c): c is Extract<HelperCommand, { cmd: 'start' }> => c.cmd === 'start')
        .at(-1)
      assert(start?.mode === 'meeting' && start.apps?.includes('us.zoom.xos'), 'only Zoom’s sound is recorded as the other side')
      h.recorder.feed({ type: 'final', source: 'system', text: 'Thanks for joining, let’s start with the roadmap.', startMs: 0, endMs: 2400 })

      // Zoom quits: the call is over and the notes wrap up.
      smokeSpeechHelper.push({ type: 'calls', ...NO_CALLS })
      await waitFor(() => h.widget().wrapUp?.meetingId === id && !h.recorder.isLive(), 5000, 'the wrap-up once the call ends')
      const detail = await ctx.chrome.invoke<MeetingDetail>('meetings', 'get', id)
      assert(detail.provider === 'zoom', 'the meeting remembers it was a Zoom call')
    } finally {
      smokeSpeechHelper.push({ type: 'calls', ...NO_CALLS })
      if (h.recorder.isLive()) await h.recorder.stop().catch(() => undefined)
      if (h.card()?.payload.mode === 'app') await h.cardAction('dismiss')
      h.recorder.dismissWrapUp()
    }
  },
}

export const checks: SmokeCheck[] = [cardOnce, recordFlow, desktopCall]

// ── screenshot tour: the floats are their own windows, so each is captured from its own page ──

async function floatShot(h: CaptureSmokeHooks, kind: 'meeting-card' | 'recording', name: string): Promise<void> {
  const dir = process.env.APEX_SMOKE_SHOTS
  if (!dir) return
  const theme = process.env.APEX_SMOKE_THEME === 'dark' ? 'dark' : 'light'
  await waitFor(() => h.float.window(kind)?.isVisible() === true, 5000, `the ${kind} float`)
  await sleep(350)
  const win = h.float.window(kind)
  assert(win, `the ${kind} window exists`)
  const image = await win.webContents.capturePage()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}-${theme}.png`), image.toPNG())
}

function cardShot(name: string, payload: CardPayload): ShotSpec {
  return {
    name,
    async run() {
      const h = hooks()
      h.offerCard(payload)
      try {
        await floatShot(h, 'meeting-card', name)
      } finally {
        await h.cardAction('dismiss')
      }
    },
  }
}

const LIVE: CaptureStatus = {
  state: 'recording',
  meetingId: null,
  startedAt: Date.now(),
  elapsedMs: 754_000,
  systemAudio: true,
  origin: { tabId: null, url: null },
  warnings: [],
  pausedBy: null,
  audioOnly: null,
}

function widgetShot(name: string, payload: RecordingPayload): ShotSpec {
  return {
    name,
    async run() {
      const h = hooks()
      h.float.open('recording', payload)
      try {
        await floatShot(h, 'recording', name)
      } finally {
        h.float.close('recording')
      }
    },
  }
}

const WRAP = { meetingId: '00000000-0000-4000-8000-000000000001', title: 'Team sync' }

export const shots: ShotSpec[] = [
  cardShot('meeting-card-site', { mode: 'site', provider: 'meet', title: 'Google Meet', host: 'meet.google.com' }),
  cardShot('meeting-card-permissions', { mode: 'permissions', provider: 'zoom', title: 'Zoom', host: 'zoom.us', missing: ['microphone', 'speech', 'screen'], canRecord: false }),
  cardShot('meeting-card-desktop-call', { mode: 'app', provider: 'zoom', title: 'Zoom call', host: null, app: 'zoom' }),
  cardShot('meeting-card-continue', { mode: 'continue', provider: null, title: 'Still recording?', host: null, reason: 'silent', countdownMs: 60_000 }),
  widgetShot('recording-widget', { status: LIVE, wrapUp: null }),
  widgetShot('recording-widget-paused', { status: { ...LIVE, state: 'paused', pausedBy: 'user' }, wrapUp: null }),
  widgetShot('recording-wrapup-processing', { status: { ...LIVE, state: 'processing' }, wrapUp: { ...WRAP, phase: 'processing' } }),
  widgetShot('recording-wrapup-ready', { status: { ...LIVE, state: 'idle' }, wrapUp: { ...WRAP, phase: 'ready', summarized: true } }),
  widgetShot('recording-wrapup-no-engine', { status: { ...LIVE, state: 'idle' }, wrapUp: { ...WRAP, phase: 'no-engine' } }),
  // Audio only: Speech Recognition off, so the card records and the wrap-up says the recording is saved.
  cardShot('meeting-card-speech-off', { mode: 'permissions', provider: 'meet', title: 'Google Meet', host: 'meet.google.com', missing: ['speech'], canRecord: true, audioOnly: true }),
  cardShot('meeting-card-desktop-call-audio', { mode: 'app', provider: 'zoom', title: 'Zoom call', host: null, app: 'zoom', audioOnly: true }),
  widgetShot('recording-widget-audio-only', { status: { ...LIVE, audioOnly: 'speech-denied' }, wrapUp: null }),
  widgetShot('recording-wrapup-audio-only', { status: { ...LIVE, state: 'idle', audioOnly: 'speech-denied' }, wrapUp: { ...WRAP, phase: 'ready', summarized: false, audioOnly: 'speech-denied' } }),
]
