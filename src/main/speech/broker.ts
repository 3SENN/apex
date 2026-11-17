/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import {
  SessionClock,
  SpeechError,
  clampSensitivity,
  normalizeLocaleId,
  parseVocabulary,
  resolveLocale,
  resolveMic,
  secondLocale,
  type AudioInputDevice,
  type HelperLine,
  type PermissionKind,
  type SpeechAssets,
  type SpeechBeginOptions,
  type SpeechBroker,
  type SpeechLocale,
  type SpeechLocaleList,
  type SpeechMode,
  type SpeechPermissions,
  type SpeechPurpose,
  type SpeechSession,
  type SpeechSessionEvent,
  type SpeechStatus,
  type SpeechStopResult,
  type TranscriptionSettings,
} from '@shared/speech'
import type { HelperLink } from './helper'
import { lineSession } from './protocol'
import { BilingualMerger } from './bilingual'

// The SpeechBroker: the one helper has one session at a time, and every
// feature that listens (dictation, voice, the launcher, meetings, the level
// test, file transcription) goes through here. A second start is refused
// with a `busy` error naming the holder. Events fan out to the session that
// owns them. The microphone, vocabulary and gains come from
// settings.transcription at each start, so changes apply from the next one.

export interface BrokerDeps {
  link: HelperLink
  platform: NodeJS.Platform
  settings(): TranscriptionSettings
  /** How long the helper has to say `started` (it never prompts, so this is short). */
  startTimeoutMs?: number
  /** How long a stop may take: the recording is merged and compressed first. */
  stopTimeoutMs?: number
  /** How long a reply to a quick question (permissions, devices, locales) may take. */
  replyTimeoutMs?: number
  now?: () => number
  /** Whether Apex has asked for Screen Recording (macOS can't say "never asked"; ./screenAccess). */
  screenPrompt?: { asked(): boolean; markAsked(): void }
  /** The Mac's preferred languages, in order: bilingual meetings' Automatic second language. */
  preferredLanguages?(): string[]
}

/** Main-only extras the speech feature uses; other features see the SpeechBroker contract. */
export interface SpeechBrokerHost extends SpeechBroker {
  onStatus(fn: (status: SpeechStatus) => void): () => void
  onPermissions(fn: (permissions: SpeechPermissions) => void): () => void
  /** Each session begun, as it starts (the feature forwards chrome-owned ones to the UI). */
  onSession(fn: (session: SpeechSession, mode: SpeechMode) => void): () => void
  /** B:transcription engine: the newer engine's model for the transcription language; `install` starts installing it. */
  assets(o?: { install?: boolean }): Promise<SpeechAssets>
  /** Every model state the helper reports: an install's progress, then installed or failed. */
  onAssets(fn: (assets: SpeechAssets) => void): () => void
  dispose(): void
}

type Started = Extract<HelperLine, { type: 'started' }>

/** A prompt is answered by a person, so a permission request waits this long. */
const PROMPT_TIMEOUT_MS = 5 * 60_000
/** Events kept for a session nobody listens to yet. */
const BACKLOG_MAX = 200

interface SessionControl {
  send(cmd: 'pause' | 'resume' | 'stop'): void
  /** The session finished (stopped, failed or timed out). */
  ended(s: BrokerSession): void
  /** Something the status shows changed (a cancel). */
  changed(): void
  /** A stop got no answer: the helper is restarted. */
  stuck(): void
  stopTimeoutMs: number
}

class BrokerSession implements SpeechSession {
  readonly id: string
  readonly purpose: SpeechPurpose
  readonly mode: SpeechMode
  readonly clock: SessionClock
  readonly record: string | null
  #listeners = new Set<(e: SpeechSessionEvent) => void>()
  /** Events that arrive before anyone listens (the `started` line and its warnings). */
  #backlog: SpeechSessionEvent[] = []
  /** The backlog on its way to the first listener; later events queue behind it. */
  #pending: SpeechSessionEvent[] | null = null
  #result: SpeechStopResult | null = null
  #stopWaiters: Array<(r: SpeechStopResult) => void> = []
  #stopSent = false
  cancelled = false
  readonly #control: SessionControl

  constructor(o: { id: string; purpose: SpeechPurpose; mode: SpeechMode; record: string | null; now: () => number; control: SessionControl }) {
    this.id = o.id
    this.purpose = o.purpose
    this.mode = o.mode
    this.record = o.record
    this.clock = new SessionClock(o.now)
    this.#control = o.control
  }

  get ended(): boolean {
    return this.#result !== null
  }

  on(fn: (e: SpeechSessionEvent) => void): () => void {
    this.#listeners.add(fn)
    if (this.#backlog.length && !this.#pending) {
      this.#pending = this.#backlog
      this.#backlog = []
      // After on() returns, so the caller has its unsubscribe first.
      queueMicrotask(() => {
        const pending = this.#pending ?? []
        this.#pending = null
        for (const event of pending) this.#dispatch(event)
      })
    }
    return () => this.#listeners.delete(fn)
  }

  emit(event: SpeechSessionEvent): void {
    if (this.cancelled) return
    if (this.#pending) {
      this.#pending.push(event)
      return
    }
    if (!this.#listeners.size) {
      if (this.#backlog.length < BACKLOG_MAX) this.#backlog.push(event)
      return
    }
    this.#dispatch(event)
  }

  #dispatch(event: SpeechSessionEvent): void {
    if (this.cancelled) return
    for (const fn of [...this.#listeners]) {
      try {
        fn(event)
      } catch {
        // One listener's failure never starves the others.
      }
    }
  }

  stop(): Promise<SpeechStopResult> {
    if (this.#result) return Promise.resolve(this.#result)
    const done = new Promise<SpeechStopResult>((resolve) => this.#stopWaiters.push(resolve))
    this.#sendStop()
    return done
  }

  /** Sends stop once, with a deadline: a helper that never says `stopped` is restarted. */
  #sendStop(): void {
    if (this.#stopSent) return
    this.#stopSent = true
    this.#control.send('stop')
    const timer = setTimeout(() => {
      if (this.ended) return
      this.finish({ durationMs: this.clock.elapsed(), audio: null })
      this.#control.stuck()
    }, this.#control.stopTimeoutMs)
    timer.unref?.()
  }

  pause(): void {
    if (this.ended || this.clock.paused) return
    this.#control.send('pause')
  }

  resume(): void {
    if (this.ended || !this.clock.paused) return
    this.#control.send('resume')
  }

  cancel(): void {
    if (this.ended || this.cancelled) return
    this.cancelled = true
    this.#backlog = []
    this.#sendStop()
    this.#control.changed()
  }

  /** Ends the session once; later stops resolve with the same result. */
  finish(result: SpeechStopResult): void {
    if (this.#result) return
    this.#result = result
    for (const resolve of this.#stopWaiters.splice(0)) resolve(result)
    this.#control.ended(this)
  }
}

export function createSpeechBroker(deps: BrokerDeps): SpeechBrokerHost {
  const { link } = deps
  const now = deps.now ?? Date.now
  const startTimeoutMs = deps.startTimeoutMs ?? 15_000
  const stopTimeoutMs = deps.stopTimeoutMs ?? 120_000
  const replyTimeoutMs = deps.replyTimeoutMs ?? 5_000
  /** Merging a long call's parts back together takes a while (about 45 s for two hours of both sides). */
  const recoverTimeoutMs = 300_000
  const statusListeners = new Set<(s: SpeechStatus) => void>()
  const permissionListeners = new Set<(p: SpeechPermissions) => void>()
  const sessionListeners = new Set<(s: SpeechSession, mode: SpeechMode) => void>()
  const lineListeners = new Set<(line: HelperLine) => void>()
  /** The helper's one session; a cancelled one stays here until the helper lets go of it. */
  let active: BrokerSession | null = null
  let lastPermissions: SpeechPermissions | null = null
  let requesting = 0
  let locales: SpeechLocaleList | null = null
  // Bilingual sessions: their lines go through a merger that keeps, per stretch, the language that fits.
  const mergers = new WeakMap<BrokerSession, BilingualMerger>()
  // Only the macOS helper listens in two languages; Windows' (native/speech-win) hears one, and a file's lines
  // would wait in a merger for a second language that never comes.
  const bilingual = deps.platform === 'darwin'
  const tickers = new WeakMap<BrokerSession, NodeJS.Timeout>()
  const stopMerging = (s: BrokerSession): void => {
    const ticker = tickers.get(s)
    if (ticker) clearInterval(ticker)
    tickers.delete(s)
  }
  let lastStatus = ''

  function status(): SpeechStatus {
    // macOS and Windows each have a helper (native/speech, native/speech-win); Linux has none.
    const reason: SpeechStatus['reason'] =
      deps.platform !== 'darwin' && deps.platform !== 'win32' ? 'unsupported-platform' : link.state === 'missing' ? 'helper-missing' : link.state === 'outdated' ? 'helper-outdated' : null
    const shown = active && !active.cancelled ? active : null
    return { available: reason === null, reason, active: shown ? { id: shown.id, purpose: shown.purpose, mode: shown.mode } : null }
  }

  function emitStatus(): void {
    const next = status()
    const key = JSON.stringify(next)
    if (key === lastStatus) return
    lastStatus = key
    for (const fn of statusListeners) fn(next)
  }

  function notePermissions(p: SpeechPermissions): SpeechPermissions {
    lastPermissions = p
    for (const fn of permissionListeners) fn(p)
    return p
  }

  function unavailable(): SpeechError | null {
    const s = status()
    return s.reason ? new SpeechError(s.reason, s.reason === 'unsupported-platform' ? 'Speech recognition needs macOS or Windows.' : `Speech recognition is not available (${s.reason}).`) : null
  }

  function send(cmd: 'pause' | 'resume' | 'stop'): void {
    try {
      link.send({ cmd })
    } catch {
      // The helper is gone; its exit ends the session.
    }
  }

  function ended(s: BrokerSession): void {
    if (active === s) active = null
    // A cancelled recording is thrown away.
    if (s.cancelled && s.record) void rm(s.record, { force: true }).catch(() => undefined)
    emitStatus()
  }

  function newSession(o: { purpose: SpeechPurpose; mode: SpeechMode; record: string | null }): BrokerSession {
    return new BrokerSession({ id: randomUUID(), ...o, now, control: { send, ended, changed: emitStatus, stuck: () => link.recycle(), stopTimeoutMs } })
  }

  /** Refuses a start while the helper is unavailable or held (SpeechError 'busy' names the holder). */
  async function claim(): Promise<void> {
    const blocked = unavailable()
    if (blocked) throw blocked
    // A cancelled session gets a moment to finish before it counts as busy.
    const cancelled = active?.cancelled ? active : null
    if (cancelled) await Promise.race([cancelled.stop(), new Promise((r) => setTimeout(r, 3_000).unref?.())])
    if (active) throw new SpeechError('busy', active.cancelled ? 'The last recording is still finishing.' : 'Another recording is already running.', active.purpose)
  }

  // Lines for the active session fan out to it; every line goes to onLine listeners (for the `lid` lines).
  link.on('line', (line) => {
    for (const fn of lineListeners) fn(line)
    const s = active
    if (!s || lineSession(line) !== s.id) return
    const { session: _session, ...event } = line as Extract<HelperLine, { session: string }>
    const merger = mergers.get(s)
    for (const e of merger ? merger.push(event as SpeechSessionEvent, now()) : [event as SpeechSessionEvent]) {
      if (e.type === 'paused') s.clock.pause()
      if (e.type === 'resumed') s.clock.resume()
      s.emit(e)
      if (e.type === 'stopped') {
        stopMerging(s)
        s.finish({ durationMs: e.durationMs, audio: e.audio })
      } else if (e.type === 'error' && e.fatal) {
        stopMerging(s)
        s.finish({ durationMs: s.clock.elapsed(), audio: null })
      }
    }
  })

  /** Bilingual from here on: the helper listens in both languages. Live sessions settle waiting lines every second. */
  function merge(s: BrokerSession, primary: string, secondary: string, live: boolean): void {
    mergers.set(s, new BilingualMerger(primary, secondary, live ? {} : { settleMs: null }))
    if (!live) return
    const ticker = setInterval(() => {
      const merger = mergers.get(s)
      if (!merger || active !== s) return stopMerging(s)
      for (const e of merger.settle(now())) s.emit(e)
    }, 1_000)
    ticker.unref?.()
    tickers.set(s, ticker)
  }

  // The helper died: the session ends with helper-failed (the link restarts it once).
  link.on('exit', () => {
    locales = null
    const s = active
    if (s) {
      s.emit({ type: 'error', code: 'helper-failed', message: 'The speech helper stopped unexpectedly.', fatal: true })
      s.finish({ durationMs: s.clock.elapsed(), audio: null })
    }
    emitStatus()
  })
  link.on('state', () => emitStatus())

  // ── B:transcription engine ── the newer engine's language models (Models.swift).
  const assetListeners = new Set<(a: SpeechAssets) => void>()
  link.on('line', (line) => {
    if (line.type !== 'assets') return
    const a: SpeechAssets = { locale: normalizeLocaleId(line.locale), state: line.state, fraction: line.fraction }
    // A model now on this Mac changes which languages count as on-device, so the list is asked again.
    if (a.state === 'installed') locales = null
    for (const fn of assetListeners) fn(a)
  })

  /** The model state for the transcription language; a helper without the newer engine (or too old to know `prepare`) says unavailable. */
  async function assets(o: { install?: boolean } = {}): Promise<SpeechAssets> {
    const settings = deps.settings()
    const fallback = normalizeLocaleId(settings.locale ?? 'en-US')
    if (unavailable()) return { locale: fallback, state: 'unavailable', fraction: null }
    let locale: string
    try {
      locale = await pickLocale(null, settings)
    } catch (err) {
      if (err instanceof SpeechError && err.code === 'locale-unsupported') return { locale: fallback, state: 'unsupported', fraction: null }
      throw err
    }
    const want = locale.toLowerCase()
    try {
      const line = await link.request(
        { cmd: 'prepare', locale, install: o.install ?? false },
        (l): l is Extract<HelperLine, { type: 'assets' }> => l.type === 'assets' && normalizeLocaleId(l.locale).toLowerCase() === want,
        replyTimeoutMs,
      )
      return { locale, state: line.state, fraction: line.fraction }
    } catch {
      return { locale, state: 'unavailable', fraction: null }
    }
  }

  // Desktop calls: the watch outlives helper restarts (a crash, or the
  // recycle that rereads Screen Recording), so it is sent again on each ready.
  let watching: string[] | null = null
  let disposed = false
  function sendWatch(): void {
    try {
      link.send({ cmd: 'watch-calls', apps: watching })
    } catch {
      // Not running: the next ready sends it.
    }
  }
  let rewatch: ReturnType<typeof setTimeout> | null = null
  /** Brings a stopped helper back while the watch is on; a failed start tries again later. */
  function keepWatching(delayMs = 2_000): void {
    if (!watching || disposed || rewatch) return
    rewatch = setTimeout(() => {
      rewatch = null
      if (!watching || disposed || link.running || unavailable()) return
      link.ensure().catch(() => keepWatching(30_000))
    }, delayMs)
    rewatch.unref?.()
  }
  link.on('state', (state) => {
    if (state === 'ready' && watching) sendWatch()
    else if (state === 'idle') keepWatching()
  })
  function watchCalls(apps: string[] | null): void {
    const next = apps && apps.length > 0 ? apps.slice(0, 256) : null
    if (JSON.stringify(next) === JSON.stringify(watching)) return
    const was = watching
    watching = next
    if (deps.platform !== 'darwin' || unavailable()) return
    if (link.running) {
      if (next || was) sendWatch()
    } else if (next) {
      // The ready line sends it.
      void link.ensure().catch(() => undefined)
    }
  }

  async function loadLocales(): Promise<{ system: string; items: SpeechLocale[] }> {
    if (locales) return locales
    const line = await link.request({ cmd: 'locales' }, (l): l is Extract<HelperLine, { type: 'locales' }> => l.type === 'locales', replyTimeoutMs)
    locales = { system: normalizeLocaleId(line.system), items: line.items.map((l) => ({ ...l, id: normalizeLocaleId(l.id) })), preferred: (deps.preferredLanguages?.() ?? []).map(normalizeLocaleId) }
    return locales
  }

  async function loadDevices(): Promise<AudioInputDevice[]> {
    const line = await link.request({ cmd: 'devices' }, (l): l is Extract<HelperLine, { type: 'devices' }> => l.type === 'devices', replyTimeoutMs)
    return line.items
  }

  /** The locale to listen in: the caller's, then settings, then the system language. */
  async function pickLocale(requested: string | null | undefined, settings: TranscriptionSettings): Promise<string> {
    const list = await loadLocales()
    const wanted = requested ?? settings.locale ?? list.system
    // A chosen language must be offered as is; the system language falls back to its nearest variant (en-NL → en-GB).
    const found = resolveLocale(requested ?? settings.locale ?? null, list)
    if (!found && list.items.length) throw new SpeechError('locale-unsupported', `Speech recognition doesn't support ${wanted}.`)
    return found?.id ?? normalizeLocaleId(wanted)
  }

  async function begin(o: SpeechBeginOptions): Promise<SpeechSession> {
    await claim()
    const s = newSession({ purpose: o.purpose, mode: o.mode, record: o.record ?? null })
    active = s
    const meeting = o.purpose === 'meeting' && o.mode === 'meeting'
    // macOS reads Screen Recording when a process starts: a helper that saw it off starts afresh, so a grant made since counts.
    if (meeting && lastPermissions?.screen === 'denied' && link.running) link.recycle()
    try {
      await link.ensure()
      const transcribe = o.transcribe ?? true
      const p = await askUndecided(transcribe ? ['microphone', 'speech'] : ['microphone'])
      // The other side of a call needs Screen Recording: the first meeting asks (you just started it). The
      // grant lands after this helper started, so this one records the microphone only and warns.
      if (meeting && p?.screen === 'denied' && deps.screenPrompt && !deps.screenPrompt.asked()) await request('screen').catch(() => null)
      const settings = deps.settings()
      // Recording without transcribing (Record audio only, the mic test) works in any language.
      const [devices, locale] = await Promise.all([loadDevices(), transcribe ? pickLocale(o.locale, settings) : Promise.resolve(normalizeLocaleId(o.locale ?? settings.locale ?? 'en-US'))])
      const mic = resolveMic(settings.mic, devices)
      // Meetings listen in a second language too (Settings › Transcription: Automatic takes the Mac's next language).
      const secondary = meeting && transcribe && bilingual ? (secondLocale(settings.secondaryLocale, locale, await loadLocales())?.id ?? null) : null
      const started = link.waitFor((l): l is Started | Extract<HelperLine, { type: 'error' }> => (l.type === 'started' || (l.type === 'error' && l.fatal)) && lineSession(l) === s.id, startTimeoutMs)
      link.send({
        cmd: 'start',
        session: s.id,
        mode: o.mode,
        locale,
        deviceId: mic.deviceId,
        contextualStrings: transcribe ? parseVocabulary(settings.vocabulary) : [],
        micGain: clampSensitivity(settings.micSensitivity),
        systemGain: clampSensitivity(settings.systemSensitivity),
        transcribe,
        levels: o.levels ?? false,
        record: o.record ? { path: o.record } : null,
        ...(o.mode === 'meeting' && o.apps?.length ? { apps: o.apps.slice(0, 32) } : {}),
        ...(secondary ? { secondaryLocale: secondary } : {}),
      })
      const line = await started.catch((err: unknown) => {
        // No answer: ask the helper to drop it, so a late start can't hold the mic.
        send('stop')
        throw err
      })
      if (line.type === 'error') throw new SpeechError(line.code, line.message)
      if (line.secondaryLocale) merge(s, locale, normalizeLocaleId(line.secondaryLocale), true)
      s.clock.start()
      if (line.fallbackDevice || mic.fallback) s.emit({ type: 'warning', code: 'device-fallback' })
      if (o.mode === 'meeting' && !line.systemAudio) s.emit({ type: 'warning', code: 'screen-missing' })
      for (const fn of sessionListeners) fn(s, o.mode)
      emitStatus()
      return s
    } catch (err) {
      if (active === s) active = null
      emitStatus()
      throw err instanceof SpeechError ? err : new SpeechError('failed', err instanceof Error ? err.message : String(err))
    }
  }

  async function transcribeFile(path: string, onEvent: (e: SpeechSessionEvent) => void): Promise<void> {
    await claim()
    const s = newSession({ purpose: 'file', mode: 'dictation', record: null })
    active = s
    emitStatus()
    try {
      await link.ensure()
      await askUndecided(['speech'])
      const settings = deps.settings()
      const locale = await pickLocale(null, settings)
      const list = await loadLocales()
      await new Promise<void>((resolve, reject) => {
        let drain: NodeJS.Timeout | null = null
        s.on((e) => {
          onEvent(e)
          if (e.type === 'error' && e.fatal) reject(new SpeechError(e.code, e.message))
          if (e.type === 'stopped') resolve()
          // A helper that reports it is done but never says `stopped` still finishes.
          if (e.type === 'progress' && e.fraction >= 1 && !drain) {
            drain = setTimeout(() => {
              s.finish({ durationMs: s.clock.elapsed(), audio: null })
              resolve()
            }, 3_000)
            drain.unref?.()
          }
        })
        s.clock.start()
        // A recording is heard once per language when a second one is set; what fits wins per stretch.
        const secondary = bilingual ? (secondLocale(settings.secondaryLocale, locale, list)?.id ?? null) : null
        if (secondary) merge(s, locale, secondary, false)
        link.send({ cmd: 'transcribe', session: s.id, path, locale, contextualStrings: parseVocabulary(settings.vocabulary), ...(secondary ? { secondaryLocale: secondary } : {}) })
      })
    } catch (err) {
      s.finish({ durationMs: 0, audio: null })
      throw err instanceof SpeechError ? err : new SpeechError('failed', err instanceof Error ? err.message : String(err))
    } finally {
      if (active === s) {
        active = null
        emitStatus()
      }
    }
  }

  async function permissions(): Promise<SpeechPermissions> {
    // While a prompt is up, its answer is what counts; a poll gets the last report.
    if (requesting && lastPermissions) return lastPermissions
    // macOS reads the Screen Recording grant when a process starts, so an idle
    // helper is restarted to see a grant made in System Settings since.
    if (lastPermissions?.screen === 'denied' && !active && link.running) link.recycle()
    const line = await link.request({ cmd: 'permissions' }, (l): l is Extract<HelperLine, { type: 'permissions' }> => l.type === 'permissions', replyTimeoutMs)
    const { type: _type, ...p } = line
    return notePermissions(p)
  }

  async function request(kind: PermissionKind): Promise<SpeechPermissions> {
    // macOS prompts for Screen Recording only once and can't say whether it has: main keeps that.
    if (kind === 'screen') deps.screenPrompt?.markAsked()
    requesting++
    try {
      const line = await link.request({ cmd: 'request', what: kind }, (l): l is Extract<HelperLine, { type: 'permissions' }> => l.type === 'permissions', PROMPT_TIMEOUT_MS)
      const { type: _type, ...p } = line
      return notePermissions(p)
    } finally {
      requesting--
    }
  }

  /** Asks for each of `kinds` macOS hasn't asked about yet, in order. Every begin is something you did, so the prompt is in context; a denial is the helper's to report. */
  async function askUndecided(kinds: readonly PermissionKind[]): Promise<SpeechPermissions | null> {
    let p = await permissions().catch(() => null)
    for (const kind of kinds) {
      if (p?.[kind] === 'not-determined') p = await request(kind).catch(() => p)
    }
    return p
  }

  async function authenticate(reason: string): Promise<'ok' | 'cancelled' | 'unavailable'> {
    if (unavailable()) return 'unavailable'
    const id = randomUUID()
    try {
      const line = await link.request({ cmd: 'authenticate', id, reason }, (l): l is Extract<HelperLine, { type: 'auth' }> => l.type === 'auth' && l.id === id, PROMPT_TIMEOUT_MS)
      return line.result
    } catch {
      return 'unavailable'
    }
  }

  async function frontmost(): Promise<{ pid: number } | null> {
    if (unavailable()) return null
    try {
      const line = await link.request({ cmd: 'frontmost' }, (l): l is Extract<HelperLine, { type: 'frontmost' }> => l.type === 'frontmost', 2_000)
      return line.pid === null ? null : { pid: line.pid }
    } catch {
      return null
    }
  }

  return {
    status,
    begin,
    permissions: async () => {
      const blocked = unavailable()
      if (blocked) throw blocked
      return permissions()
    },
    request: async (kind) => {
      const blocked = unavailable()
      if (blocked) throw blocked
      return request(kind)
    },
    devices: async () => (unavailable() ? [] : loadDevices()),
    locales: async () => (unavailable() ? { system: 'en-US', items: [] } : loadLocales()),
    transcribeFile,
    recoverRecording: async (path) => {
      const blocked = unavailable()
      if (blocked) throw blocked
      await link.ensure()
      const id = randomUUID()
      const line = await link.request({ cmd: 'recover', id, path }, (l): l is Extract<HelperLine, { type: 'recovered' }> => l.type === 'recovered' && l.id === id, recoverTimeoutMs)
      return { audio: line.audio, durationMs: line.durationMs, ...(line.error ? { error: line.error } : {}) }
    },
    authenticate,
    frontmost,
    activate: (pid) => {
      if (unavailable()) return
      void link
        .ensure()
        .then(() => link.send({ cmd: 'activate', pid }))
        .catch(() => undefined)
    },
    onLine: (fn) => {
      lineListeners.add(fn)
      return () => lineListeners.delete(fn)
    },
    watchCalls,
    onStatus: (fn) => {
      statusListeners.add(fn)
      return () => statusListeners.delete(fn)
    },
    onPermissions: (fn) => {
      permissionListeners.add(fn)
      return () => permissionListeners.delete(fn)
    },
    onSession: (fn) => {
      sessionListeners.add(fn)
      return () => sessionListeners.delete(fn)
    },
    assets,
    onAssets: (fn) => {
      assetListeners.add(fn)
      return () => assetListeners.delete(fn)
    },
    dispose: () => {
      disposed = true
      watching = null
      if (rewatch) clearTimeout(rewatch)
      active?.cancel()
      link.dispose()
    },
  }
}
