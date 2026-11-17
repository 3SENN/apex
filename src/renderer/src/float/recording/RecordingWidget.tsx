/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { CaptionsOff, GripVertical, Mic, Pause, Play, Square } from 'lucide-react'
import { formatElapsed, type RecordingPayload } from '@shared/meetingCapture'
import type { FloatEvent } from '@shared/float'
import { t } from '../../i18n/useT'
import { isWindows } from '../../system/platform'
import { IconButton } from '../../ui/Button'
import { Spinner } from '../../ui/indicators'
import { useMotion } from '../../ui/motion'
import '../../ui/ui.css'
import { floatInvoke, useFloatEvent, useFloatPayload } from '../api'
import { WrapUpCard } from './WrapUp'

// The recording widget (MV-10): elapsed time in tabular digits, live level
// bars, pause and resume, stop, and a drag handle on hover. Main shows it
// only while the place the recording started from is out of view. Once
// stopped it grows into the wrap-up card (MV-11). When this Mac couldn't
// transcribe the meeting it records audio only, and a small icon says so.

const BAR_SCALE = [0.55, 0.8, 1, 0.75, 0.5]
/** Levels fade out when the helper goes quiet. */
const LEVEL_DECAY_MS = 400

/** Why only audio is recorded, as this system says it (Windows has online speech recognition, not a Mac's). */
function audioOnlyTip(fallback: 'speech-denied' | 'locale-unsupported') {
  if (fallback === 'speech-denied') return isWindows() ? 'capture.widget.audioOnlySpeech.win' : 'capture.widget.audioOnlySpeech'
  return isWindows() ? 'capture.widget.audioOnlyLocale.win' : 'capture.widget.audioOnlyLocale'
}

function LevelBars(): ReactElement {
  const { reduced } = useMotion()
  const [level, setLevel] = useState(0)
  const last = useRef({ mic: 0, system: 0, at: 0 })
  const onEvent = useCallback((e: FloatEvent) => {
    if (e.type !== 'level') return
    const l = last.current
    l[e.source] = Math.min(1, Math.max(0, e.peak))
    l.at = Date.now()
    setLevel(Math.max(l.mic, l.system))
  }, [])
  useFloatEvent(onEvent)
  useEffect(() => {
    const timer = setInterval(() => {
      if (Date.now() - last.current.at > LEVEL_DECAY_MS) {
        last.current.mic = 0
        last.current.system = 0
        setLevel(0)
      }
    }, LEVEL_DECAY_MS)
    return () => clearInterval(timer)
  }, [])
  return (
    <span className="rw-bars" data-snap={reduced || undefined} role="img" aria-label={t('capture.widget.levels')}>
      {BAR_SCALE.map((scale, i) => (
        // Speech peaks sit low; the square root lifts them into view.
        <i key={i} style={{ transform: `scaleY(${Math.max(0.15, Math.min(1, Math.sqrt(level) * scale * 1.3))})` }} />
      ))}
    </span>
  )
}

function LiveWidget({ payload }: { payload: RecordingPayload }): ReactElement {
  const { status } = payload
  const [busy, setBusy] = useState<'pause' | 'stop' | null>(null)
  // Elapsed time runs on from the last status main sent.
  const [base, setBase] = useState(() => ({ at: Date.now(), elapsed: status.elapsedMs }))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setBase({ at: Date.now(), elapsed: status.elapsedMs })
    setBusy(null)
  }, [status.elapsedMs, status.state, status.pausedBy])
  const running = status.state === 'recording'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [running])
  const elapsed = running ? base.elapsed + Math.max(0, now - base.at) : base.elapsed
  const time = formatElapsed(elapsed)

  const call = (method: 'meetingCapture.pause' | 'meetingCapture.resume' | 'meetingCapture.stop', kind: 'pause' | 'stop'): void => {
    if (busy) return
    setBusy(kind)
    floatInvoke(method).catch(() => setBusy(null))
  }

  const paused = status.state === 'paused'
  const reconnecting = status.warnings.includes('interrupted')
  const micOnly = status.warnings.includes('screen-missing')
  // Audio only because this Mac couldn't transcribe (not because you chose it).
  const fallback = status.audioOnly === 'speech-denied' || status.audioOnly === 'locale-unsupported' ? status.audioOnly : null
  const settling = status.state === 'starting' || status.state === 'stopping'
  let note: string | null = null
  if (status.state === 'starting') note = t('capture.widget.starting')
  else if (status.state === 'stopping') note = t('capture.widget.finishing')
  else if (reconnecting) note = t('capture.widget.reconnecting')
  // A lid pause says why; the widget widens to fit it.
  else if (paused) note = status.pausedBy === 'lid' ? t('capture.widget.pausedLid') : t('capture.widget.paused')

  return (
    <div className="float-card rw" data-state={status.state} role="group" aria-label={t('capture.widget.recording', { time })}>
      <span className="rw-handle" title={t('capture.widget.drag')} aria-hidden="true">
        <GripVertical size={14} />
      </span>
      <span className="rw-dot" aria-hidden="true" />
      <span className="rw-time">{time}</span>
      {micOnly && (
        <button type="button" className="rw-warn" aria-label={t('capture.widget.micOnlyFix')} title={t('capture.widget.micOnly')} onClick={() => void floatInvoke('recording:fix-screen').catch(() => undefined)}>
          <Mic size={12} />
        </button>
      )}
      {fallback && (
        <button
          type="button"
          className="rw-warn"
          aria-label={t(audioOnlyTip(fallback))}
          title={t(audioOnlyTip(fallback))}
          onClick={() => void floatInvoke('recording:transcription-settings').catch(() => undefined)}
        >
          <CaptionsOff size={12} />
        </button>
      )}
      {note ? (
        <span className="rw-note" title={note}>
          {settling && <Spinner size={10} />}
          {note}
        </span>
      ) : (
        <LevelBars />
      )}
      <span className="rw-controls">
        {paused ? (
          <IconButton size="sm" label={t('capture.widget.resume')} icon={<Play size={14} />} disabled={busy !== null} onClick={() => call('meetingCapture.resume', 'pause')} />
        ) : (
          <IconButton size="sm" label={t('capture.widget.pause')} icon={<Pause size={14} />} disabled={busy !== null || status.state !== 'recording'} onClick={() => call('meetingCapture.pause', 'pause')} />
        )}
        <IconButton
          size="sm"
          tone="danger"
          label={t('capture.widget.stop')}
          icon={busy === 'stop' ? <Spinner size={12} /> : <Square size={12} fill="currentColor" />}
          disabled={busy !== null || (status.state !== 'recording' && status.state !== 'paused')}
          onClick={() => call('meetingCapture.stop', 'stop')}
        />
      </span>
    </div>
  )
}

export function RecordingWidget(): ReactElement | null {
  const payload = useFloatPayload<RecordingPayload>()
  if (!payload) return null
  if (payload.wrapUp) return <WrapUpCard wrapUp={payload.wrapUp} />
  return <LiveWidget payload={payload} />
}
