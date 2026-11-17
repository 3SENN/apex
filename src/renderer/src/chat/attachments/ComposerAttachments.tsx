/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { AudioLines, Image as ImageIcon, X } from 'lucide-react'
import { UNSETTLED_STATUSES } from '@shared/meetings'
import { useT } from '../../i18n/useT'
import { meetingStatus, meetingTitle, useMeetingStatusVersion } from '../../meetings/status'
import { Button, Spinner, cx } from '../../ui'
import { removeFromDraft, useDraftAttachments, type DraftAttachment } from './drafts'
import { useHeldSend } from './holds'
import './attachments.css'

// The composer's attachment chips (CH-06, MV-14): attached meetings and
// screenshots above the field, each removable, a meeting showing while its
// transcript is still being finished; and the waiting chip for a message
// held until that transcript is ready, with Cancel.

function chipLabel(d: DraftAttachment): string {
  if (d.attachment.kind === 'meeting') return meetingTitle(d.attachment.meetingId) ?? d.label
  return d.label
}

export function ComposerAttachments({ chatId, onCancelHold }: { chatId: string; onCancelHold(): void }): ReactElement | null {
  const t = useT()
  const items = useDraftAttachments(chatId)
  const hold = useHeldSend(chatId)
  useMeetingStatusVersion()
  if (items.length === 0 && !hold) return null
  const waitingTitles = hold ? hold.waitingFor.map((id) => meetingTitle(id) ?? t('meetings.untitled')) : []
  return (
    <div className="chat-attach">
      {hold && (
        <div className="chat-attach__waiting" role="status">
          <Spinner size={14} />
          <div className="chat-attach__waiting-text">
            <p className="chat-attach__waiting-title">
              {waitingTitles.length === 1 ? t('meetings.waiting.one', { title: waitingTitles[0] ?? '' }) : t('meetings.waiting.many', { count: waitingTitles.length })}
            </p>
            <p className="chat-attach__waiting-message">{hold.text}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={onCancelHold}>
            {t('meetings.waiting.cancel')}
          </Button>
        </div>
      )}
      {items.length > 0 && (
        <ul className="chat-attach__chips" aria-label={t('meetings.attach.label')}>
          {items.map((d, i) => {
            const meeting = d.attachment.kind === 'meeting' ? d.attachment.meetingId : null
            const status = meeting ? meetingStatus(meeting) : null
            const unsettled = status !== null && UNSETTLED_STATUSES.includes(status)
            const label = chipLabel(d)
            return (
              <li key={`${d.attachment.kind}-${meeting ?? i}`} className={cx('chat-attach__chip', unsettled && 'chat-attach__chip--pending')}>
                <span className="chat-attach__icon" aria-hidden="true">
                  {d.thumbnail ? <img src={d.thumbnail} alt="" /> : meeting ? <AudioLines /> : <ImageIcon />}
                </span>
                <span className="chat-attach__name" title={label}>{label}</span>
                {unsettled && (
                  <span className="chat-attach__sub">
                    <Spinner size={10} />
                    {t('meetings.attach.transcribing')}
                  </span>
                )}
                <button type="button" className="chat-attach__remove" aria-label={t('meetings.attach.remove', { name: label })} onClick={() => removeFromDraft(chatId, i)}>
                  <X aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
