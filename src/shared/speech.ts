/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Speech recognition, provided on macOS by the native apex-speech helper
// (native/speech). Dictation listens to the microphone; meeting mode also
// transcribes system audio, so both sides of a call end up in the transcript.
//
// The speech contract: protocol v2 lines, the SpeechBroker that
// arbitrates the one helper session, and the speech and transcription
// services.

import type { CallsSnapshot, DesktopCallAppId } from './desktopCalls'

export type SpeechMode = 'dictation' | 'meeting'
export type SpeechSource = 'mic' | 'system'


/** Lines the v1 helper printed, plus `exited`. Nothing speaks v1 any more. */
export type SpeechEvent =
  | { type: 'ready' }
  | { type: 'permissions'; speech: string; microphone: boolean }
  | { type: 'started'; mode: SpeechMode; onDevice: boolean; systemAudio: boolean }
  | { type: 'partial' | 'final'; source: SpeechSource; text: string }
  | { type: 'error'; source?: SpeechSource; message: string }
  | { type: 'stopped' }
  | { type: 'exited'; code: number | null }

export type SpeechState = 'unavailable' | 'idle' | 'starting' | 'listening' | 'stopping'

/** A finished piece of v1 dictation. Meetings use `TranscriptSegment` from shared/meetings.ts instead. */
export interface DictationSegment {
  source: SpeechSource
  text: string
  at: number
}


export const SPEECH_PROTOCOL_VERSION = 2

export type Perm = 'granted' | 'denied' | 'restricted' | 'not-determined'
export type PermissionKind = 'microphone' | 'speech' | 'screen'

export interface SpeechPermissions {
  microphone: Perm
  speech: Perm
  screen: 'granted' | 'denied'
  /** Location Services for Apex (CoreLocation); absent from a helper that doesn't report it. */
  location?: Perm
}

/**
 * Screen Recording as Apex's own process can use it (screenshots, sharing
 * windows and screens). macOS only says granted or not, so main remembers
 * whether Apex has asked: 'not-determined' is never asked (the first use in
 * context asks), 'denied' is asked and still off, and 'relaunch' is allowed
 * in System Settings but not in effect until Apex starts again (macOS reads
 * the grant at launch). 'unsupported' is any platform without the switch.
 */
export type ScreenAccess = 'granted' | 'not-determined' | 'denied' | 'relaunch' | 'unsupported'

export interface AudioInputDevice {
  id: string
  name: string
  builtIn: boolean
  isDefault: boolean
}

export interface SpeechLocale {
  /** BCP-47, for example 'en-US'. */
  id: string
  name: string
  /** Recognised on this Mac. Other locales send audio to Apple's servers (ST-18). */
  onDevice: boolean
  /** Which engine Apex uses for it; missing from an older helper, which only has 'recognizer'. */
  engine?: SpeechEngine
}

// ── B:transcription engine ── (macOS 26's SpeechAnalyzer, native/speech/Analyzer.swift and Models.swift)

/**
 * Apple's engine behind a session: 'analyzer' is SpeechAnalyzer with
 * SpeechTranscriber (macOS 26: on this Mac, no per-request time limit, a
 * model per language); 'recognizer' is SFSpeechRecognizer, used on older
 * macOS, for the languages the newer one lacks, and until a model is ready.
 */
export type SpeechEngine = 'analyzer' | 'recognizer'

/** The newer engine's model for a language on this Mac. */
export type SpeechAssetState = 'unavailable' | 'unsupported' | 'supported' | 'downloading' | 'installed' | 'failed'

export interface SpeechAssets {
  /** BCP-47, as Apex asked. */
  locale: string
  state: SpeechAssetState
  /** 0 to 1 while downloading, else null (1 once installed). */
  fraction: number | null
}

export const SPEECH_ASSET_STATES: readonly SpeechAssetState[] = ['unavailable', 'unsupported', 'supported', 'downloading', 'installed', 'failed']

export type HelperErrorCode =
  | 'mic-denied'
  | 'speech-denied'
  | 'screen-denied'
  | 'mic-busy'
  | 'device-missing'
  | 'locale-unsupported'
  | 'no-speech'
  | 'recording-failed'
  | 'busy'
  | 'invalid'
  | 'failed'

export const HELPER_ERROR_CODES: readonly HelperErrorCode[] = [
  'mic-denied', 'speech-denied', 'screen-denied', 'mic-busy', 'device-missing', 'locale-unsupported',
  'no-speech', 'recording-failed', 'busy', 'invalid', 'failed',
]

/** Commands Apex writes to the helper's stdin, one JSON object per line. */
export type HelperCommand =
  | { cmd: 'hello' }
  | { cmd: 'permissions' }
  | { cmd: 'request'; what: PermissionKind }
  | { cmd: 'devices' }
  | { cmd: 'locales' }
  | {
      cmd: 'start'
      session: string
      mode: SpeechMode
      locale: string
      deviceId: string | null
      contextualStrings: string[]
      micGain: number
      systemGain: number
      transcribe: boolean
      levels: boolean
      record: { path: string } | null
      /** Desktop calls: record only these apps' sound as the other side (bundle ids, helpers included). */
      apps?: string[]
    }
  | { cmd: 'pause' }
  | { cmd: 'resume' }
  | { cmd: 'stop' }
  | { cmd: 'transcribe'; session: string; path: string; locale: string; contextualStrings: string[] }
  | { cmd: 'authenticate'; id: string; reason: string }
  | { cmd: 'frontmost' }
  | { cmd: 'activate'; pid: number }
  /** Desktop calls: report `calls` snapshots (running apps limited to these bundle prefixes); null stops. */
  | { cmd: 'watch-calls'; apps: string[] | null }
  /** The newer engine's model for `locale`: answered with an `assets` line; `install` starts installing it. */
  | { cmd: 'prepare'; locale: string; install: boolean }
  /** A recording a session never finished (a crash, a force quit): merge the parts left beside `path` into it; answered with `recovered`. */
  | { cmd: 'recover'; id: string; path: string }

/** Lines the v2 helper prints on stdout. Unknown lines are ignored (`lid` was added without a version bump). */
export type HelperLine =
  | { type: 'ready'; version: number }
  | ({ type: 'permissions' } & SpeechPermissions)
  | { type: 'devices'; items: AudioInputDevice[] }
  | { type: 'locales'; system: string; items: SpeechLocale[] }
  | { type: 'auth'; id: string; result: 'ok' | 'cancelled' | 'unavailable' }
  | { type: 'frontmost'; pid: number | null; bundleId: string | null }
  | { type: 'started'; session: string; mode: SpeechMode; onDevice: boolean; systemAudio: boolean; deviceId: string | null; locale: string; fallbackDevice: boolean; engine?: SpeechEngine; /** Bilingual: the second language listening too. */ secondaryLocale?: string }
  | { type: 'partial' | 'final'; session: string; source: SpeechSource; text: string; startMs: number; endMs: number; /** The language it was heard in; a final's `fit` says how well it reads as that language (bilingual). */ locale?: string; fit?: number; confidence?: number }
  | { type: 'level'; session: string; source: SpeechSource; rms: number; peak: number }
  | { type: 'paused' | 'resumed'; session: string }
  | { type: 'interrupted' | 'restored'; session: string; source: SpeechSource }
  | { type: 'progress'; session: string; fraction: number }
  | { type: 'error'; session?: string; source?: SpeechSource; code: HelperErrorCode; message: string; fatal: boolean }
  | { type: 'stopped'; session: string; durationMs: number; audio: { path: string; bytes: number } | null }
  /** The helper's IOKit clamshell observer (native/speech/Lid.swift); read through broker.onLine. */
  | { type: 'lid'; closed: boolean }
  /** Desktop calls: which processes have audio running and which watched apps are open (CallWatch.swift). */
  | ({ type: 'calls' } & CallsSnapshot)
  /** The newer engine's model for a language: the answer to `prepare`, and an install's progress (no session). */
  | ({ type: 'assets' } & SpeechAssets)
  /** The answer to `recover`: the recording put back together, or null when nothing was left (or it couldn't be). */
  | { type: 'recovered'; id: string; audio: { path: string; bytes: number } | null; durationMs: number; error?: string }


export type SpeechPurpose = 'dictation' | 'voice-command' | 'launcher' | 'meeting' | 'level-test' | 'file'
export type SpeechErrorCode = HelperErrorCode | 'helper-missing' | 'helper-failed' | 'helper-outdated' | 'unsupported-platform'

type SessionLineType = 'started' | 'partial' | 'final' | 'level' | 'paused' | 'resumed' | 'interrupted' | 'restored' | 'progress' | 'error' | 'stopped'
// Distributes over the union so each member keeps its own fields.
type WithoutSession<T> = T extends unknown ? Omit<T, 'session'> : never

/**
 * A session's helper events without `session`, plus Apex's own warnings.
 * Errors carry any SpeechErrorCode: a helper that dies mid-session ends it
 * with a fatal 'helper-failed' error (widened from HelperErrorCode).
 */
export type SpeechSessionEvent =
  | WithoutSession<Extract<HelperLine, { type: Exclude<SessionLineType, 'error'> }>>
  | { type: 'error'; source?: SpeechSource; code: SpeechErrorCode; message: string; fatal: boolean }
  | { type: 'warning'; code: 'device-fallback' | 'screen-missing' }

/** Thrown by the broker; `holder` names the purpose that holds the helper on a `busy` error. */
export class SpeechError extends Error {
  readonly code: SpeechErrorCode
  readonly holder?: SpeechPurpose

  constructor(code: SpeechErrorCode, message?: string, holder?: SpeechPurpose) {
    super(message ?? code)
    this.name = 'SpeechError'
    this.code = code
    this.holder = holder
  }
}

export interface SpeechStopResult {
  durationMs: number
  audio: { path: string; bytes: number } | null
}

export interface SpeechSession {
  id: string
  purpose: SpeechPurpose
  on(fn: (e: SpeechSessionEvent) => void): () => void
  stop(): Promise<SpeechStopResult>
  pause(): void
  resume(): void
  cancel(): void
}

export interface SpeechStatus {
  available: boolean
  reason: 'helper-missing' | 'unsupported-platform' | 'helper-outdated' | null
  active: { id: string; purpose: SpeechPurpose; mode: SpeechMode } | null
}

export interface SpeechBeginOptions {
  purpose: SpeechPurpose
  mode: SpeechMode
  /** Null or omitted uses settings.transcription.locale, then the system language. */
  locale?: string | null
  /** A file path to record to (AAC, `.m4a`), or null for no recording. */
  record?: string | null
  transcribe?: boolean
  levels?: boolean
  /** Meeting mode: record only these apps' sound as the other side (a desktop call). */
  apps?: string[]
}

export interface SpeechBroker {
  status(): SpeechStatus
  /** Mic choice, vocabulary and gains come from settings.transcription. Rejects SpeechError('busy'). */
  begin(o: SpeechBeginOptions): Promise<SpeechSession>
  permissions(): Promise<SpeechPermissions>
  request(kind: PermissionKind): Promise<SpeechPermissions>
  devices(): Promise<AudioInputDevice[]>
  locales(): Promise<SpeechLocaleList>
  transcribeFile(path: string, onEvent: (e: SpeechSessionEvent) => void): Promise<void>
  /** Puts a recording a session never finished back together from the parts left beside `path` (Apex crashed or was force quit mid-recording). */
  recoverRecording(path: string): Promise<{ audio: { path: string; bytes: number } | null; durationMs: number; error?: string }>
  authenticate(reason: string): Promise<'ok' | 'cancelled' | 'unavailable'>
  frontmost(): Promise<{ pid: number } | null>
  activate(pid: number): void
  /** Raw helper lines, for the lid events. */
  onLine(fn: (line: HelperLine) => void): () => void
  /** Desktop calls: keeps the helper reporting `calls` lines (running apps under these prefixes), across restarts; null stops. */
  watchCalls(apps: string[] | null): void
}


export type MicChoice = 'built-in' | 'system' | `device:${string}`

export interface TranscriptionSettings {
  mic: MicChoice
  locale: string | null
  secondaryLocale: string | null
  /** At most VOCABULARY_MAX characters. */
  vocabulary: string
  autoSummarize: boolean
  alertCalendar: boolean
  alertMeetingSites: boolean
  /** 0.25 to 4. */
  micSensitivity: number
  /** 0.25 to 4. */
  systemSensitivity: number
  recordAudio: boolean
  /** Meetings record audio only: no transcript or notes (the audio is always kept). */
  recordOnly: boolean
  setupDismissed: boolean
  /** Offer notes when a call starts in a desktop app (Zoom, Teams, FaceTime…). */
  alertDesktopCalls: boolean
  /** The desktop apps whose calls get no offer. */
  desktopCallsMuted: DesktopCallAppId[]
}

export const VOCABULARY_MAX = 2000
export const SENSITIVITY = { min: 0.25, max: 4 } as const


export interface SpeechServices {
  speech: {
    status(): SpeechStatus
    permissions(): Promise<SpeechPermissions>
    request(kind: PermissionKind): Promise<SpeechPermissions>
    /** Opens the right System Settings › Privacy pane. */
    openPrivacySettings(kind: PermissionKind): void
    /** Screen Recording for Apex's own screenshots and sharing (see ScreenAccess). */
    screenAccess(): Promise<ScreenAccess>
    /** Asks macOS for Screen Recording (its prompt shows only the first time); never opens System Settings. */
    requestScreen(): Promise<ScreenAccess>
    /** Quits and reopens Apex, so a Screen Recording grant made since launch takes effect. */
    relaunch(): void
    devices(): Promise<AudioInputDevice[]>
    locales(): Promise<SpeechLocaleList>
    /** Starts chrome-owned dictation; events arrive as 'speech-session'. Resolves to the session id. */
    startDictation(): Promise<string>
    stop(sessionId: string): Promise<void>
    cancel(sessionId: string): void
  }
  transcription: {
    /** Records a short microphone test without transcribing it (ST-21). */
    testStart(): Promise<void>
    testStop(): Promise<{ durationMs: number }>
    testInfo(): { exists: boolean; durationMs: number; url: 'apex-media://speech/test' | null }
    testDelete(): void
    /** Back to the default mic, sensitivities and languages. */
    resetCapture(): void
    /** Whether a calendar source exists for the before-meeting alert (ST-20); the platform feature supplies it. */
    calendarAvailable(): boolean
    /** Whether this Mac can spot calls in desktop apps (macOS 14.4+); null until the helper has said. */
    desktopCalls(): { supported: boolean | null }
    /** The newer engine's model for the transcription language (Settings › Transcription). */
    assets(): Promise<SpeechAssets>
    /** Starts installing that model; progress arrives as 'speech-assets'. */
    prepareAssets(): Promise<SpeechAssets>
  }
}

export type SpeechAppEvent =
  /** Chrome-owned purposes only: dictation, level-test and the meeting live row. */
  | { type: 'speech-session'; id: string; purpose: SpeechPurpose; event: SpeechSessionEvent }
  | { type: 'speech-status'; status: SpeechStatus }
  | { type: 'speech-permissions'; permissions: SpeechPermissions }
  /** A language model's state changed (an install's progress, or done). */
  | { type: 'speech-assets'; assets: SpeechAssets }

/** The System Settings panes for each permission. */
export const PRIVACY_PANES: Record<PermissionKind, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  speech: 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

/** The same in Windows' Settings. System audio needs no permission there, so screen has no page. */
export const WINDOWS_PRIVACY_PANES: Record<PermissionKind, string | null> = {
  microphone: 'ms-settings:privacy-microphone',
  speech: 'ms-settings:privacy-speech',
  screen: null,
}

// Pure; main, the renderer kit and the features that use speech share them

/** Where the last microphone test plays from (its handler serves userData/speech/test.m4a). */
export const SPEECH_TEST_URL = 'apex-media://speech/test'

/** The recognizer's context hints have practical limits: at most this many terms… */
export const VOCABULARY_TERMS_MAX = 100
/** …of at most this many characters each. */
export const VOCABULARY_TERM_MAX = 60

/**
 * The custom vocabulary as context hints (ST-19): newline or comma separated,
 * trimmed, deduped (case-insensitively, first spelling wins), terms longer
 * than the limit dropped, at most VOCABULARY_TERMS_MAX.
 */
export function parseVocabulary(text: string): string[] {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of text.slice(0, VOCABULARY_MAX).split(/[\n,]/)) {
    const term = raw.replace(/\s+/g, ' ').trim()
    if (!term || term.length > VOCABULARY_TERM_MAX) continue
    const key = term.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length === VOCABULARY_TERMS_MAX) break
  }
  return terms
}

/** A sensitivity inside SENSITIVITY; anything unreadable is 1. */
export function clampSensitivity(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(SENSITIVITY.max, Math.max(SENSITIVITY.min, value))
}

/**
 * The helper's device id for a mic choice (ST-18). 'system' is the system
 * default (null). A saved device that is unplugged, or a Mac without a
 * built-in microphone, falls back to the default with `fallback` set, which
 * the broker turns into a 'device-fallback' warning.
 */
export function resolveMic(choice: MicChoice, devices: readonly AudioInputDevice[]): { deviceId: string | null; fallback: boolean } {
  if (choice === 'system') return { deviceId: null, fallback: false }
  if (choice === 'built-in') {
    const builtIn = devices.find((d) => d.builtIn)
    return builtIn ? { deviceId: builtIn.id, fallback: false } : { deviceId: null, fallback: devices.length > 0 }
  }
  const id = choice.slice('device:'.length)
  return devices.some((d) => d.id === id) ? { deviceId: id, fallback: false } : { deviceId: null, fallback: true }
}

/** BCP-47 with a hyphen: macOS sometimes reports 'en_US'. */
export function normalizeLocaleId(id: string): string {
  return id.trim().replace(/_/g, '-')
}

/** The supported locale matching `id` (case and separator insensitive), or null. */
/** The languages this Mac offers, its own language, and its preferred languages in order (bilingual meetings' Automatic). */
export interface SpeechLocaleList {
  system: string
  items: SpeechLocale[]
  preferred?: string[]
}

/** Settings' second language that turns bilingual meetings off. */
export const NO_SECOND_LOCALE = 'none'

const languageOf = (id: string): string => normalizeLocaleId(id).split('-')[0]!.toLowerCase()

/**
 * Meetings' second language (bilingual: both listen, and each stretch keeps
 * the one that fits): the one chosen in Settings, else (Automatic) the first
 * of the Mac's preferred languages in another language than `primary`, as
 * this Mac offers it. Null for none.
 */
export function secondLocale(setting: string | null, primary: string, list: Pick<SpeechLocaleList, 'items' | 'preferred'>): SpeechLocale | null {
  if (setting === NO_SECOND_LOCALE) return null
  const other = (l: SpeechLocale | null): SpeechLocale | null => (l && languageOf(l.id) !== languageOf(primary) ? l : null)
  if (setting) return other(findLocale(list.items, setting))
  for (const id of list.preferred ?? []) {
    if (languageOf(id) === languageOf(primary)) continue
    const found = other(closestLocale(list.items, id))
    if (found) return found
  }
  return null
}

export function findLocale(items: readonly SpeechLocale[], id: string | null): SpeechLocale | null {
  if (!id) return null
  const want = normalizeLocaleId(id).toLowerCase()
  return items.find((l) => normalizeLocaleId(l.id).toLowerCase() === want) ?? null
}

/** English regions that write US English (CLDR's root `en`); every other English region inherits en-001, nearest to en-GB. */
const US_ENGLISH = new Set(['US', 'AS', 'GU', 'MH', 'MP', 'PR', 'UM', 'VI'])

function localeParts(id: string): { language: string; script: string; region: string } | null {
  try {
    const l = new Intl.Locale(normalizeLocaleId(id)).maximize()
    return { language: l.language, script: l.script ?? '', region: l.region ?? '' }
  } catch {
    return null
  }
}

/**
 * The offered locale nearest to `id`: itself, else the same language and
 * script in the variant that region writes (British English outside the US,
 * the language's own country otherwise), preferring one that runs on this
 * Mac. Null when the language isn't offered at all. A Mac set to English
 * (Netherlands) has no en-NL recognizer, and gets en-GB.
 */
export function closestLocale(items: readonly SpeechLocale[], id: string | null): SpeechLocale | null {
  const exact = findLocale(items, id)
  if (exact || !id) return exact
  const want = localeParts(id)
  if (!want) return null
  const home = want.language === 'en' ? (US_ENGLISH.has(want.region) ? 'US' : 'GB') : want.language.toUpperCase()
  let best: SpeechLocale | null = null
  let bestScore = -1
  for (const item of items) {
    const l = localeParts(item.id)
    if (!l || l.language !== want.language || l.script !== want.script) continue
    const score = (l.region === home ? 2 : 0) + (item.onDevice ? 1 : 0)
    if (score > bestScore) {
      best = item
      bestScore = score
    }
  }
  return best
}

/** What recognition uses for a language setting: a chosen language exactly, or for the system language (null) the nearest one offered. */
export function resolveLocale(setting: string | null, list: { system: string; items: readonly SpeechLocale[] }): SpeechLocale | null {
  return setting ? findLocale(list.items, setting) : closestLocale(list.items, list.system)
}

/** Dictation and meetings can work: microphone and speech recognition are both allowed. */
export function transcriptionReady(p: SpeechPermissions): boolean {
  return p.microphone === 'granted' && p.speech === 'granted'
}

/** Every step of the setup checklist is done, Screen Recording included (ST-17). */
export function permissionsComplete(p: SpeechPermissions): boolean {
  return transcriptionReady(p) && p.screen === 'granted'
}

export function samePermissions(a: SpeechPermissions | null, b: SpeechPermissions | null): boolean {
  return !!a && !!b && a.microphone === b.microphone && a.speech === b.speech && a.screen === b.screen && a.location === b.location
}

/**
 * Elapsed time that leaves out pauses (MV-10): the helper's segment times
 * are in this audio time, and so is a recording's length.
 */
export class SessionClock {
  #startedAt: number | null = null
  #pausedAt: number | null = null
  #pausedTotal = 0
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  start(): void {
    if (this.#startedAt !== null) return
    this.#startedAt = this.#now()
  }

  pause(): void {
    if (this.#startedAt === null || this.#pausedAt !== null) return
    this.#pausedAt = this.#now()
  }

  resume(): void {
    if (this.#pausedAt === null) return
    this.#pausedTotal += this.#now() - this.#pausedAt
    this.#pausedAt = null
  }

  get paused(): boolean {
    return this.#pausedAt !== null
  }

  /** Milliseconds since start, pauses excluded; 0 before start. */
  elapsed(): number {
    if (this.#startedAt === null) return 0
    const end = this.#pausedAt ?? this.#now()
    return Math.max(0, end - this.#startedAt - this.#pausedTotal)
  }
}

/**
 * Dictated text from a session's events: finals in order, then whatever each
 * source is still recognising. Each source has at most one partial at a
 * time; its final replaces it.
 */
export class DictationTranscript {
  readonly finals: Array<{ source: SpeechSource; text: string; startMs: number; endMs: number }> = []
  readonly #partial = new Map<SpeechSource, string>()

  /** Returns true when the visible text changed. */
  apply(event: SpeechSessionEvent): boolean {
    if (event.type === 'partial') {
      if (this.#partial.get(event.source) === event.text) return false
      this.#partial.set(event.source, event.text)
      return true
    }
    if (event.type === 'final') {
      const had = this.#partial.delete(event.source)
      const text = event.text.trim()
      if (text) this.finals.push({ source: event.source, text, startMs: event.startMs, endMs: event.endMs })
      return had || !!text
    }
    return false
  }

  /** Finished text followed by what is still being recognised. */
  text(): string {
    return [...this.finals.map((f) => f.text), ...this.#partial.values()].filter(Boolean).join(' ')
  }

  /** Only the finished text, for inserting when dictation stops. */
  finalText(): string {
    return this.finals.map((f) => f.text).join(' ')
  }
}

const SPEECH_ERROR_CODES: readonly SpeechErrorCode[] = [...HELPER_ERROR_CODES, 'helper-missing', 'helper-failed', 'helper-outdated', 'unsupported-platform']
const SPEECH_PURPOSES: readonly SpeechPurpose[] = ['dictation', 'voice-command', 'launcher', 'meeting', 'level-test', 'file']

export function isSpeechErrorCode(value: unknown): value is SpeechErrorCode {
  return typeof value === 'string' && (SPEECH_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * IPC carries only an error's message, so a SpeechError crossing to the
 * chrome is tagged with its code (and holder): "[speech:busy:meeting] …".
 */
export function encodeSpeechError(error: SpeechError): string {
  return `[speech:${error.code}${error.holder ? `:${error.holder}` : ''}] ${error.message}`
}

/** The code, holder and message back from an error's text (any IPC prefix is skipped), or null. */
export function decodeSpeechError(text: string): { code: SpeechErrorCode; holder?: SpeechPurpose; message: string } | null {
  const match = /\[speech:([a-z-]+)(?::([a-z-]+))?\] ?([\s\S]*)$/.exec(text)
  if (!match || !isSpeechErrorCode(match[1])) return null
  const holder = SPEECH_PURPOSES.find((p) => p === match[2])
  return { code: match[1], ...(holder ? { holder } : {}), message: match[3] ?? '' }
}
