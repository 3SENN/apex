/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, type ReactElement, type MouseEvent } from 'react'
import { AudioLines, Ellipsis, FileAudio, Mic, Sparkles } from 'lucide-react'
import type { MeetingSummary } from '@shared/meetings'
import { call } from '../api'
import { useT } from '../i18n/useT'
import { IconButton, RelativeTime, Spinner, cx, showContextMenu, showPopoverMenu, useConfirm, type PopoverAnchor, type PopoverItem } from '../ui'
import { attachToChat, deleteMeeting, exportMeetingFile, retranscribeMeeting, summarizeMeeting } from './actions'
import { clock, rowActions, statusBadge, transcribeLabel } from './logic'

// One meeting or recording in the list (MV-12): title, when and how long,
// its state, and the first words of its notes or transcript. Its actions sit
// in a ⋯ menu and the context menu: summarise, transcribe (one recorded as
// audio only, or again after a failure), attach to a chat, export, delete.

export function MeetingRow({ meeting }: { meeting: MeetingSummary }): ReactElement {
  const t = useT()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const actions = rowActions(meeting)
  const badge = statusBadge(meeting.status)
  const open = (): void => void call('pages', 'open', `atelier://meetings/${meeting.id}`)

  const items = (): PopoverItem[] => [
    { id: 'open', label: t('meetings.row.open') },
    ...(actions.summarize ? [{ id: 'summarize', label: meeting.status === 'summarized' ? t('meetings.row.summarizeAgain') : t('meetings.row.summarize') }] : []),
    ...(actions.retranscribe ? [{ id: 'retranscribe', label: t(transcribeLabel(meeting.status)) }] : []),
    ...(actions.attach ? [{ id: 'attach', label: t('meetings.row.attach') }] : []),
    { id: 'sep1', label: '', kind: 'separator' as const },
    ...(actions.exportMarkdown ? [{ id: 'export-md', label: t('meetings.row.exportMarkdown') }] : []),
    ...(actions.exportAudio ? [{ id: 'export-audio', label: t('meetings.row.exportAudio') }] : []),
    ...(actions.remove ? [{ id: 'sep2', label: '', kind: 'separator' as const }, { id: 'delete', label: t('meetings.row.delete'), danger: true }] : []),
  ]

  const run = async (id: string | null, anchor: PopoverAnchor): Promise<void> => {
    if (!id) return
    if (id === 'open') return open()
    if (id === 'attach') return attachToChat(meeting, anchor)
    if (id === 'export-md') return exportMeetingFile(meeting.id, 'markdown')
    if (id === 'export-audio') return exportMeetingFile(meeting.id, 'audio')
    if (id === 'delete') {
      await deleteMeeting(meeting, confirm)
      return
    }
    setBusy(true)
    try {
      if (id === 'summarize') await summarizeMeeting(meeting.id)
      else if (id === 'retranscribe') await retranscribeMeeting(meeting.id, meeting.status === 'recorded')
    } finally {
      setBusy(false)
    }
  }

  const onContext = (e: MouseEvent): void => {
    const point = { x: e.clientX, y: e.clientY }
    void showContextMenu(
      e,
      items().map((i) => (i.kind === 'separator' ? { id: i.id, label: '', type: 'separator' as const } : { id: i.id, label: i.label, danger: i.danger })),
    ).then((id) => run(id, point))
  }

  const Icon = meeting.kind === 'recording' ? Mic : AudioLines
  const working = busy || meeting.status === 'summarizing' || meeting.status === 'finishing'
  return (
    <li className={cx('mt-row', meeting.status === 'failed' && 'mt-row--failed')} onContextMenu={onContext}>
      <button type="button" className="mt-row__main" onClick={open}>
        <span className="mt-row__icon" aria-hidden="true">
          <Icon />
        </span>
        <span className="mt-row__body">
          <span className="mt-row__title">{meeting.title}</span>
          <span className="mt-row__meta">
            <RelativeTime value={meeting.startedAt} />
            <span aria-hidden="true"> · </span>
            <span className="mt-tabular">{clock(meeting.durationMs)}</span>
            {meeting.hasAudio && (
              <span className="mt-row__audio" title={t('meetings.row.hasAudio')}>
                <FileAudio aria-label={t('meetings.row.hasAudio')} />
              </span>
            )}
            {badge && (
              <span className={cx('mt-badge', `mt-badge--${badge.tone}`)}>
                {meeting.progress != null ? t('meetings.status.retranscribing', { percent: Math.round(meeting.progress * 100) }) : t(badge.label)}
              </span>
            )}
          </span>
          {meeting.snippet && <span className="mt-row__snippet">{meeting.snippet}</span>}
        </span>
      </button>
      <span className="mt-row__actions">
        {working && <Spinner size={14} label={t('meetings.row.working')} />}
        {actions.summarize && meeting.status !== 'summarized' && !working && (
          <IconButton size="sm" label={t('meetings.row.summarize')} icon={<Sparkles />} onClick={() => void run('summarize', { x: 0, y: 0 })} />
        )}
        <IconButton
          size="sm"
          label={t('meetings.row.more', { title: meeting.title })}
          icon={<Ellipsis />}
          onClick={(e) => {
            const anchor = e.currentTarget
            void showPopoverMenu(items(), anchor, { label: t('meetings.row.menu'), width: 240, align: 'end' }).then((id) => run(id, anchor))
          }}
        />
      </span>
    </li>
  )
}
