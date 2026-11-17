/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { forwardRef, useImperativeHandle, useRef, useState, type ReactElement } from 'react'
import { Pause, Play } from 'lucide-react'
import { useT } from '../i18n/useT'
import { clock } from './logic'

// The meeting's kept audio (MV-13), served by apex-media with Range
// so seeking works: play and pause, a seek bar, the time, and playFrom() for
// the transcript's play-from-line buttons. It reports the time so the line
// being played can be highlighted.

export interface AudioPlayerHandle {
  playFrom(ms: number): void
}

export interface AudioPlayerProps {
  src: string
  /** The meeting's length, used until the file's own duration is known. */
  durationMs: number
  onTime(ms: number | null): void
}

export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(function AudioPlayer({ src, durationMs, onTime }, ref): ReactElement {
  const t = useT()
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(durationMs)
  const [failed, setFailed] = useState(false)

  useImperativeHandle(ref, () => ({
    playFrom: (ms) => {
      const el = audio.current
      if (!el) return
      el.currentTime = ms / 1000
      setTime(ms)
      void el.play().catch(() => setFailed(true))
    },
  }))

  const toggle = (): void => {
    const el = audio.current
    if (!el) return
    if (el.paused) void el.play().catch(() => setFailed(true))
    else el.pause()
  }

  if (failed) {
    return (
      <div className="mt-player mt-player--failed" role="alert">
        {t('meetings.player.failed')}
        <button type="button" className="sp-link" onClick={() => setFailed(false)}>
          {t('meetings.player.retry')}
        </button>
      </div>
    )
  }

  return (
    <div className="mt-player" role="group" aria-label={t('meetings.player.label')}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false)
        }}
        onEnded={() => {
          setPlaying(false)
          onTime(null)
        }}
        onTimeUpdate={(e) => {
          const ms = e.currentTarget.currentTime * 1000
          setTime(ms)
          onTime(ms)
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          if (Number.isFinite(d) && d > 0) setDuration(d * 1000)
        }}
        onError={() => setFailed(true)}
      />
      <button type="button" className="mt-player__play" aria-label={playing ? t('meetings.player.pause') : t('meetings.player.play')} onClick={toggle}>
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </button>
      <span className="mt-player__time mt-tabular" aria-hidden="true">
        {clock(time)}
      </span>
      <input
        className="mt-player__seek"
        type="range"
        min={0}
        max={Math.max(1, Math.round(duration))}
        step={1000}
        value={Math.min(time, duration)}
        aria-label={t('meetings.player.seek')}
        aria-valuetext={`${clock(time)} / ${clock(duration)}`}
        onChange={(e) => {
          const ms = Number(e.target.value)
          setTime(ms)
          if (audio.current) audio.current.currentTime = ms / 1000
          onTime(ms)
        }}
      />
      <span className="mt-player__time mt-tabular" aria-hidden="true">
        {clock(duration)}
      </span>
    </div>
  )
})
