/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactElement } from 'react'
import { Mic, SearchX, Square } from 'lucide-react'
import { decodeSpeechError } from '@shared/speech'
import { apex, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { DestinationFrame } from '../settings/destinations/common'
import { ListFrame, PageHeader, SearchField } from '../settings/kit'
import { SpeechNotice, actionLabel, copyForError, errorCopy, type SpeechCopy } from '../speech'
import { EmptyState, ErrorState, SegmentedControl, SkeletonRows, Spinner, toast, type ToastOptions } from '../ui'
import { MeetingRow } from './MeetingRow'
import { MeetingsExplainer } from './MeetingsExplainer'
import { useCaptureStatus, useMeetingList } from './hooks'
import { clock, kindFor, type MeetingsFilter } from './logic'
import './meetings.css'

// apex://meetings (MV-12, DS-105): the header with the start pill, the
// Meetings/Recordings segments and search, the live row while a recording
// runs, then the rows. Loading, empty and no-results states are designed.
// A start that fails says why with its fix (the right System Settings pane,
// for one); a recording without the other side of the call says so.

/** The toast's button for a speech failure's fix, when it has one. */
function startFixAction(copy: SpeechCopy, o: { retry(): void; openTranscription(): void }): ToastOptions['action'] {
  const action = copy.action
  if (!action) return undefined
  const label = actionLabel(action)
  if (action.kind === 'open-settings') return { label, onAction: () => void call('speech', 'openPrivacySettings', action.pane) }
  if (action.kind === 'retry') return { label, onAction: o.retry }
  return { label, onAction: o.openTranscription }
}

export interface MeetingListProps {
  tabId: string
  initialFilter: MeetingsFilter
  initialQuery: string
}

export function MeetingList({ tabId, initialFilter, initialQuery }: MeetingListProps): ReactElement {
  const t = useT()
  const [filter, setFilter] = useState<MeetingsFilter>(initialFilter)
  const [query, setQuery] = useState(initialQuery)
  const list = useMeetingList(kindFor(filter), query)
  const capture = useCaptureStatus()
  const [starting, setStarting] = useState(false)
  const recording = capture.state !== 'idle'

  // The destination row clicked again brings the page back to its root view.
  useEffect(() => {
    setFilter(initialFilter)
    setQuery(initialQuery)
  }, [initialFilter, initialQuery])

  const start = async (): Promise<void> => {
    if (starting || recording) return
    setStarting(true)
    try {
      await call('meetingCapture', 'start', { kind: kindFor(filter) })
    } catch (err) {
      // Speech failures cross tagged with their code: say why, with the fix (a denied permission opens its pane).
      if (!decodeSpeechError(errorText(err))) {
        toast.show({ message: errorText(err), tone: 'error' })
        return
      }
      const copy = copyForError(err)
      const action = startFixAction(copy, { retry: () => void start(), openTranscription: () => void apex.nav.go(tabId, 'apex://settings/transcription') })
      toast.show({ message: copy.message, tone: copy.tone === 'error' ? 'error' : 'info', ...(action ? { action } : {}) })
    } finally {
      setStarting(false)
    }
  }
  // Without Screen Recording the helper hears only the microphone: said plainly, with the fix, while it records.
  const micOnly = recording && capture.warnings.includes('screen-missing')

  const live = list.items?.find((m) => m.status === 'live') ?? null
  const rows = (list.items ?? []).filter((m) => m.status !== 'live' || m.id !== capture.meetingId)
  const searching = query.trim() !== ''

  return (
    <DestinationFrame label={t('meetings.page.title')}>
      <PageHeader
        title={t('meetings.page.title')}
        description={t('meetings.page.description')}
        actions={
          <button type="button" className="mt-start" onClick={() => void start()} disabled={starting || recording} aria-busy={starting || undefined} title={recording ? t('meetings.start.busy') : undefined}>
            {starting ? <Spinner size={14} /> : <Mic aria-hidden="true" />}
            {filter === 'recordings' ? t('meetings.start.recording') : t('meetings.start.meeting')}
          </button>
        }
      />
      <div className="sp-toolbar mt-toolbar">
        <SegmentedControl<MeetingsFilter>
          label={t('meetings.segment.label')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'meetings', label: t('meetings.segment.meetings') },
            { value: 'recordings', label: t('meetings.segment.recordings') },
          ]}
        />
        <div className="mt-toolbar__search">
          <SearchField value={query} onChange={setQuery} placeholder={filter === 'recordings' ? t('meetings.search.recordings') : t('meetings.search.meetings')} />
        </div>
      </div>
      {recording && capture.meetingId && <LiveRow title={live?.title ?? null} meetingId={capture.meetingId} startedAt={capture.startedAt} elapsedMs={capture.elapsedMs} paused={capture.state === 'paused'} stopping={capture.state === 'stopping' || capture.state === 'processing'} tabId={tabId} />}
      {micOnly && <SpeechNotice copy={errorCopy('screen-missing')} />}
      {list.items === null ? (
        <ListFrame>{list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : <SkeletonRows rows={4} label={t('meetings.loading')} />}</ListFrame>
      ) : rows.length === 0 && !recording ? (
        searching ? (
          <ListFrame>
            <EmptyState
              icon={<SearchX />}
              title={t('meetings.search.none')}
              description={t('meetings.search.noneHint')}
              action={
                <button type="button" className="sp-link" onClick={() => setQuery('')}>
                  {t('meetings.search.clear')}
                </button>
              }
            />
          </ListFrame>
        ) : (
          <MeetingsExplainer filter={filter} onStart={() => void start()} disabled={starting || recording} />
        )
      ) : (
        <ul className="mt-list" aria-label={filter === 'recordings' ? t('meetings.segment.recordings') : t('meetings.segment.meetings')}>
          {rows.map((m) => (
            <MeetingRow key={m.id} meeting={m} />
          ))}
        </ul>
      )}
    </DestinationFrame>
  )
}

function LiveRow({ title, meetingId, startedAt, elapsedMs, paused, stopping, tabId }: { title: string | null; meetingId: string; startedAt: number | null; elapsedMs: number; paused: boolean; stopping: boolean; tabId: string }): ReactElement {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (paused || stopping) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [paused, stopping])
  // Elapsed time excludes pauses; the recorder reports it with each status, and it ticks on from there while recording.
  const [base, setBase] = useState(() => ({ at: Date.now(), elapsed: elapsedMs }))
  useEffect(() => setBase({ at: Date.now(), elapsed: elapsedMs }), [elapsedMs, paused])
  const shown = paused || stopping ? elapsedMs : Math.max(elapsedMs, base.elapsed + (now - base.at))
  void startedAt
  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('meetingCapture', 'stop')
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-live" role="group" aria-label={t('meetings.live.label')}>
      <span className="mt-live__dot" aria-hidden="true" data-paused={paused || undefined} />
      <button type="button" className="mt-live__main" onClick={() => void apex.nav.go(tabId, `apex://meetings/${meetingId}`)}>
        <span className="mt-live__title">{title ?? t('meetings.live.untitled')}</span>
        <span className="mt-live__meta">
          {stopping ? t('meetings.live.finishing') : paused ? t('meetings.live.paused') : t('meetings.live.recording')} · <span className="mt-tabular">{clock(shown)}</span>
        </span>
      </button>
      <button type="button" className="mt-live__stop" onClick={() => void stop()} disabled={busy || stopping}>
        {busy || stopping ? <Spinner size={12} /> : <Square aria-hidden="true" />}
        {t('meetings.live.stop')}
      </button>
    </div>
  )
}
