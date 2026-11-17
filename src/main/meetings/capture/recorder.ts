/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EventEmitter } from 'node:events'
import { DESKTOP_CALL_APPS } from '@shared/desktopCalls'
import { currentLocale } from '@shared/i18n/core'
import { detectMeeting, type CaptureStartOptions, type CaptureState, type CaptureStatus, type MeetingRecorder, type WrapUp } from '@shared/meetingCapture'
import { audioOnlyFallback, type AudioOnlyReason, type MeetingStore, type MeetingSummarizer, type MeetingWarning } from '@shared/meetings'
import {
  SpeechError,
  type SpeechBroker,
  type SpeechErrorCode,
  type SpeechSession,
  type SpeechSessionEvent,
  type SpeechSource,
  type SpeechStopResult,
  type TranscriptionSettings,
} from '@shared/speech'
import { EngineUnavailableError } from '../../agent/quick'
import { mainT } from '../../i18n/mainT'

// The meeting recorder (MV-10, MV-11). One meeting at a time:
// store.create, a broker session in meeting mode, finals into the store and
// partials as the live line, pause and resume with the pauses left out of
// the elapsed time, then store.finish and the summary. It also asks whether
// to go on after two hours or ten silent minutes, stopping by itself when
// nobody answers, and keeps the wrap-up card's state. With Record audio only,
// or when this Mac can't transcribe (Speech Recognition off, a language it
// doesn't support), it records the audio alone instead: no transcript and no
// summary, and the meeting can be transcribed later.

export const LONG_RECORDING_MS = 2 * 60 * 60_000
export const SILENCE_MS = 10 * 60_000
export const CONTINUE_COUNTDOWN_MS = 60_000
export const WATCH_INTERVAL_MS = 15_000
/** A level peak above this counts as sound for the silence check. */
export const SOUND_PEAK = 0.02

export interface RecorderDeps {
  broker: SpeechBroker
  store: MeetingStore
  summarizer: MeetingSummarizer
  transcription(): TranscriptionSettings
  systemLocale(): string
  /** An Atelier window is in front; meetings notifications go out only when none is. */
  appInView(): boolean
  /** A `meetings` notification (ctx.notify). */
  notify(n: { title: string; body?: string; target?: string }): void
  /** ctx.signal('meeting-transcribed'), the first time a meeting finishes. */
  transcribed(): void
  smoke?: boolean
  now?(): number
  warn?(message: string, data?: Record<string, string | number | boolean | null>): void
}

export interface ContinueQuestion {
  reason: 'long' | 'silent'
  /** When it stops by itself. */
  deadline: number
}

type RecorderEvents = {
  status: [status: CaptureStatus]
  level: [level: { source: SpeechSource; rms: number; peak: number }]
  'wrap-up': [wrapUp: WrapUp | null]
  ask: [question: ContinueQuestion | null]
}

/** Whether a recording should ask to go on: past the next two-hour mark, or silent for ten minutes. Pure. */
export function continueReason(s: { state: CaptureState; elapsedMs: number; nextLongAtMs: number; lastSoundAt: number; now: number }): 'long' | 'silent' | null {
  if (s.state !== 'recording' && s.state !== 'paused') return null
  if (s.elapsedMs >= s.nextLongAtMs) return 'long'
  // A pause is a choice, not silence.
  if (s.state === 'recording' && s.now - s.lastSoundAt >= SILENCE_MS) return 'silent'
  return null
}

const LIVE: readonly CaptureState[] = ['starting', 'recording', 'paused', 'stopping']

function errorCode(err: unknown): SpeechErrorCode {
  return err instanceof SpeechError ? err.code : 'helper-failed'
}

function defaultTitle(kind: CaptureStartOptions['kind'], at: number): string {
  let date: string
  try {
    date = new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at)
  } catch {
    date = new Date(at).toISOString().slice(0, 16).replace('T', ' ')
  }
  return mainT(kind === 'meeting' ? 'capture.title.meeting' : 'capture.title.recording', { date })
}

export class Recorder extends EventEmitter<RecorderEvents> implements MeetingRecorder {
  readonly #deps: RecorderDeps
  #state: CaptureState = 'idle'
  #meetingId: string | null = null
  #title = ''
  #startedAt: number | null = null
  /** Elapsed time banked before the current run (pauses left out). */
  #banked = 0
  #runningSince: number | null = null
  #systemAudio = false
  #origin: CaptureStatus['origin'] = { tabId: null, url: null }
  #warnings = new Set<MeetingWarning>()
  #pausedBy: 'user' | 'lid' | null = null
  #audioOnly: AudioOnlyReason | null = null
  #session: SpeechSession | null = null
  #unsubscribe: (() => void) | null = null
  #live: Partial<Record<SpeechSource, string>> = {}
  #lastSoundAt = 0
  #nextLongAtMs = LONG_RECORDING_MS
  #ask: ContinueQuestion | null = null
  #askTimer: ReturnType<typeof setTimeout> | null = null
  #watch: ReturnType<typeof setInterval> | null = null
  #starting: Promise<string> | null = null
  #stopping: Promise<void> | null = null
  #wrapUp: WrapUp | null = null

  constructor(deps: RecorderDeps) {
    super()
    this.#deps = deps
    try {
      deps.store.on('changed', (id) => this.#onStoreChanged(id))
    } catch {
      // The library's store isn't there yet (a stub stands in); the wrap-up then follows the summary request alone.
    }
  }

  status(): CaptureStatus {
    return {
      state: this.#state,
      meetingId: this.#meetingId,
      startedAt: this.#startedAt,
      elapsedMs: this.#elapsed(),
      systemAudio: this.#systemAudio,
      origin: { ...this.#origin },
      warnings: [...this.#warnings],
      pausedBy: this.#pausedBy,
      audioOnly: this.#audioOnly,
    }
  }

  wrapUp(): WrapUp | null {
    return this.#wrapUp ? { ...this.#wrapUp } : null
  }

  question(): ContinueQuestion | null {
    return this.#ask ? { ...this.#ask } : null
  }

  /** Starting, recording, paused or stopping: the helper is (or is about to be) held. */
  isLive(): boolean {
    return LIVE.includes(this.#state)
  }

  async start(o: CaptureStartOptions): Promise<string> {
    // A second start while the first still checks permissions is as busy as a running one.
    if (this.isLive() || this.#starting) throw new SpeechError('busy', mainT('capture.error.busy'), 'meeting')
    const run = this.#begin(o)
    this.#starting = run
    try {
      return await run
    } finally {
      if (this.#starting === run) this.#starting = null
    }
  }

  stop(): Promise<void> {
    return this.#stop('user')
  }

  pause(by: 'user' | 'lid' = 'user'): void {
    if (this.#state !== 'recording' || !this.#session) return
    try {
      this.#session.pause()
    } catch (err) {
      this.#deps.warn?.('Pausing the recording failed', { error: String(err) })
      return
    }
    this.#bank()
    this.#state = 'paused'
    this.#pausedBy = by
    this.#emitStatus()
  }

  resume(by: 'user' | 'lid' = 'user'): void {
    if (this.#state !== 'paused' || !this.#session) return
    // The lid opening never undoes a pause the person chose.
    if (by === 'lid' && this.#pausedBy !== 'lid') return
    try {
      this.#session.resume()
    } catch (err) {
      this.#deps.warn?.('Resuming the recording failed', { error: String(err) })
      return
    }
    const now = this.#now()
    this.#runningSince = now
    this.#lastSoundAt = now
    this.#state = 'recording'
    this.#pausedBy = null
    this.#emitStatus()
  }

  /** Answers the continue question; nobody answering stops it (with `auto`). */
  answer(choice: 'continue' | 'stop', auto = false): void {
    const ask = this.#ask
    if (!ask) return
    this.#clearAsk()
    if (choice === 'continue') {
      if (ask.reason === 'long') this.#nextLongAtMs = this.#elapsed() + LONG_RECORDING_MS
      else this.#lastSoundAt = this.#now()
      return
    }
    void this.#stop(auto ? ask.reason : 'user').catch((err: unknown) => this.#deps.warn?.('Stopping the recording failed', { error: String(err) }))
  }

  dismissWrapUp(): void {
    this.#setWrapUp(null)
  }

  /** For tests and smoke: handles `e` as if the session had sent it. */
  feed(e: SpeechSessionEvent): void {
    if (this.#session) this.#onEvent(e)
  }

  /** Releases timers and the helper session (app quit). */
  dispose(): void {
    this.#clearAsk()
    this.#stopWatch()
    if (this.#session && this.#meetingId) {
      // Quitting mid-meeting: keep what was heard, as the library's crash recovery would.
      this.#bank()
      const id = this.#meetingId
      const session = this.#session
      this.#detach()
      try {
        session.cancel()
      } catch {
        // The helper is going away anyway.
      }
      this.#safe(() => this.#deps.store.finish(id, { endedAt: this.#now(), durationMs: this.#banked, audio: null, status: this.#audioOnly ? 'recorded' : 'transcribed' }))
    }
    this.removeAllListeners()
  }

  // ── lifecycle ──

  async #begin(o: CaptureStartOptions): Promise<string> {
    const { broker, store } = this.#deps
    const speech = broker.status()
    if (!speech.available) throw new SpeechError(speech.reason ?? 'helper-missing', mainT('capture.error.unavailable'))
    if (speech.active) throw new SpeechError('busy', mainT('capture.error.busy'), speech.active.purpose)
    const settings = this.#deps.transcription()
    // Every start is something you clicked, so a permission macOS never asked about is asked for
    // here (microphone first, then speech unless only audio is wanted). Without the microphone
    // nothing can be recorded; without speech recognition the meeting is recorded as audio only.
    const audioWanted = settings.recordOnly || o.audioOnly === true
    let permissions = await broker.permissions().catch(() => null)
    for (const what of audioWanted ? (['microphone'] as const) : (['microphone', 'speech'] as const)) {
      if (permissions?.[what] === 'not-determined') permissions = await broker.request(what).catch(() => permissions)
    }
    if (permissions?.microphone && permissions.microphone !== 'granted') throw new SpeechError('mic-denied')
    // Off for Atelier; one never asked about (a prompt that couldn't show) is tried, and the start says if it's off.
    const speechOff = permissions?.speech === 'denied' || permissions?.speech === 'restricted'
    const audioOnly: AudioOnlyReason | null = settings.recordOnly ? 'chosen' : speechOff ? 'speech-denied' : audioWanted ? 'chosen' : null
    if (this.isLive()) throw new SpeechError('busy', mainT('capture.error.busy'), 'meeting')

    const now = this.#now()
    const detected = o.url ? detectMeeting(o.url, { smoke: this.#deps.smoke }) : null
    const title = (o.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || detected?.title || defaultTitle(o.kind, now)
    this.#reset()
    this.#state = 'starting'
    this.#origin = { tabId: o.tabId ?? null, url: o.url ?? null }
    this.#title = title
    this.#audioOnly = audioOnly
    this.#setWrapUp(null)
    this.#emitStatus()

    let id: string
    try {
      const provider = detected?.provider ?? (o.call ? DESKTOP_CALL_APPS[o.call.app].provider : null)
      id = store.create({ kind: o.kind, title, url: o.url ?? null, provider, locale: settings.locale ?? this.#deps.systemLocale(), startedAt: now, recordAudio: settings.recordAudio, audioOnly }).id
    } catch (err) {
      this.#toIdle()
      throw err
    }
    this.#meetingId = id
    this.#startedAt = now

    const begin = (transcribe: boolean): Promise<SpeechSession> =>
      broker.begin({
        purpose: 'meeting',
        mode: 'meeting',
        locale: settings.locale,
        // Audio only always keeps the audio: it is the meeting.
        record: settings.recordAudio || !transcribe ? store.audioPathFor(id) : null,
        transcribe,
        levels: true,
        // A desktop call records only that app's sound as the other side.
        ...(o.call?.audio.length ? { apps: o.call.audio } : {}),
      })
    let session: SpeechSession
    try {
      try {
        session = await begin(!this.#audioOnly)
      } catch (err) {
        // This Mac can't transcribe it (the language, or speech recognition): record the audio instead.
        const fallback = !this.#audioOnly && err instanceof SpeechError ? audioOnlyFallback(err.code) : null
        if (!fallback) throw err
        this.#deps.warn?.('Transcription is unavailable; recording audio only', { code: fallback })
        this.#audioOnly = fallback
        this.#safe(() => store.setAudioOnly(id, fallback))
        this.#emitStatus()
        session = await begin(false)
      }
    } catch (err) {
      this.#safe(() => store.finish(id, { endedAt: this.#now(), durationMs: 0, audio: null, status: 'failed', error: errorCode(err) }))
      this.#toIdle()
      throw err
    }
    this.#session = session
    this.#unsubscribe = session.on((e) => this.#onEvent(e))
    const started = this.#now()
    this.#state = 'recording'
    this.#runningSince = started
    this.#lastSoundAt = started
    this.#startWatch()
    this.#emitStatus()
    return id
  }

  async #stop(reason: 'user' | 'long' | 'silent'): Promise<void> {
    if (this.#starting) await this.#starting.catch(() => undefined)
    if (this.#stopping) return this.#stopping
    if (this.#state !== 'recording' && this.#state !== 'paused') return
    const run = this.#doStop(reason)
    this.#stopping = run
    try {
      await run
    } finally {
      if (this.#stopping === run) this.#stopping = null
    }
  }

  async #doStop(reason: 'user' | 'long' | 'silent'): Promise<void> {
    const id = this.#meetingId
    const session = this.#session
    if (!id || !session) return
    this.#bank()
    this.#clearAsk()
    this.#stopWatch()
    this.#state = 'stopping'
    this.#pausedBy = null
    // MV-11: the widget grows into the wrap-up, processing first.
    this.#setWrapUp({ meetingId: id, title: this.#title, phase: 'processing', audioOnly: this.#audioOnly })
    this.#emitStatus()
    let result: SpeechStopResult
    try {
      result = await session.stop()
    } catch (err) {
      this.#fail(errorCode(err))
      return
    }
    this.#finish(id, result, reason)
  }

  #finish(id: string, result: SpeechStopResult, reason: 'user' | 'long' | 'silent' | 'helper'): void {
    this.#detach()
    const audioOnly = this.#audioOnly
    this.#safe(() => this.#deps.store.finish(id, { endedAt: this.#now(), durationMs: this.#banked, audio: result.audio, status: audioOnly ? 'recorded' : 'transcribed' }))
    if (!audioOnly) this.#deps.transcribed()
    this.#state = 'processing'
    if (!this.#wrapUp || this.#wrapUp.meetingId !== id) this.#setWrapUp({ meetingId: id, title: this.#title, phase: 'processing', audioOnly })
    this.#emitStatus()
    if ((reason === 'long' || reason === 'silent') && !this.#deps.appInView()) {
      this.#deps.notify({
        title: mainT('capture.notify.stoppedTitle'),
        body: mainT(reason === 'long' ? 'capture.notify.stoppedLong' : 'capture.notify.stoppedSilent'),
        target: `atelier://meetings/${id}`,
      })
    }
    void this.#summarize(id)
  }

  async #summarize(id: string): Promise<void> {
    const { store, summarizer } = this.#deps
    if (this.#audioOnly) {
      // Nothing to summarise: the card says the recording is saved (or that it failed without its audio).
      const saved = this.#safe(() => store.get(id))?.status === 'recorded'
      this.#updateWrapUp(id, saved ? { phase: 'ready', summarized: false, audioOnly: this.#audioOnly } : { phase: 'failed', error: 'recording-failed' })
      this.#settle(id)
      return
    }
    if (!this.#deps.transcription().autoSummarize) {
      this.#updateWrapUp(id, { phase: 'ready', summarized: false })
      this.#settle(id)
      return
    }
    try {
      // The library also summarises on finish; this request joins that one.
      await summarizer.request(id)
      const detail = this.#safe(() => store.get(id))
      if (detail?.status === 'summary-pending') {
        this.#updateWrapUp(id, { phase: 'no-engine' })
      } else if (detail?.status === 'summarized') {
        this.#updateWrapUp(id, { phase: 'ready', summarized: true, title: detail.title })
        if (!this.#deps.appInView()) this.#deps.notify({ title: mainT('capture.notify.summaryTitle'), body: mainT('capture.notify.summaryBody', { title: detail.title }), target: `atelier://meetings/${id}` })
      } else {
        this.#updateWrapUp(id, { phase: 'ready', summarized: false })
      }
    } catch (err) {
      if (err instanceof EngineUnavailableError) this.#updateWrapUp(id, { phase: 'no-engine' })
      else {
        // The transcript is safe; Summarise in Meetings tries again.
        this.#deps.warn?.('Summarising the meeting failed', { error: String(err) })
        this.#updateWrapUp(id, { phase: 'ready', summarized: false })
      }
    }
    this.#settle(id)
  }

  #fail(code: SpeechErrorCode): void {
    const id = this.#meetingId
    const session = this.#session
    this.#bank()
    this.#detach()
    this.#clearAsk()
    this.#stopWatch()
    try {
      session?.cancel()
    } catch {
      // Already gone.
    }
    if (id) {
      this.#safe(() => this.#deps.store.finish(id, { endedAt: this.#now(), durationMs: this.#banked, audio: null, status: 'failed', error: code }))
      this.#setWrapUp({ meetingId: id, title: this.#title, phase: 'failed', error: code, audioOnly: this.#audioOnly })
      if (!this.#deps.appInView()) this.#deps.notify({ title: mainT('capture.notify.failedTitle'), body: mainT(this.#audioOnly ? 'capture.notify.failedAudioBody' : 'capture.notify.failedBody'), target: `atelier://meetings/${id}` })
    }
    this.#toIdle()
  }

  #onEvent(e: SpeechSessionEvent): void {
    const id = this.#meetingId
    if (!id) return
    const { store } = this.#deps
    switch (e.type) {
      case 'partial':
        this.#live = { ...this.#live, [e.source]: e.text }
        this.#safe(() => store.setLive(id, { ...this.#live }))
        this.#lastSoundAt = this.#now()
        return
      case 'final': {
        if (e.text.trim()) this.#safe(() => store.appendSegment(id, { source: e.source, text: e.text, startMs: e.startMs, endMs: e.endMs }))
        const live = { ...this.#live }
        delete live[e.source]
        this.#live = live
        this.#safe(() => store.setLive(id, { ...live }))
        this.#lastSoundAt = this.#now()
        return
      }
      case 'level':
        if (e.peak >= SOUND_PEAK) this.#lastSoundAt = this.#now()
        this.emit('level', { source: e.source, rms: e.rms, peak: e.peak })
        return
      case 'started':
        this.#systemAudio = e.systemAudio
        if (!e.systemAudio) this.#warn('screen-missing')
        if (e.fallbackDevice) this.#warn('device-fallback')
        this.#emitStatus()
        break
      case 'warning':
        this.#warn(e.code)
        break
      case 'interrupted':
        this.#warn('interrupted')
        break
      case 'restored':
        // The store keeps the warning; the widget stops saying "reconnecting".
        if (this.#warnings.delete('interrupted')) this.#emitStatus()
        break
      case 'error':
        if (e.fatal) {
          this.#fail(e.code)
          return
        }
        this.#deps.warn?.('The speech helper reported a problem', { code: e.code })
        break
      case 'stopped':
        // The helper ended the session on its own (stop() handles its own reply).
        if (this.#state === 'recording' || this.#state === 'paused') {
          this.#bank()
          this.#clearAsk()
          this.#stopWatch()
          this.#finish(id, { durationMs: e.durationMs, audio: e.audio }, 'helper')
        }
        return
      default:
        break
    }
  }

  #onStoreChanged(id: string): void {
    const wrap = this.#wrapUp
    if (!wrap || wrap.meetingId !== id || wrap.phase === 'failed' || this.isLive()) return
    const detail = this.#safe(() => this.#deps.store.get(id))
    if (!detail) return
    // An audio-only recording transcribed while its card is up becomes an ordinary meeting's card.
    const transcribed: Partial<WrapUp> = wrap.audioOnly && !detail.audioOnly ? { audioOnly: null } : {}
    if (detail.status === 'summarizing') this.#updateWrapUp(id, { ...transcribed, phase: 'processing' })
    else if (detail.status === 'summarized') this.#updateWrapUp(id, { ...transcribed, phase: 'ready', summarized: true, title: detail.title })
    else if (detail.status === 'summary-pending') this.#updateWrapUp(id, { ...transcribed, phase: 'no-engine' })
    else if (detail.status === 'transcribed' && transcribed.audioOnly === null) this.#updateWrapUp(id, { ...transcribed, phase: 'ready', summarized: false })
  }

  // ── the continue question ──

  #startWatch(): void {
    this.#stopWatch()
    this.#watch = setInterval(() => this.#check(), WATCH_INTERVAL_MS)
    this.#watch.unref?.()
  }

  #stopWatch(): void {
    if (this.#watch) clearInterval(this.#watch)
    this.#watch = null
  }

  #check(): void {
    if (this.#ask) return
    const reason = continueReason({ state: this.#state, elapsedMs: this.#elapsed(), nextLongAtMs: this.#nextLongAtMs, lastSoundAt: this.#lastSoundAt, now: this.#now() })
    if (!reason) return
    this.#ask = { reason, deadline: this.#now() + CONTINUE_COUNTDOWN_MS }
    this.#askTimer = setTimeout(() => this.answer('stop', true), CONTINUE_COUNTDOWN_MS)
    this.emit('ask', { ...this.#ask })
  }

  #clearAsk(): void {
    if (this.#askTimer) clearTimeout(this.#askTimer)
    this.#askTimer = null
    if (!this.#ask) return
    this.#ask = null
    this.emit('ask', null)
  }

  // ── state helpers ──

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  #elapsed(): number {
    return this.#banked + (this.#runningSince !== null ? Math.max(0, this.#now() - this.#runningSince) : 0)
  }

  #bank(): void {
    this.#banked = this.#elapsed()
    this.#runningSince = null
  }

  #warn(w: MeetingWarning): void {
    if (this.#warnings.has(w)) return
    this.#warnings.add(w)
    const id = this.#meetingId
    if (id) this.#safe(() => this.#deps.store.warn(id, w))
    this.#emitStatus()
  }

  #detach(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#session = null
    this.#live = {}
  }

  #settle(id: string): void {
    if (this.#state === 'processing' && this.#meetingId === id) this.#toIdle()
  }

  #reset(): void {
    this.#clearAsk()
    this.#stopWatch()
    this.#detach()
    this.#state = 'idle'
    this.#meetingId = null
    this.#title = ''
    this.#startedAt = null
    this.#banked = 0
    this.#runningSince = null
    this.#systemAudio = false
    this.#origin = { tabId: null, url: null }
    this.#warnings = new Set()
    this.#pausedBy = null
    this.#audioOnly = null
    this.#nextLongAtMs = LONG_RECORDING_MS
  }

  #toIdle(): void {
    this.#reset()
    this.#emitStatus()
  }

  #setWrapUp(next: WrapUp | null): void {
    this.#wrapUp = next
    this.emit('wrap-up', next ? { ...next } : null)
  }

  #updateWrapUp(id: string, patch: Partial<WrapUp>): void {
    const wrap = this.#wrapUp
    if (!wrap || wrap.meetingId !== id) return
    const next = { ...wrap, ...patch }
    if (next.phase === wrap.phase && next.summarized === wrap.summarized && next.title === wrap.title && (next.audioOnly ?? null) === (wrap.audioOnly ?? null)) return
    this.#setWrapUp(next)
  }

  #emitStatus(): void {
    this.emit('status', this.status())
  }

  #safe<T>(fn: () => T): T | null {
    try {
      return fn()
    } catch (err) {
      this.#deps.warn?.('The meetings store refused an update', { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  }
}
