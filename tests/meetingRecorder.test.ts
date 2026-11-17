/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaptureStatus, WrapUp } from '../src/shared/meetingCapture'
import type { AudioOnlyReason, MeetingCreateInput, MeetingDetail, MeetingFinish, MeetingStatus, MeetingStore, MeetingSummarizer, TranscriptSegment } from '../src/shared/meetings'
import { SpeechError, type TranscriptionSettings } from '../src/shared/speech'
import { createFakeBroker, type FakeBroker } from '../src/main/speech/fake'
import { EngineUnavailableError } from '../src/main/agent/quick'
import { CONTINUE_COUNTDOWN_MS, LONG_RECORDING_MS, Recorder, SILENCE_MS, WATCH_INTERVAL_MS, continueReason, type RecorderDeps } from '../src/main/meetings/capture/recorder'
import { quitSaver } from '../src/main/meetings/capture/quitSave'
import { WIDGET_DEBOUNCE_MS, WidgetVisibility, originInView, widgetWanted, type OriginView } from '../src/main/meetings/capture/widget'

// The recorder's lifecycle against a fake broker and store, its
// timers on a fake clock, and the widget's visibility rules (MV-10).

class FakeStore extends EventEmitter implements MeetingStore {
  meetings = new Map<string, { input: MeetingCreateInput; segments: TranscriptSegment[]; live: Record<string, string>; warnings: string[]; finish: MeetingFinish | null; status: MeetingStatus; title: string }>()
  #n = 0

  create(i: MeetingCreateInput) {
    const id = `00000000-0000-4000-8000-${String(++this.#n).padStart(12, '0')}`
    this.meetings.set(id, { input: i, segments: [], live: {}, warnings: [], finish: null, status: 'live', title: i.title })
    return { id, kind: i.kind, title: i.title, provider: i.provider ?? null, url: i.url ?? null, startedAt: i.startedAt, durationMs: 0, status: 'live' as const, hasAudio: false, sizeBytes: 0, snippet: '' }
  }
  audioPathFor(id: string): string {
    return `/tmp/meetings/${id}/audio.m4a`
  }
  appendSegment(id: string, s: Omit<TranscriptSegment, 'id'>): void {
    this.#m(id).segments.push({ id: `s${this.#m(id).segments.length}`, ...s })
  }
  setLive(id: string, live: Partial<Record<'mic' | 'system', string>>): void {
    this.#m(id).live = { ...live } as Record<string, string>
  }
  warn(id: string, w: string): void {
    this.#m(id).warnings.push(w)
  }
  audioOnly = new Map<string, AudioOnlyReason | null>()
  setAudioOnly(id: string, reason: AudioOnlyReason): void {
    this.audioOnly.set(id, reason)
  }
  finish(id: string, r: MeetingFinish): void {
    const m = this.#m(id)
    m.finish = r
    m.status = r.status
    this.emit('changed', id)
  }
  get(id: string): MeetingDetail | null {
    const m = this.meetings.get(id)
    if (!m) return null
    return {
      id, kind: m.input.kind, title: m.title, provider: m.input.provider ?? null, url: m.input.url ?? null, startedAt: m.input.startedAt,
      durationMs: m.finish?.durationMs ?? 0, status: m.status, hasAudio: Boolean(m.finish?.audio), sizeBytes: 0, snippet: '',
      segments: m.segments, live: m.live, labels: { mic: 'You', system: 'Others' }, summary: null, audioUrl: null,
      error: m.finish?.error ?? null, warnings: [], audioOnly: this.audioOnly.has(id) ? this.audioOnly.get(id) : (m.input.audioOnly ?? null),
    }
  }
  setStatus(id: string, status: MeetingStatus, title?: string): void {
    const m = this.#m(id)
    m.status = status
    if (title) m.title = title
    this.emit('changed', id)
  }
  #m(id: string) {
    const m = this.meetings.get(id)
    if (!m) throw new Error('no meeting')
    return m
  }
}

const TRANSCRIPTION: TranscriptionSettings = {
  mic: 'built-in', locale: null, secondaryLocale: null, vocabulary: '', autoSummarize: true, alertCalendar: true, alertMeetingSites: true,
  micSensitivity: 1, systemSensitivity: 1, recordAudio: false, recordOnly: false, setupDismissed: false, alertDesktopCalls: true, desktopCallsMuted: [],
}

interface Harness {
  recorder: Recorder
  broker: FakeBroker
  store: FakeStore
  summarizer: MeetingSummarizer & { request: ReturnType<typeof vi.fn> }
  notes: Array<{ title: string; body?: string; target?: string }>
  signals: number
  statuses: CaptureStatus[]
  wraps: Array<WrapUp | null>
  settings: TranscriptionSettings
  inView: { value: boolean }
}

function harness(over: Partial<RecorderDeps> = {}, summarize?: (store: FakeStore, id: string) => Promise<void>): Harness {
  const broker = createFakeBroker({ stopResult: { durationMs: 5000, audio: { path: '/tmp/a.m4a', bytes: 1234 } } })
  const store = new FakeStore()
  const request = vi.fn(async (id: string) => {
    if (summarize) return summarize(store, id)
    store.setStatus(id, 'summarizing')
    store.setStatus(id, 'summarized', 'Weekly planning')
  })
  const h: Harness = {
    recorder: null as unknown as Recorder,
    broker,
    store,
    summarizer: { request, pending: () => [] } as Harness['summarizer'],
    notes: [],
    signals: 0,
    statuses: [],
    wraps: [],
    settings: { ...TRANSCRIPTION },
    inView: { value: true },
  }
  h.recorder = new Recorder({
    broker,
    store,
    summarizer: h.summarizer,
    transcription: () => h.settings,
    systemLocale: () => 'en-GB',
    appInView: () => h.inView.value,
    notify: (n) => h.notes.push(n),
    transcribed: () => h.signals++,
    ...over,
  })
  h.recorder.on('status', (s) => h.statuses.push(s))
  h.recorder.on('wrap-up', (w) => h.wraps.push(w))
  return h
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-29T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('recorder lifecycle', () => {
  it('creates the meeting, begins a meeting session and records finals and partials', async () => {
    const h = harness()
    const id = await h.recorder.start({ kind: 'meeting', tabId: 't3', url: 'https://meet.google.com/abc-defg-hij' })
    const m = h.store.meetings.get(id)
    expect(m?.input).toMatchObject({ kind: 'meeting', title: 'Google Meet', provider: 'meet', locale: 'en-GB', recordAudio: false })
    expect(h.broker.sessions[0]?.purpose).toBe('meeting')
    expect(h.recorder.status()).toMatchObject({ state: 'recording', meetingId: id, origin: { tabId: 't3', url: 'https://meet.google.com/abc-defg-hij' } })

    h.broker.emit({ type: 'started', mode: 'meeting', onDevice: true, systemAudio: true, deviceId: null, locale: 'en-GB', fallbackDevice: false })
    h.broker.emit({ type: 'partial', source: 'mic', text: 'Hello every', startMs: 0, endMs: 500 })
    expect(m?.live).toEqual({ mic: 'Hello every' })
    h.broker.emit({ type: 'final', source: 'mic', text: 'Hello everyone.', startMs: 0, endMs: 900 })
    h.broker.emit({ type: 'final', source: 'system', text: 'Hi!', startMs: 1000, endMs: 1400 })
    expect(m?.segments.map((s) => [s.source, s.text])).toEqual([['mic', 'Hello everyone.'], ['system', 'Hi!']])
    expect(m?.live).toEqual({})
    expect(h.recorder.status().systemAudio).toBe(true)
  })

  it('records audio to the store’s path when recording is on, with the saved locale', async () => {
    const h = harness()
    h.settings = { ...h.settings, recordAudio: true, locale: 'nl-NL' }
    const begin = vi.spyOn(h.broker, 'begin')
    const id = await h.recorder.start({ kind: 'recording' })
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({ mode: 'meeting', locale: 'nl-NL', record: `/tmp/meetings/${id}/audio.m4a`, levels: true }))
    expect(h.store.meetings.get(id)?.input).toMatchObject({ locale: 'nl-NL', recordAudio: true })
    expect(h.store.meetings.get(id)?.input.title).toMatch(/^Recording, /)
  })

  it('refuses a second start, and refuses when another session holds the helper', async () => {
    const h = harness()
    const first = h.recorder.start({ kind: 'meeting' })
    await expect(h.recorder.start({ kind: 'meeting' })).rejects.toMatchObject({ code: 'busy' })
    await first
    await expect(h.recorder.start({ kind: 'meeting' })).rejects.toMatchObject({ code: 'busy' })
    expect(h.store.meetings.size).toBe(1)
    const other = harness()
    await other.broker.begin({ purpose: 'dictation', mode: 'dictation' })
    await expect(other.recorder.start({ kind: 'meeting' })).rejects.toMatchObject({ code: 'busy', holder: 'dictation' })
    expect(other.store.meetings.size).toBe(0)
  })

  it('fails before saving anything when the microphone is denied', async () => {
    const h = harness()
    h.broker.setPermissions({ microphone: 'denied', speech: 'granted', screen: 'granted' })
    await expect(h.recorder.start({ kind: 'meeting' })).rejects.toBeInstanceOf(SpeechError)
    expect(h.store.meetings.size).toBe(0)
    expect(h.recorder.status().state).toBe('idle')
  })

  it('marks the meeting failed when the session can’t begin', async () => {
    const h = harness()
    vi.spyOn(h.broker, 'begin').mockRejectedValueOnce(new SpeechError('mic-busy'))
    await expect(h.recorder.start({ kind: 'meeting' })).rejects.toMatchObject({ code: 'mic-busy' })
    const [m] = [...h.store.meetings.values()]
    expect(m?.finish).toMatchObject({ status: 'failed', error: 'mic-busy' })
    expect(h.recorder.status().state).toBe('idle')
  })

  it('leaves pauses out of the elapsed time', async () => {
    const h = harness()
    await h.recorder.start({ kind: 'meeting' })
    vi.advanceTimersByTime(10_000)
    h.recorder.pause()
    expect(h.recorder.status()).toMatchObject({ state: 'paused', pausedBy: 'user', elapsedMs: 10_000 })
    expect(h.broker.sessions[0]?.paused).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(h.recorder.status().elapsedMs).toBe(10_000)
    h.recorder.resume()
    vi.advanceTimersByTime(5_000)
    expect(h.recorder.status()).toMatchObject({ state: 'recording', pausedBy: null, elapsedMs: 15_000 })
  })

  it('lets the lid resume only its own pause', async () => {
    const h = harness()
    await h.recorder.start({ kind: 'meeting' })
    h.recorder.pause('user')
    h.recorder.resume('lid')
    expect(h.recorder.status().state).toBe('paused')
    h.recorder.resume('user')
    h.recorder.pause('lid')
    expect(h.recorder.status().pausedBy).toBe('lid')
    h.recorder.resume('lid')
    expect(h.recorder.status().state).toBe('recording')
  })

  it('stops: processing, finish with the audio, the signal, then the summary', async () => {
    const h = harness()
    const id = await h.recorder.start({ kind: 'meeting' })
    vi.advanceTimersByTime(42_000)
    await h.recorder.stop()
    const m = h.store.meetings.get(id)
    expect(m?.finish).toMatchObject({ status: 'transcribed', durationMs: 42_000, audio: { path: '/tmp/a.m4a', bytes: 1234 } })
    expect(h.signals).toBe(1)
    expect(h.wraps.find(Boolean)).toMatchObject({ meetingId: id, phase: 'processing' })
    expect(h.statuses.map((s) => s.state)).toContain('stopping')
    expect(h.statuses.map((s) => s.state)).toContain('processing')
    await vi.runAllTimersAsync()
    expect(h.summarizer.request).toHaveBeenCalledWith(id)
    expect(h.recorder.wrapUp()).toMatchObject({ phase: 'ready', summarized: true, title: 'Weekly planning' })
    expect(h.recorder.status().state).toBe('idle')
    // Apex was in view: no notification.
    expect(h.notes).toEqual([])
  })

  it('says the summary is pending with no engine, then updates when it arrives', async () => {
    const h = harness({}, async (store, id) => store.setStatus(id, 'summary-pending'))
    const id = await h.recorder.start({ kind: 'meeting' })
    await h.recorder.stop()
    await vi.runAllTimersAsync()
    expect(h.recorder.wrapUp()).toMatchObject({ phase: 'no-engine' })
    // A key is added later and the library's queue runs the summary.
    h.store.setStatus(id, 'summarizing')
    expect(h.recorder.wrapUp()?.phase).toBe('processing')
    h.store.setStatus(id, 'summarized', 'Notes')
    expect(h.recorder.wrapUp()).toMatchObject({ phase: 'ready', summarized: true, title: 'Notes' })
  })

  it('treats an engine error as pending, and other failures as transcript-only', async () => {
    const pending = harness({}, async () => {
      throw new EngineUnavailableError('no key')
    })
    await pending.recorder.start({ kind: 'meeting' })
    await pending.recorder.stop()
    await vi.runAllTimersAsync()
    expect(pending.recorder.wrapUp()?.phase).toBe('no-engine')

    const broken = harness({}, async () => {
      throw new Error('model said no')
    })
    await broken.recorder.start({ kind: 'meeting' })
    await broken.recorder.stop()
    await vi.runAllTimersAsync()
    expect(broken.recorder.wrapUp()).toMatchObject({ phase: 'ready', summarized: false })
  })

  it('skips the summary when auto-summarize is off', async () => {
    const h = harness()
    h.settings = { ...h.settings, autoSummarize: false }
    await h.recorder.start({ kind: 'meeting' })
    await h.recorder.stop()
    await vi.runAllTimersAsync()
    expect(h.summarizer.request).not.toHaveBeenCalled()
    expect(h.recorder.wrapUp()).toMatchObject({ phase: 'ready', summarized: false })
  })

  it('notifies a ready summary only when Apex is out of view', async () => {
    const h = harness()
    h.inView.value = false
    const id = await h.recorder.start({ kind: 'meeting' })
    await h.recorder.stop()
    await vi.runAllTimersAsync()
    expect(h.notes).toEqual([expect.objectContaining({ title: 'Meeting notes ready', target: `apex://meetings/${id}` })])
  })

  it('warns about missing system audio and a fallback mic, and shows reconnecting until restored', async () => {
    const h = harness()
    const id = await h.recorder.start({ kind: 'meeting' })
    h.broker.emit({ type: 'started', mode: 'meeting', onDevice: true, systemAudio: false, deviceId: null, locale: 'en-GB', fallbackDevice: true })
    h.broker.emit({ type: 'warning', code: 'screen-missing' })
    expect(h.recorder.status().warnings).toEqual(['screen-missing', 'device-fallback'])
    h.broker.emit({ type: 'interrupted', source: 'system' })
    expect(h.recorder.status().warnings).toContain('interrupted')
    h.broker.emit({ type: 'restored', source: 'system' })
    expect(h.recorder.status().warnings).not.toContain('interrupted')
    expect(h.store.meetings.get(id)?.warnings).toEqual(['screen-missing', 'device-fallback', 'interrupted'])
  })

  it('finishes as failed with the error when the helper fails', async () => {
    const h = harness()
    h.inView.value = false
    const id = await h.recorder.start({ kind: 'meeting' })
    h.broker.emit({ type: 'error', code: 'recording-failed', message: 'disk full', fatal: true })
    expect(h.store.meetings.get(id)?.finish).toMatchObject({ status: 'failed', error: 'recording-failed' })
    expect(h.recorder.status().state).toBe('idle')
    expect(h.recorder.wrapUp()).toMatchObject({ phase: 'failed', error: 'recording-failed' })
    expect(h.broker.sessions[0]?.cancelled).toBe(true)
    expect(h.notes).toHaveLength(1)
  })

  it('ignores a non-fatal helper error', async () => {
    const h = harness()
    await h.recorder.start({ kind: 'meeting' })
    h.broker.emit({ type: 'error', code: 'no-speech', message: 'quiet', fatal: false })
    expect(h.recorder.status().state).toBe('recording')
  })

  it('finishes when the helper ends the session by itself', async () => {
    const h = harness()
    const id = await h.recorder.start({ kind: 'meeting' })
    h.broker.emit({ type: 'stopped', durationMs: 3000, audio: null })
    expect(h.store.meetings.get(id)?.finish?.status).toBe('transcribed')
    await vi.runAllTimersAsync()
    expect(h.recorder.status().state).toBe('idle')
  })

  it('a stop during start waits for it, then stops', async () => {
    const h = harness()
    const started = h.recorder.start({ kind: 'meeting' })
    const stopped = h.recorder.stop()
    const id = await started
    await stopped
    expect(h.store.meetings.get(id)?.finish?.status).toBe('transcribed')
  })

  it('asks for a permission macOS never asked about, then starts', async () => {
    const h = harness()
    h.broker.setPermissions({ microphone: 'not-determined', speech: 'not-determined', screen: 'granted' })
    const asked: string[] = []
    h.broker.request = async (what) => {
      asked.push(what)
      const now = await h.broker.permissions()
      h.broker.setPermissions({ ...now, [what]: 'granted' })
      return h.broker.permissions()
    }
    const id = await h.recorder.start({ kind: 'meeting' })
    expect(asked).toEqual(['microphone', 'speech'])
    expect(h.store.meetings.has(id)).toBe(true)
  })

  it('fails without saving anything when the microphone is denied', async () => {
    const h = harness()
    h.broker.setPermissions({ microphone: 'denied', speech: 'granted', screen: 'granted' })
    await expect(h.recorder.start({ kind: 'meeting' })).rejects.toMatchObject({ code: 'mic-denied' })
    expect(h.store.meetings.size).toBe(0)
  })
})

describe('audio only', () => {
  it('records audio only when chosen: no speech prompt, the audio kept, no transcript and no summary', async () => {
    const h = harness()
    h.settings = { ...h.settings, recordOnly: true, recordAudio: false }
    h.broker.setPermissions({ microphone: 'granted', speech: 'not-determined', screen: 'granted' })
    const asked: string[] = []
    h.broker.request = async (what) => {
      asked.push(what)
      return h.broker.permissions()
    }
    const id = await h.recorder.start({ kind: 'meeting' })
    expect(asked).toEqual([])
    expect(h.store.meetings.get(id)?.input).toMatchObject({ audioOnly: 'chosen' })
    expect(h.broker.sessions[0]?.options).toMatchObject({ transcribe: false, record: `/tmp/meetings/${id}/audio.m4a` })
    expect(h.recorder.status().audioOnly).toBe('chosen')
    await h.recorder.stop()
    await vi.runAllTimersAsync()
    expect(h.store.meetings.get(id)?.finish?.status).toBe('recorded')
    expect(h.summarizer.request).not.toHaveBeenCalled()
    expect(h.signals).toBe(0)
    expect(h.wraps.filter(Boolean).at(-1)).toMatchObject({ meetingId: id, phase: 'ready', audioOnly: 'chosen' })
  })

  it('falls back to audio only when Speech Recognition is off for Apex', async () => {
    const h = harness()
    h.broker.setPermissions({ microphone: 'granted', speech: 'not-determined', screen: 'granted' })
    h.broker.request = async () => ({ microphone: 'granted', speech: 'denied', screen: 'granted' })
    const id = await h.recorder.start({ kind: 'meeting' })
    expect(h.store.meetings.get(id)?.input).toMatchObject({ audioOnly: 'speech-denied' })
    expect(h.broker.sessions[0]?.options).toMatchObject({ transcribe: false })
    expect(h.recorder.status().audioOnly).toBe('speech-denied')
  })

  it('falls back to audio only when this Mac can’t transcribe the language', async () => {
    const h = harness()
    const begin = h.broker.begin
    h.broker.begin = async (o) => {
      if (o.transcribe !== false) throw new SpeechError('locale-unsupported', 'Speech recognition doesn’t support xx-XX.')
      return begin(o)
    }
    const id = await h.recorder.start({ kind: 'meeting' })
    expect(h.store.audioOnly.get(id)).toBe('locale-unsupported')
    expect(h.broker.sessions).toHaveLength(1)
    expect(h.broker.sessions[0]?.options).toMatchObject({ transcribe: false, record: `/tmp/meetings/${id}/audio.m4a` })
    expect(h.recorder.status()).toMatchObject({ state: 'recording', audioOnly: 'locale-unsupported' })
  })

  it('still fails when recording itself can’t start', async () => {
    const h = harness()
    h.broker.begin = async () => {
      throw new SpeechError('mic-busy', 'The microphone is in use.')
    }
    await expect(h.recorder.start({ kind: 'meeting' })).rejects.toMatchObject({ code: 'mic-busy' })
    const [m] = [...h.store.meetings.values()]
    expect(m?.finish).toMatchObject({ status: 'failed', error: 'mic-busy' })
  })

  it('turns the wrap-up into an ordinary meeting’s once the recording is transcribed', async () => {
    const h = harness()
    h.settings = { ...h.settings, recordOnly: true }
    const id = await h.recorder.start({ kind: 'meeting' })
    await h.recorder.stop()
    await vi.runAllTimersAsync()
    expect(h.recorder.wrapUp()).toMatchObject({ phase: 'ready', audioOnly: 'chosen' })
    // Transcribe in Meetings: the library drops audio only, then the notes arrive.
    h.store.audioOnly.set(id, null)
    h.store.setStatus(id, 'summarized', 'Weekly planning')
    expect(h.recorder.wrapUp()).toMatchObject({ phase: 'ready', summarized: true, audioOnly: null })
  })

  it('a card that offered audio only (Speech Recognition off) records without asking again', async () => {
    const h = harness()
    h.broker.setPermissions({ microphone: 'granted', speech: 'denied', screen: 'granted' })
    const asked: string[] = []
    h.broker.request = async (what) => {
      asked.push(what)
      return h.broker.permissions()
    }
    const id = await h.recorder.start({ kind: 'meeting', audioOnly: true })
    expect(asked).toEqual([])
    expect(h.store.meetings.get(id)?.input).toMatchObject({ audioOnly: 'speech-denied' })
  })
})

describe('continue question', () => {
  it('asks after ten silent minutes and stops by itself after the countdown', async () => {
    const h = harness()
    h.inView.value = false
    const asks: unknown[] = []
    h.recorder.on('ask', (q) => asks.push(q))
    const id = await h.recorder.start({ kind: 'meeting' })
    vi.advanceTimersByTime(SILENCE_MS + WATCH_INTERVAL_MS)
    expect(h.recorder.question()).toMatchObject({ reason: 'silent' })
    await vi.advanceTimersByTimeAsync(CONTINUE_COUNTDOWN_MS)
    await vi.runAllTimersAsync()
    expect(h.store.meetings.get(id)?.finish?.status).toBe('transcribed')
    expect(asks.at(-1)).toBeNull()
    expect(h.notes[0]).toMatchObject({ title: 'Recording stopped' })
  })

  it('sound resets the silence; continuing resets it too', async () => {
    const h = harness()
    await h.recorder.start({ kind: 'meeting' })
    vi.advanceTimersByTime(SILENCE_MS - 60_000)
    h.broker.emit({ type: 'level', source: 'system', rms: 0.1, peak: 0.3 })
    vi.advanceTimersByTime(5 * 60_000)
    expect(h.recorder.question()).toBeNull()
    vi.advanceTimersByTime(5 * 60_000 + WATCH_INTERVAL_MS)
    expect(h.recorder.question()?.reason).toBe('silent')
    h.recorder.answer('continue')
    expect(h.recorder.question()).toBeNull()
    vi.advanceTimersByTime(CONTINUE_COUNTDOWN_MS * 2)
    expect(h.recorder.status().state).toBe('recording')
  })

  it('asks after two hours of recording, and again two hours after continuing', async () => {
    const h = harness()
    await h.recorder.start({ kind: 'meeting' })
    // Keep it talkative so only the length counts.
    const talk = setInterval(() => h.broker.emit({ type: 'level', source: 'mic', rms: 0.1, peak: 0.5 }), 60_000)
    vi.advanceTimersByTime(LONG_RECORDING_MS + WATCH_INTERVAL_MS)
    expect(h.recorder.question()?.reason).toBe('long')
    h.recorder.answer('continue')
    vi.advanceTimersByTime(LONG_RECORDING_MS - 10 * WATCH_INTERVAL_MS)
    expect(h.recorder.question()).toBeNull()
    vi.advanceTimersByTime(12 * WATCH_INTERVAL_MS)
    expect(h.recorder.question()?.reason).toBe('long')
    clearInterval(talk)
  })

  it('never calls a pause silence', () => {
    const base = { elapsedMs: 0, nextLongAtMs: LONG_RECORDING_MS, lastSoundAt: 0, now: SILENCE_MS * 3 }
    expect(continueReason({ ...base, state: 'recording' })).toBe('silent')
    expect(continueReason({ ...base, state: 'paused' })).toBeNull()
    expect(continueReason({ ...base, state: 'idle' })).toBeNull()
    expect(continueReason({ ...base, state: 'paused', elapsedMs: LONG_RECORDING_MS })).toBe('long')
  })

  it('stop answers clear the question and stop the recording', async () => {
    const h = harness()
    const id = await h.recorder.start({ kind: 'meeting' })
    vi.advanceTimersByTime(SILENCE_MS + WATCH_INTERVAL_MS)
    h.recorder.answer('stop')
    await vi.runAllTimersAsync()
    expect(h.store.meetings.get(id)?.finish?.status).toBe('transcribed')
    // A stop the person chose isn't announced.
    expect(h.notes.filter((n) => n.title === 'Recording stopped')).toEqual([])
  })
})

describe('widget visibility', () => {
  const view = (over: Partial<NonNullable<OriginView['window']>> = {}, appHidden = false): OriginView => ({
    appHidden,
    window: { activeTabId: 't1', splitTabIds: [], railUrl: null, activeInternalUrl: null, hasTab: (id) => ['t1', 't2'].includes(id), ...over },
  })
  const meetings = (url: string): boolean => url.startsWith('apex://meetings')

  it('wants the widget only while recording out of view, or for the wrap-up', () => {
    expect(widgetWanted({ state: 'recording', originInView: false, wrapUp: false })).toBe(true)
    expect(widgetWanted({ state: 'paused', originInView: false, wrapUp: false })).toBe(true)
    expect(widgetWanted({ state: 'recording', originInView: true, wrapUp: false })).toBe(false)
    expect(widgetWanted({ state: 'idle', originInView: false, wrapUp: false })).toBe(false)
    expect(widgetWanted({ state: 'idle', originInView: true, wrapUp: true })).toBe(true)
  })

  it('counts the origin tab in view only when it is on screen in the focused window', () => {
    expect(originInView({ tabId: 't1' }, view(), meetings)).toBe(true)
    expect(originInView({ tabId: 't2' }, view(), meetings)).toBe(false)
    expect(originInView({ tabId: 't2' }, view({ splitTabIds: ['t1', 't2'] }), meetings)).toBe(true)
    expect(originInView({ tabId: 't1' }, view({ railUrl: 'apex://chats' }), meetings)).toBe(false)
    expect(originInView({ tabId: 't9' }, view({ activeTabId: 't9' }), meetings)).toBe(false)
    // Unfocused or minimised windows report no window; a hidden app is out of view.
    expect(originInView({ tabId: 't1' }, { appHidden: false, window: null }, meetings)).toBe(false)
    expect(originInView({ tabId: 't1' }, view({}, true), meetings)).toBe(false)
  })

  it('counts a recording started elsewhere in view while Meetings is on screen', () => {
    expect(originInView({ tabId: null }, view({ railUrl: 'apex://meetings' }), meetings)).toBe(true)
    expect(originInView({ tabId: null }, view({ activeInternalUrl: 'apex://meetings/abc' }), meetings)).toBe(true)
    expect(originInView({ tabId: null }, view(), meetings)).toBe(false)
  })

  it('debounces changes, and a quick flip back cancels them', () => {
    const applied: boolean[] = []
    const v = new WidgetVisibility((show) => applied.push(show))
    v.update(true)
    vi.advanceTimersByTime(WIDGET_DEBOUNCE_MS - 100)
    v.update(false)
    vi.advanceTimersByTime(WIDGET_DEBOUNCE_MS * 2)
    expect(applied).toEqual([])
    v.update(true)
    // Repeated reports don't restart the wait.
    vi.advanceTimersByTime(300)
    v.update(true)
    vi.advanceTimersByTime(WIDGET_DEBOUNCE_MS - 300)
    expect(applied).toEqual([true])
    v.update(false, true)
    expect(applied).toEqual([true, false])
    expect(v.shown()).toBe(false)
  })
})

describe('quitting mid-recording', () => {
  const quitEvent = (prevented = false) => {
    const e = { defaultPrevented: prevented, preventDefault: () => (e.defaultPrevented = true) }
    return e
  }
  const setup = (o: { live?: boolean; updating?: boolean; stop?: () => Promise<void> } = {}) => {
    const calls = { stop: 0, quit: 0 }
    let live = o.live ?? true
    const hold = quitSaver({
      live: () => live,
      stop: async () => {
        calls.stop++
        await (o.stop?.() ?? Promise.resolve())
        live = false
      },
      updating: () => o.updating ?? false,
      quit: () => calls.quit++,
      timeoutMs: 120_000,
    })
    return { hold, calls }
  }

  it('holds the quit, saves the recording, then quits again; a second ⌘Q waits for the same save', async () => {
    let finish!: () => void
    const { hold, calls } = setup({ stop: () => new Promise<void>((r) => (finish = r)) })
    const first = quitEvent()
    hold(first)
    expect(first.defaultPrevented).toBe(true)
    const again = quitEvent()
    hold(again)
    expect(again.defaultPrevented).toBe(true)
    expect(calls.stop).toBe(1)
    finish()
    await vi.runAllTimersAsync()
    expect(calls.quit).toBe(1)
    const last = quitEvent()
    hold(last)
    expect(last.defaultPrevented).toBe(false)
  })

  it('lets a quit through with nothing recording, during an update, or held by someone else', () => {
    for (const s of [setup({ live: false }), setup({ updating: true })]) {
      const e = quitEvent()
      s.hold(e)
      expect(e.defaultPrevented).toBe(false)
      expect(s.calls.stop).toBe(0)
    }
    const held = setup()
    held.hold(quitEvent(true))
    expect(held.calls.stop).toBe(0)
  })

  it('quits anyway when saving takes longer than the limit', async () => {
    const { hold, calls } = setup({ stop: () => new Promise<void>(() => undefined) })
    hold(quitEvent())
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls.quit).toBe(1)
  })
})
