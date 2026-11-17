/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState } from 'react'
import { HELPER_ERROR_CODES, type SpeechErrorCode, type SpeechSessionEvent, type SpeechStatus } from '@shared/speech'
import { atelier, call, errorText } from '../../api'
import { useLatest } from '../../ui'
import { dictationErrorCopy, permissionStep, type DictationState, type ErrorCopy } from './logic'

// Dictation over the speech helper (MV-07), for any text field in the
// chrome: the composer, the new tab's ask field and the rating note. The
// first use asks for microphone and speech recognition; a denial comes back
// as an error that says how to fix it. Events arrive as 'speech-session'
// app events for this hook's own session id.

export interface DictationError {
  code: SpeechErrorCode
  copy: ErrorCopy
}

export interface Dictation {
  state: DictationState
  /** The microphone level, 0..1, while listening. */
  level: number
  /** The words still being recognised. */
  partial: string
  /** Finished words heard so far in this session. */
  heard: string
  error: DictationError | null
  /** The helper is installed and can run. */
  available: boolean
  start(): Promise<void>
  /** Stops listening; resolves to everything heard ('' when nothing was). */
  stop(): Promise<string>
  /** Stops without keeping anything. */
  cancel(): void
  dismissError(): void
}

const EXTRA_CODES: readonly SpeechErrorCode[] = ['helper-missing', 'helper-failed', 'helper-outdated', 'unsupported-platform']
/** How long Stop waits for the helper's last words before giving up on them. */
const STOP_TIMEOUT_MS = 6000

/** The error code inside an IPC rejection (the broker's SpeechError travels as its message). */
export function codeFromError(err: unknown): SpeechErrorCode {
  const text = errorText(err)
  const codes = [...EXTRA_CODES, ...HELPER_ERROR_CODES]
  return codes.find((c) => new RegExp(`(^|[^a-z-])${c}([^a-z-]|$)`).test(text)) ?? 'failed'
}

function reasonCode(status: SpeechStatus): SpeechErrorCode {
  return status.reason ?? 'helper-missing'
}

export function useDictation(onFinal?: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>('idle')
  const [level, setLevel] = useState(0)
  const [partial, setPartial] = useState('')
  const [heard, setHeard] = useState('')
  const [error, setError] = useState<DictationError | null>(null)
  const [available, setAvailable] = useState(true)
  const session = useRef<string | null>(null)
  const finals = useRef<string[]>([])
  /** Events that arrived before startDictation resolved with their session's id. */
  const early = useRef<Array<{ id: string; event: SpeechSessionEvent }>>([])
  const stopped = useRef<((text: string) => void) | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const final = useLatest(onFinal)

  const fail = useCallback((code: SpeechErrorCode) => {
    session.current = null
    setState('error')
    setLevel(0)
    setPartial('')
    setError({ code, copy: dictationErrorCopy(code) })
  }, [])

  const finish = useCallback(() => {
    const text = finals.current.join(' ').replace(/\s+/g, ' ').trim()
    session.current = null
    finals.current = []
    setState('idle')
    setLevel(0)
    setPartial('')
    setHeard('')
    const waiter = stopped.current
    stopped.current = null
    if (waiter) waiter(text)
    else if (text) final.current?.(text)
  }, [])

  const handle = useCallback((event: SpeechSessionEvent) => {
    switch (event.type) {
      case 'level':
        if (event.source === 'mic') setLevel(event.rms)
        break
      case 'partial':
        setPartial(event.text)
        break
      case 'final':
        if (event.text.trim()) finals.current.push(event.text.trim())
        setHeard(finals.current.join(' '))
        setPartial('')
        break
      case 'error':
        if (event.fatal) {
          const waiter = stopped.current
          stopped.current = null
          // Words heard before the failure still land.
          const text = finals.current.join(' ').trim()
          finals.current = []
          if (waiter) waiter(text)
          else if (text) final.current?.(text)
          fail(event.code)
        }
        break
      case 'stopped':
        finish()
        break
      default:
        break
    }
  }, [fail, finish])

  useEffect(
    () =>
      atelier.onAppEvent((e) => {
        if (e.type === 'speech-status') setAvailable(e.status.available)
        if (e.type !== 'speech-session' || e.purpose !== 'dictation') return
        if (session.current === e.id) handle(e.event)
        else if (session.current === null && stateRef.current === 'starting') early.current.push({ id: e.id, event: e.event })
      }),
    [handle],
  )

  useEffect(() => {
    void call('speech', 'status').then((s) => setAvailable(s.available), () => setAvailable(false))
  }, [])

  // Leaving with a session running stops it; nothing more is inserted.
  useEffect(() => () => {
    const id = session.current
    session.current = null
    // A start still in flight sees this and cancels its session when it lands,
    // so a composer that went away never leaves the microphone on.
    stateRef.current = 'idle'
    if (id) void call('speech', 'cancel', id).catch(() => undefined)
  }, [])

  // Esc while listening throws the dictation away (the draft is untouched).
  useEffect(() => {
    if (state !== 'listening') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state])

  const start = async (): Promise<void> => {
    if (stateRef.current !== 'idle' && stateRef.current !== 'error') return
    setError(null)
    setState('starting')
    stateRef.current = 'starting'
    finals.current = []
    early.current = []
    try {
      const status = await call('speech', 'status')
      setAvailable(status.available)
      if (!status.available) return fail(reasonCode(status))
      // First use: ask for the microphone, then speech recognition; a denial explains where to fix it.
      let perms = await call('speech', 'permissions')
      for (let asked = 0; asked < 3; asked++) {
        const step = permissionStep(perms)
        if (step.kind === 'ok') break
        if (step.kind === 'denied') return fail(step.what === 'microphone' ? 'mic-denied' : 'speech-denied')
        perms = await call('speech', 'request', step.what)
      }
      const next = permissionStep(perms)
      if (next.kind !== 'ok') return fail(next.what === 'microphone' ? 'mic-denied' : 'speech-denied')
      const id = await call('speech', 'startDictation')
      if (stateRef.current !== 'starting') {
        // Cancelled while it started.
        void call('speech', 'cancel', id).catch(() => undefined)
        return
      }
      session.current = id
      setState('listening')
      stateRef.current = 'listening'
      for (const e of early.current.splice(0)) if (e.id === id) handle(e.event)
    } catch (err) {
      fail(codeFromError(err))
    }
  }

  const stop = (): Promise<string> => {
    const id = session.current
    if (!id || stateRef.current !== 'listening') return Promise.resolve('')
    setState('transcribing')
    stateRef.current = 'transcribing'
    setLevel(0)
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        if (stopped.current) finish()
      }, STOP_TIMEOUT_MS)
      stopped.current = (text) => {
        clearTimeout(timer)
        resolve(text)
      }
      void call('speech', 'stop', id).catch((err: unknown) => {
        if (session.current === id) {
          const waiter = stopped.current
          stopped.current = null
          clearTimeout(timer)
          const text = finals.current.join(' ').trim()
          fail(codeFromError(err))
          waiter?.(text)
        }
      })
    })
  }

  function cancel(): void {
    const id = session.current
    session.current = null
    finals.current = []
    stopped.current?.('')
    stopped.current = null
    setState('idle')
    stateRef.current = 'idle'
    setLevel(0)
    setPartial('')
    setHeard('')
    if (id) void call('speech', 'cancel', id).catch(() => undefined)
  }

  return {
    state,
    level,
    partial,
    heard,
    error,
    available,
    start,
    stop,
    cancel,
    dismissError: () => {
      setError(null)
      if (stateRef.current === 'error') setState('idle')
    },
  }
}

/** Runs an error's fix: open the right Privacy pane, Settings › Transcription, or try again. */
export function runErrorAction(error: DictationError, retry: () => void): void {
  const action = error.copy.action
  if (!action) return
  if (action.kind === 'privacy') void call('speech', 'openPrivacySettings', action.what).catch(() => undefined)
  else if (action.kind === 'settings') void call('pages', 'open', 'atelier://settings/transcription').catch(() => undefined)
  else retry()
}
