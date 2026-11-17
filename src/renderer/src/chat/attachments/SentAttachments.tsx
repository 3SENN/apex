/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { AudioLines, Image as ImageIcon } from 'lucide-react'
import type { AttachmentRef } from '@shared/attachments'
import { call } from '../../api'
import { useT } from '../../i18n/useT'
import './attachments.css'

// What a sent message carried, under its bubble: a screenshot's small
// thumbnail and a meeting's title, which opens that meeting. Only these two
// kinds are drawn here; the other kinds have their own cards.

export function SentAttachments({ items }: { items: readonly AttachmentRef[] }): ReactElement | null {
  const t = useT()
  const shown = items.filter((a) => a.kind === 'image' || a.kind === 'meeting')
  if (shown.length === 0) return null
  return (
    <ul className="chat-sent-attach" aria-label={t('meetings.attach.sent')}>
      {shown.map((a) =>
        a.kind === 'meeting' && a.sourceId ? (
          <li key={a.id}>
            <button type="button" className="chat-attach__chip chat-attach__chip--link" onClick={() => void call('pages', 'open', `atelier://meetings/${a.sourceId}`)}>
              <span className="chat-attach__icon" aria-hidden="true"><AudioLines /></span>
              <span className="chat-attach__name" title={a.name}>{a.name || t('meetings.untitled')}</span>
            </button>
          </li>
        ) : (
          <li key={a.id} className="chat-attach__chip">
            <span className="chat-attach__icon chat-attach__icon--thumb" aria-hidden="true">{a.thumbnail ? <img src={a.thumbnail} alt="" /> : <ImageIcon />}</span>
            <span className="chat-attach__name" title={a.name}>{a.name || t('meetings.attach.screenshot')}</span>
          </li>
        ),
      )}
    </ul>
  )
}
