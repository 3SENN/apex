/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The microphone test (ST-21): records a few seconds without transcribing,
// with live meters (drawn by the owner from the same session), then the last
// test can be played back or deleted. Main stops a test after 30 s.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Mic, Pause, Play, Square, Trash2 } from 'lucide-react'
import { t } from '@shared/i18n/core'
import { call } from '../api'
import { useResource } from '../settings/data'
import { Button, Skeleton, toast } from '../ui'
import { copyForError, type SpeechCopy } from './errorCopy'
import type { SessionView } from './hooks'
import { formatClock } from './logic'
import { SpeechNotice } from './SpeechNotice'

export interface MicTestProps {
  /** The level-test session's live view. */
  session: SessionView
  disabled?: boolean
  onChooseMic?(): void
}

export function MicTest({ session, disabled = false, onChooseMic }: MicTestProps): ReactElement {
  const info = useResource(() => call('transcription', 'testInfo'))
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null)
  const [error, setError] = useState<SpeechCopy | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [playing, setPlaying] = useState(false)
  const [version, setVersion] = useState(0)
  const audio = useRef<HTMLAudioElement>(null)
  const recording = session.state === 'listening' || session.state === 'paused' || busy === 'starting'

  // The clock ticks only while recording.
  useEffect(() => {
    if (!recording || startedAt === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [recording, startedAt])

  // A test main stopped by itself (the 30 s limit) or lost still refreshes the last one.
  useEffect(() => {
    if (session.state === 'stopped' || session.state === 'failed') {
      setStartedAt(null)
      void info.reload()
      setVersion((v) => v + 1)
      if (session.error) setError(session.error)
    }
  }, [session.state])

  async function start(): Promise<void> {
    setError(null)
    audio.current?.pause()
    setBusy('starting')
    try {
      await call('transcription', 'testStart')
      setStartedAt(Date.now())
      setNow(Date.now())
    } catch (err) {
      setError(copyForError(err))
    } finally {
      setBusy(null)
    }
  }

  async function stop(): Promise<void> {
    setBusy('stopping')
    try {
      await call('transcription', 'testStop')
    } catch (err) {
      setError(copyForError(err))
    } finally {
      setBusy(null)
      setStartedAt(null)
      setVersion((v) => v + 1)
      void info.reload()
    }
  }

  function togglePlay(): void {
    const el = audio.current
    if (!el) return
    if (el.paused) {
      el.play().catch(() => setError({ code: 'failed', message: t('speech.test.playFailed'), tone: 'warning', action: null }))
    } else {
      el.pause()
    }
  }

  function remove(): void {
    audio.current?.pause()
    void call('transcription', 'testDelete').then(() => {
      void info.reload()
      toast.show({ message: t('speech.test.deleted') })
    })
  }

  const last = info.data
  return (
    <div className="sk-test">
      <div className="sk-test__row">
        {recording ? (
          <Button variant="secondary" size="sm" icon={<Square />} loading={busy !== null} onClick={() => void stop()}>
            {t('speech.test.stop')}
          </Button>
        ) : (
          <Button variant="secondary" size="sm" icon={<Mic />} disabled={disabled} onClick={() => void start()}>
            {t('speech.test.start')}
          </Button>
        )}
        <span className="sk-test__status" aria-live="polite">
          {recording && startedAt !== null
            ? t('speech.test.recording', { elapsed: formatClock(now - startedAt) })
            : info.loading && !last
              ? <Skeleton width={120} />
              : last?.exists
                ? t('speech.test.last', { duration: formatClock(last.durationMs) })
                : t('speech.test.none')}
        </span>
        {!recording && last?.exists && last.url && (
          <span className="sk-test__playback">
            <Button variant="ghost" size="sm" icon={playing ? <Pause /> : <Play />} onClick={togglePlay}>
              {playing ? t('speech.test.pause') : t('speech.test.play')}
            </Button>
            <Button variant="ghost" size="sm" icon={<Trash2 />} onClick={remove}>
              {t('speech.test.delete')}
            </Button>
            <audio
              key={version}
              ref={audio}
              src={last.url}
              preload="none"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onError={() => setPlaying(false)}
            />
          </span>
        )}
      </div>
      {error && <SpeechNotice copy={error} onRetry={() => void start()} onChooseMic={onChooseMic} onDismiss={() => setError(null)} />}
    </div>
  )
}
