/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type ReactElement } from 'react'
import { Play } from 'lucide-react'
import type { MeetingDetail } from '@shared/meetings'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { InlineRename, cx, toast, useReducedMotion } from '../ui'
import { activeSegment, clock, transcriptRuns } from './logic'

// The transcript as bubbles labelled by audio source (MV-13): your
// microphone on the right, everyone else on the left, because the helper
// hears sources rather than voices. Both labels can be renamed for this
// meeting. With audio kept, each line can be played from, and the line
// being played is highlighted. While transcription runs, the words still
// being recognised show as captions at the end.

export interface TranscriptProps {
  meeting: MeetingDetail
  /** The audio's position, or null when it isn't playing. */
  playingMs: number | null
  onPlayFrom: ((ms: number) => void) | null
}

export function SpeakerLabels({ meeting }: { meeting: MeetingDetail }): ReactElement {
  const t = useT()
  const rename = (source: 'mic' | 'system') => async (label: string) => {
    try {
      await call('meetings', 'renameLabel', meeting.id, source, label)
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
      throw err
    }
  }
  return (
    <div className="mt-speakers" role="group" aria-label={t('meetings.labels.group')}>
      <span className="mt-speakers__caption">{t('meetings.labels.caption')}</span>
      <span className="mt-speaker mt-speaker--mic">
        <span className="mt-speaker__dot" aria-hidden="true" />
        <InlineRename value={meeting.labels.mic} label={t('meetings.labels.mic')} maxLength={40} onCommit={rename('mic')} />
      </span>
      <span className="mt-speaker mt-speaker--system">
        <span className="mt-speaker__dot" aria-hidden="true" />
        <InlineRename value={meeting.labels.system} label={t('meetings.labels.system')} maxLength={40} onCommit={rename('system')} />
      </span>
    </div>
  )
}

export function Transcript({ meeting, playingMs, onPlayFrom }: TranscriptProps): ReactElement {
  const t = useT()
  const reduced = useReducedMotion()
  const runs = transcriptRuns(meeting.segments)
  const active = playingMs === null ? -1 : activeSegment(meeting.segments, playingMs)
  const activeEl = useRef<HTMLLIElement | null>(null)

  // Keep the line being played in view, without yanking the page around.
  useEffect(() => {
    if (active >= 0) activeEl.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
  }, [active])

  const liveSources = (['mic', 'system'] as const).filter((s) => meeting.live[s]?.trim())
  if (meeting.segments.length === 0 && liveSources.length === 0) {
    return <p className="mt-transcript__empty">{meeting.status === 'live' ? t('meetings.detail.waitingForWords') : t('meetings.detail.noTranscript')}</p>
  }
  return (
    <ol className="mt-transcript" aria-label={t('meetings.detail.transcript')}>
      {runs.map((run) => (
        <li key={run.segments[0]?.id ?? run.start} className={cx('mt-run', `mt-run--${run.source}`)}>
          <span className="mt-run__label">{meeting.labels[run.source]}</span>
          <ol className="mt-run__lines">
            {run.segments.map((s, i) => {
              const index = run.start + i
              const on = index === active
              return (
                <li key={s.id} ref={on ? activeEl : undefined} className={cx('mt-line', on && 'mt-line--active')} aria-current={on || undefined}>
                  <span className="mt-line__bubble">{s.text}</span>
                  {onPlayFrom ? (
                    <button type="button" className="mt-line__time mt-tabular" aria-label={t('meetings.detail.playFrom', { time: clock(s.startMs) })} onClick={() => onPlayFrom(s.startMs)}>
                      <Play aria-hidden="true" />
                      {clock(s.startMs)}
                    </button>
                  ) : (
                    <span className="mt-line__time mt-tabular">{clock(s.startMs)}</span>
                  )}
                </li>
              )
            })}
          </ol>
        </li>
      ))}
      {/* Captions for the words still being recognised. */}
      {liveSources.map((source) => (
        <li key={`live-${source}`} className={cx('mt-run', `mt-run--${source}`, 'mt-run--live')} aria-live="polite">
          <span className="mt-run__label">{meeting.labels[source]}</span>
          <ol className="mt-run__lines">
            <li className="mt-line mt-line--live">
              <span className="mt-line__bubble">{meeting.live[source]}</span>
            </li>
          </ol>
        </li>
      ))}
    </ol>
  )
}
