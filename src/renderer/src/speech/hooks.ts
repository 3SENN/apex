/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Speech hooks for the chrome: status, permissions (polled while a checklist
// is on screen), microphones, languages and one session's live state. Voice,
// meeting capture and the meetings page use them as well as Settings.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DictationTranscript,
  type AudioInputDevice,
  type PermissionKind,
  type ScreenAccess,
  type SpeechAssets,
  type SpeechLocale,
  type SpeechPermissions,
  type SpeechPurpose,
  type SpeechSessionEvent,
  type SpeechSource,
  type SpeechStatus,
} from '@shared/speech'
import { call } from '../api'
import { useEvent, useResource, type Resource } from '../settings/data'
import { copyForError, errorCopy, type SpeechCopy, type SpeechNoticeCode } from './errorCopy'
import { sameLocale } from './logic'

/** How often the checklist rechecks while it is visible (ST-17). */
export const PERMISSION_POLL_MS = 3_000

export function useSpeechStatus(): Resource<SpeechStatus> {
  const resource = useResource(() => call('speech', 'status'))
  useEvent('speech-status', (e) => resource.set(e.status))
  return resource
}

export interface PermissionsState extends Resource<SpeechPermissions> {
  /** The kind whose OS prompt is up, if any. */
  requesting: PermissionKind | null
  /** Asks the OS (it prompts only the first time); resolves with the new report. */
  request(kind: PermissionKind): Promise<SpeechPermissions | null>
  openSettings(kind: PermissionKind): void
  /** The last request's failure, as copy. */
  requestError: SpeechCopy | null
}

/** The permission report, kept live; with `poll`, rechecked every 3 s while the page is visible. */
export function useSpeechPermissions({ poll = false, enabled = true }: { poll?: boolean; enabled?: boolean } = {}): PermissionsState {
  const resource = useResource<SpeechPermissions>(() => (enabled ? call('speech', 'permissions') : Promise.reject(new Error('unavailable'))), enabled)
  const [requesting, setRequesting] = useState<PermissionKind | null>(null)
  const [requestError, setRequestError] = useState<SpeechCopy | null>(null)
  useEvent('speech-permissions', (e) => resource.set(e.permissions))

  useEffect(() => {
    if (!poll || !enabled) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      // A change arrives as 'speech-permissions'; a failed poll keeps the last report.
      void call('speech', 'permissions').then(resource.set, () => undefined)
    }, PERMISSION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [poll, enabled])

  const request = useCallback(async (kind: PermissionKind): Promise<SpeechPermissions | null> => {
    setRequesting(kind)
    setRequestError(null)
    try {
      const next = await call('speech', 'request', kind)
      resource.set(next)
      return next
    } catch (err) {
      setRequestError(copyForError(err))
      return null
    } finally {
      setRequesting(null)
    }
  }, [])

  const openSettings = useCallback((kind: PermissionKind) => {
    void call('speech', 'openPrivacySettings', kind)
  }, [])

  return { ...resource, requesting, request, openSettings, requestError }
}

/**
 * Screen Recording as main tracks it (whether Apex has asked, and whether a
 * grant waits for a relaunch); looked at again on each permission report and
 * when the window comes back (from System Settings).
 */
export function useScreenAccess(enabled = true): Resource<ScreenAccess> {
  const resource = useResource<ScreenAccess>(() => (enabled ? call('speech', 'screenAccess') : Promise.resolve('unsupported' as const)), enabled)
  useEvent('speech-permissions', () => void resource.reload())
  useEffect(() => {
    if (!enabled) return
    const recheck = (): void => {
      if (document.visibilityState === 'visible') void resource.reload()
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [enabled])
  return resource
}

export interface MicDevicesState extends Resource<AudioInputDevice[]> {
  refreshing: boolean
  refresh(): Promise<void>
}

export function useMicDevices(enabled = true): MicDevicesState {
  const resource = useResource<AudioInputDevice[]>(() => (enabled ? call('speech', 'devices') : Promise.resolve([])), enabled)
  const [refreshing, setRefreshing] = useState(false)
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await resource.reload()
    } finally {
      setRefreshing(false)
    }
  }, [resource.reload])
  return { ...resource, refreshing, refresh }
}

export function useSpeechLocales(enabled = true): Resource<{ system: string; items: SpeechLocale[] }> {
  return useResource(() => (enabled ? call('speech', 'locales') : Promise.resolve({ system: 'en-US', items: [] as SpeechLocale[] })), enabled)
}

// ── B:transcription engine ──

export interface SpeechAssetsState extends Resource<SpeechAssets> {
  preparing: boolean
  /** Starts installing the language's model; progress then arrives as events. */
  prepare(): Promise<void>
  prepareError: SpeechCopy | null
}

/**
 * The transcription language's on-device model (macOS 26), kept live from
 * 'speech-assets'. `locale` is only the reload key: main resolves the
 * language from settings. A reply never overwrites a newer event.
 */
export function useSpeechAssets(locale: string | null, enabled = true): SpeechAssetsState {
  const events = useRef(0)
  const latest = useRef<SpeechAssets | null>(null)
  const load = async (): Promise<SpeechAssets> => {
    const before = events.current
    const value = await call('transcription', 'assets')
    const newer = latest.current
    return events.current !== before && newer && sameLocale(newer.locale, value.locale) ? newer : value
  }
  const resource = useResource<SpeechAssets>(() => (enabled ? load() : Promise.resolve({ locale: locale ?? '', state: 'unavailable', fraction: null })), `${enabled}:${locale ?? ''}`)
  const [preparing, setPreparing] = useState(false)
  const [prepareError, setPrepareError] = useState<SpeechCopy | null>(null)
  const shown = useRef<SpeechAssets | null>(null)
  shown.current = resource.data
  useEvent('speech-assets', (e) => {
    events.current++
    latest.current = e.assets
    if (shown.current && sameLocale(shown.current.locale, e.assets.locale)) resource.set(e.assets)
  })
  const prepare = useCallback(async (): Promise<void> => {
    setPreparing(true)
    setPrepareError(null)
    const before = events.current
    try {
      const next = await call('transcription', 'prepareAssets')
      if (events.current === before) resource.set(next)
    } catch (err) {
      setPrepareError(copyForError(err))
    } finally {
      setPreparing(false)
    }
  }, [])
  return { ...resource, preparing, prepare, prepareError }
}

export type Level = { rms: number; peak: number }

export interface SessionView {
  id: string | null
  purpose: SpeechPurpose | null
  state: 'idle' | 'listening' | 'paused' | 'stopped' | 'failed'
  levels: Partial<Record<SpeechSource, Level>>
  /** Finished text, then what is still being recognised. */
  text: string
  /** Only the finished text. */
  finalText: string
  /** Sources that dropped out and are restarting. */
  interrupted: SpeechSource[]
  warnings: SpeechCopy[]
  error: SpeechCopy | null
  /** Whether the call's audio is captured (meetings). */
  systemAudio: boolean
}

const IDLE: SessionView = { id: null, purpose: null, state: 'idle', levels: {}, text: '', finalText: '', interrupted: [], warnings: [], error: null, systemAudio: false }

/** Folds one session event into the view (the text comes from a DictationTranscript beside it). */
export function reduceSession(view: SessionView, event: SpeechSessionEvent): SessionView {
  switch (event.type) {
    case 'started':
      return { ...view, state: 'listening', systemAudio: event.systemAudio }
    case 'partial':
    case 'final':
      return view
    case 'level':
      return { ...view, levels: { ...view.levels, [event.source]: { rms: event.rms, peak: event.peak } } }
    case 'paused':
      return { ...view, state: 'paused', levels: {} }
    case 'resumed':
      return { ...view, state: 'listening' }
    case 'interrupted':
      return view.interrupted.includes(event.source) ? view : { ...view, interrupted: [...view.interrupted, event.source] }
    case 'restored':
      return { ...view, interrupted: view.interrupted.filter((s) => s !== event.source) }
    case 'warning':
      return withWarning(view, event.code)
    case 'error': {
      const copy = errorCopy(event.code)
      if (event.fatal) return { ...view, state: 'failed', error: copy, levels: {} }
      return withWarning(view, event.code)
    }
    case 'stopped':
      return { ...view, state: 'stopped', levels: {} }
    case 'progress':
      return view
  }
}

function withWarning(view: SessionView, code: SpeechNoticeCode): SessionView {
  return view.warnings.some((w) => w.code === code) ? view : { ...view, warnings: [...view.warnings, errorCopy(code)] }
}

/**
 * One chrome-owned session's live state (dictation, the level test, the
 * meeting live row), from 'speech-session' events. Match by id, or by
 * purpose when the caller doesn't know the id (the level test).
 */
export function useSpeechSession(match: { id?: string | null; purpose?: SpeechPurpose }): SessionView & { reset(): void } {
  const [view, setView] = useState<SessionView>(IDLE)
  const transcript = useRef(new DictationTranscript())
  const current = useRef<string | null>(null)
  const reset = useCallback(() => {
    transcript.current = new DictationTranscript()
    current.current = null
    setView(IDLE)
  }, [])
  useEffect(reset, [match.id, match.purpose])
  useEvent('speech-session', (e) => {
    if (match.id ? e.id !== match.id : match.purpose ? e.purpose !== match.purpose : true) return
    // A new session of the same purpose starts from scratch.
    if (current.current !== e.id) {
      transcript.current = new DictationTranscript()
      current.current = e.id
      setView({ ...IDLE, id: e.id, purpose: e.purpose, state: 'listening' })
    }
    // The transcript is applied once, here, never inside a state updater (which may run twice).
    const text = (e.event.type === 'partial' || e.event.type === 'final') && transcript.current.apply(e.event) ? { text: transcript.current.text(), finalText: transcript.current.finalText() } : null
    setView((v) => ({ ...reduceSession({ ...v, id: e.id, purpose: e.purpose }, e.event), ...text }))
  })
  return { ...view, reset }
}
