/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, AudioLines, Ellipsis, FileQuestion, MessageSquarePlus, Mic, Square } from 'lucide-react'
import type { MeetingDetail } from '@shared/meetings'
import { atelier, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { isWindows } from '../system/platform'
import { DestinationFrame } from '../settings/destinations/common'
import { Notice } from '../settings/kit'
import { Button, EmptyState, ErrorState, IconButton, InlineRename, SkeletonRows, Spinner, cx, formatAbsolute, showPopoverMenu, toast, useConfirm, type PopoverItem } from '../ui'
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer'
import { SummaryCard } from './SummaryCard'
import { SpeakerLabels, Transcript } from './Transcript'
import { askAboutMeeting, attachToChat, deleteMeeting, exportMeetingFile, retranscribeMeeting, summarizeMeeting } from './actions'
import { useCaptureStatus, useMeetingDetail } from './hooks'
import { clock, rowActions, statusBadge, transcribeLabel } from './logic'
import './meetings.css'

// atelier://meetings/<id> (MV-13): the notes card, the transcript as labelled
// bubbles, the audio player when audio was kept, a live banner with captions
// while transcription runs, and "Ask about this meeting", which
// opens a chat with the meeting attached. A meeting recorded as audio only
// is its player, with why and Transcribe, until it is transcribed.

export function MeetingDetailView({ tabId, meetingId }: { tabId: string; meetingId: string }): ReactElement {
  const t = useT()
  const { meeting, error, gone, reload } = useMeetingDetail(meetingId)
  const back = (): void => void atelier.nav.go(tabId, 'atelier://meetings')

  if (gone || (error && !meeting && /no longer exists/i.test(error))) {
    return (
      <DestinationFrame label={t('meetings.page.title')}>
        <EmptyState
          icon={<FileQuestion />}
          title={t('meetings.detail.gone')}
          description={t('meetings.detail.goneHint')}
          action={
            <Button variant="secondary" icon={<ArrowLeft />} onClick={back}>
              {t('meetings.detail.back')}
            </Button>
          }
        />
      </DestinationFrame>
    )
  }
  if (!meeting) {
    return (
      <DestinationFrame label={t('meetings.page.title')}>
        <BackLink onClick={back} />
        {error ? <ErrorState message={error} onRetry={reload} /> : <SkeletonRows rows={5} label={t('meetings.loading')} />}
      </DestinationFrame>
    )
  }
  return <Detail meeting={meeting} onBack={back} />
}

function BackLink({ onClick }: { onClick(): void }): ReactElement {
  const t = useT()
  return (
    <button type="button" className="mt-back" onClick={onClick}>
      <ArrowLeft aria-hidden="true" />
      {t('meetings.detail.back')}
    </button>
  )
}

const WARNING_KEYS = {
  'screen-missing': 'meetings.warning.screenMissing',
  'device-fallback': 'meetings.warning.deviceFallback',
  interrupted: 'meetings.warning.interrupted',
} as const

function Detail({ meeting, onBack }: { meeting: MeetingDetail; onBack(): void }): ReactElement {
  const t = useT()
  const confirm = useConfirm()
  const capture = useCaptureStatus()
  const player = useRef<AudioPlayerHandle>(null)
  const [playingMs, setPlayingMs] = useState<number | null>(null)
  const [busy, setBusy] = useState<'summarize' | 'retranscribe' | 'stop' | null>(null)
  const actions = rowActions(meeting)
  const badge = statusBadge(meeting.status)
  const live = meeting.status === 'live' || meeting.status === 'finishing'
  const recordingThis = capture.meetingId === meeting.id && capture.state !== 'idle'
  // No transcript yet: the notes and transcript sections wait until it is transcribed.
  const audioOnly = Boolean(meeting.audioOnly)

  const rename = async (title: string): Promise<void> => {
    try {
      await call('meetings', 'rename', meeting.id, title)
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
      throw err
    }
  }
  const summarize = async (): Promise<void> => {
    setBusy('summarize')
    await summarizeMeeting(meeting.id)
    setBusy(null)
  }
  const retranscribe = async (): Promise<void> => {
    setBusy('retranscribe')
    await retranscribeMeeting(meeting.id, meeting.status === 'recorded')
    setBusy(null)
  }
  const stop = async (): Promise<void> => {
    setBusy('stop')
    try {
      await call('meetingCapture', 'stop')
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const more = async (anchor: HTMLElement): Promise<void> => {
    const items: PopoverItem[] = [
      ...(actions.attach ? [{ id: 'attach', label: t('meetings.row.attach') }] : []),
      ...(actions.retranscribe ? [{ id: 'retranscribe', label: t(transcribeLabel(meeting.status)) }] : []),
      ...(actions.exportMarkdown ? [{ id: 'export-md', label: t('meetings.row.exportMarkdown') }] : []),
      ...(actions.exportAudio ? [{ id: 'export-audio', label: t('meetings.row.exportAudio') }] : []),
      ...(actions.remove ? [{ id: 'sep', label: '', kind: 'separator' as const }, { id: 'delete', label: t('meetings.row.delete'), danger: true }] : []),
    ]
    const id = await showPopoverMenu(items, anchor, { label: t('meetings.row.menu'), width: 240, align: 'end' })
    if (id === 'attach') await attachToChat(meeting, anchor)
    else if (id === 'retranscribe') await retranscribe()
    else if (id === 'export-md') await exportMeetingFile(meeting.id, 'markdown')
    else if (id === 'export-audio') await exportMeetingFile(meeting.id, 'audio')
    else if (id === 'delete' && (await deleteMeeting(meeting, confirm))) onBack()
  }

  const Icon = meeting.kind === 'recording' ? Mic : AudioLines
  return (
    <DestinationFrame label={meeting.title}>
      <BackLink onClick={onBack} />
      <header className="mt-head">
        <div className="mt-head__text">
          <h1 className="mt-head__title">
            <InlineRename value={meeting.title} label={t('meetings.detail.titleLabel')} maxLength={200} onCommit={rename} />
          </h1>
          <p className="mt-head__meta">
            <Icon aria-hidden="true" />
            <span>{formatAbsolute(meeting.startedAt)}</span>
            <span aria-hidden="true">·</span>
            <span className="mt-tabular">{clock(meeting.durationMs)}</span>
            {badge && <span className={cx('mt-badge', `mt-badge--${badge.tone}`)}>{meeting.progress != null ? t('meetings.status.retranscribing', { percent: Math.round(meeting.progress * 100) }) : t(badge.label)}</span>}
          </p>
        </div>
        <div className="mt-head__actions">
          {actions.attach && (
            <Button variant="primary" icon={<MessageSquarePlus />} onClick={() => void askAboutMeeting(meeting)}>
              {t('meetings.detail.ask')}
            </Button>
          )}
          <IconButton label={t('meetings.row.menu')} icon={<Ellipsis />} onClick={(e) => void more(e.currentTarget)} />
        </div>
      </header>

      {live && (
        <div className="mt-banner" role="status">
          <span className="mt-live__dot" aria-hidden="true" data-paused={capture.state === 'paused' || undefined} />
          <span className="mt-banner__text">
            {meeting.status === 'finishing'
              ? meeting.progress != null
                ? t(audioOnly ? 'meetings.banner.transcribing' : 'meetings.banner.retranscribing')
                : t(audioOnly ? 'meetings.banner.saving' : 'meetings.banner.finishing')
              : capture.state === 'paused'
                ? t('meetings.banner.paused')
                : t(audioOnly ? 'meetings.banner.audioOnly' : 'meetings.banner.live')}
          </span>
          {recordingThis && meeting.status === 'live' && (
            <Button size="sm" variant="secondary" icon={busy === 'stop' ? <Spinner size={12} /> : <Square />} disabled={busy === 'stop'} onClick={() => void stop()}>
              {t('meetings.live.stop')}
            </Button>
          )}
        </div>
      )}

      {meeting.warnings.map((w) => (
        <Notice
          key={w}
          tone="info"
          action={
            // Recorded without the other side of the call: the fix is the Screen Recording pane.
            w === 'screen-missing' ? (
              <Button size="sm" variant="secondary" onClick={() => void call('speech', 'openPrivacySettings', 'screen')}>
                {t('speech.action.openSettings')}
              </Button>
            ) : undefined
          }
        >
          {t(WARNING_KEYS[w])}
        </Notice>
      ))}
      {meeting.status === 'failed' && (
        <Notice
          tone="error"
          action={
            actions.retranscribe ? (
              <Button size="sm" variant="secondary" loading={busy === 'retranscribe'} onClick={() => void retranscribe()}>
                {t('meetings.row.retranscribe')}
              </Button>
            ) : undefined
          }
        >
          {meeting.error === 'no-speech'
            ? t('meetings.detail.failedNoSpeech')
            : meeting.hasAudio
              ? t('meetings.detail.failedAudio')
              : audioOnly
                ? t('meetings.detail.failedRecording')
                : t('meetings.detail.failed')}
        </Notice>
      )}

      {meeting.status === 'recorded' && <AudioOnlyNotice meeting={meeting} transcribing={busy === 'retranscribe'} onTranscribe={() => void retranscribe()} />}

      {!audioOnly && <SummaryCard meeting={meeting} busy={busy === 'summarize'} onSummarize={() => void summarize()} />}

      {meeting.audioUrl && <AudioPlayer ref={player} src={meeting.audioUrl} durationMs={meeting.durationMs} onTime={setPlayingMs} />}

      {!audioOnly && (
        <section className="mt-section" aria-labelledby="mt-transcript-heading">
          <div className="mt-section__head">
            <h2 id="mt-transcript-heading" className="mt-section__title">
              {t('meetings.detail.transcript')}
            </h2>
            <SpeakerLabels meeting={meeting} />
          </div>
          <Transcript meeting={meeting} playingMs={playingMs} onPlayFrom={meeting.audioUrl ? (ms) => player.current?.playFrom(ms) : null} />
        </section>
      )}
    </DestinationFrame>
  )
}

/** Recorded as audio only: why, and Transcribe (after allowing Speech Recognition, when that was the reason). */
function AudioOnlyNotice({ meeting, transcribing, onTranscribe }: { meeting: MeetingDetail; transcribing: boolean; onTranscribe(): void }): ReactElement {
  const t = useT()
  const reason = meeting.audioOnly ?? 'chosen'
  const message = reason === 'speech-denied' ? t((isWindows() ? 'meetings.detail.audioOnlySpeech.win' : 'meetings.detail.audioOnlySpeech')) : reason === 'locale-unsupported' ? t((isWindows() ? 'meetings.detail.audioOnlyLocale.win' : 'meetings.detail.audioOnlyLocale')) : t('meetings.detail.audioOnly')
  // macOS asks only once; after that the switch is in System Settings.
  const allowSpeech = async (): Promise<void> => {
    const now = await call('speech', 'request', 'speech').catch(() => null)
    if (now?.speech !== 'granted') void call('speech', 'openPrivacySettings', 'speech')
  }
  return (
    <Notice
      tone="info"
      action={
        <span className="mt-notice-actions">
          {reason === 'speech-denied' && (
            <Button size="sm" variant="ghost" onClick={() => void allowSpeech()}>
              {t((isWindows() ? 'meetings.detail.allowSpeech.win' : 'meetings.detail.allowSpeech'))}
            </Button>
          )}
          <Button size="sm" variant="secondary" loading={transcribing} onClick={onTranscribe}>
            {t('meetings.row.transcribe')}
          </Button>
        </span>
      }
    >
      {message}
    </Notice>
  )
}
