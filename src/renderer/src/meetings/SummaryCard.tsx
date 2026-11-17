/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReactElement } from 'react'
import { Clock3, Sparkles } from 'lucide-react'
import type { MeetingDetail } from '@shared/meetings'
import { call } from '../api'
import { useT } from '../i18n/useT'
import { Button, SkeletonText } from '../ui'

// The notes on a meeting (MV-13): the summary, takeaways, decisions, action
// items and participants. While they are being written it shows a skeleton;
// with no engine ready it says they will follow (MV-11, ST-20); before any
// notes exist it offers Summarize.

export function SummaryCard({ meeting, onSummarize, busy }: { meeting: MeetingDetail; onSummarize(): void; busy: boolean }): ReactElement | null {
  const t = useT()
  const s = meeting.summary
  if (meeting.status === 'live' || meeting.status === 'finishing') return null
  if (meeting.status === 'summarizing') {
    return (
      <section className="mt-notes mt-notes--loading" aria-busy="true" aria-label={t('meetings.detail.summary')}>
        <p className="mt-notes__status">
          <Sparkles aria-hidden="true" />
          {t('meetings.detail.writing')}
        </p>
        <SkeletonText lines={4} />
      </section>
    )
  }
  if (meeting.status === 'summary-pending') {
    return (
      <section className="mt-notes mt-notes--note" aria-label={t('meetings.detail.summary')}>
        <p className="mt-notes__status">
          <Clock3 aria-hidden="true" />
          {t('meetings.detail.pending')}
        </p>
        <div className="mt-notes__actions">
          <Button size="sm" variant="secondary" onClick={() => void call('pages', 'open', 'atelier://settings/model')}>
            {t('meetings.detail.pendingAction')}
          </Button>
          <Button size="sm" variant="ghost" loading={busy} onClick={onSummarize}>
            {t('meetings.detail.tryNow')}
          </Button>
        </div>
      </section>
    )
  }
  if (!s) {
    if (meeting.status === 'failed' || meeting.segments.length === 0) return null
    return (
      <section className="mt-notes mt-notes--note" aria-label={t('meetings.detail.summary')}>
        <p className="mt-notes__status">{t('meetings.detail.noNotes')}</p>
        <div className="mt-notes__actions">
          <Button size="sm" variant="primary" icon={<Sparkles />} loading={busy} onClick={onSummarize}>
            {t('meetings.row.summarize')}
          </Button>
        </div>
      </section>
    )
  }
  return (
    <section className="mt-notes" aria-label={t('meetings.detail.summary')}>
      {s.summary && <p className="mt-notes__summary">{s.summary}</p>}
      {s.takeaways.length > 0 && (
        <>
          <h3 className="mt-notes__heading">{t('meetings.detail.takeaways')}</h3>
          <ul className="mt-notes__list">
            {s.takeaways.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}
      {s.decisions.length > 0 && (
        <>
          <h3 className="mt-notes__heading">{t('meetings.detail.decisions')}</h3>
          <ul className="mt-notes__list">
            {s.decisions.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}
      {s.actionItems.length > 0 && (
        <>
          <h3 className="mt-notes__heading">{t('meetings.detail.actionItems')}</h3>
          <ul className="mt-notes__list mt-notes__list--tasks">
            {s.actionItems.map((a) => (
              <li key={a.text}>
                {a.text}
                {a.owner && <span className="mt-notes__owner">{a.owner}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {s.participants.length > 0 && (
        <>
          <h3 className="mt-notes__heading">{t('meetings.detail.participants')}</h3>
          <ul className="mt-notes__people">
            {s.participants.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-notes__actions">
        <Button size="sm" variant="ghost" icon={<Sparkles />} loading={busy} onClick={onSummarize}>
          {t('meetings.row.summarizeAgain')}
        </Button>
      </div>
    </section>
  )
}
