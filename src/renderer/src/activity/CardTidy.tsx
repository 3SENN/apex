/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// CO-09: the companion card's Memory tab, Tidy view. A timeline
// with the next nightly pass on top (a dashed node) and this companion's
// past passes below (solid nodes), each opening the chat that did it, and
// the Tidy memory switch.
import { useState, type ReactElement } from 'react'
import { MessageSquareText } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { chatUrl } from '@shared/url'
import { call, errorText } from '../api'
import { tidyEntries, type TidyEntry } from '../companion-card/logic/notes'
import { useLoaded } from '../companion-card/useLoaded'
import { useT } from '../i18n/useT'
import { ErrorState, SkeletonRows, Switch, cx, toast } from '../ui'
import { hourLabel } from './logic'
import './activity.css'

export function CardTidy({ companion }: { companion: Companion }): ReactElement {
  const t = useT()
  const upkeep = useLoaded(
    async () => {
      const [settings, schedule, passes] = await Promise.all([call('memoryUpkeep', 'settings'), call('memoryUpkeep', 'schedule'), call('memoryUpkeep', 'passes', 50)])
      return { settings, schedule, passes }
    },
    [],
    (e) => e.type === 'tidy',
  )
  const [saving, setSaving] = useState(false)

  const setEnabled = (enabled: boolean): void => {
    setSaving(true)
    call('memoryUpkeep', 'update', { enabled }).then(
      () => {
        setSaving(false)
        upkeep.reload()
      },
      (err: unknown) => {
        setSaving(false)
        toast.show({ tone: 'error', message: errorText(err) })
      },
    )
  }

  if (upkeep.status === 'loading' && !upkeep.data) return <SkeletonRows rows={3} label={t('memory.tidy.title')} />
  if (!upkeep.data) return <ErrorState compact message={upkeep.error ?? undefined} onRetry={upkeep.reload} />

  const { settings, schedule, passes } = upkeep.data
  const now = Date.now()
  const entries = tidyEntries(passes, companion.id, { enabled: settings.enabled, afterHour: settings.afterHour, nextAt: schedule.nextAt }, now, {
    tonight: t('memory.card.tonight'),
    today: t('memory.card.today'),
    yesterday: t('memory.card.yesterday'),
    after: (hour) => t('memory.card.after', { hour }),
  })
  const hasPasses = entries.some((e) => e.kind === 'pass')

  return (
    <div className="am-card-tidy">
      <div className="am-card-tidy__switch">
        <Switch size="sm" checked={settings.enabled} disabled={saving} onChange={setEnabled} label={t('memory.tidy.switch')} />
      </div>
      <ol className="co-timeline" aria-label={t('memory.tidy.passes')}>
        {entries.map((entry) => (
          <TidyRow key={entry.key} entry={entry} companion={companion} afterHour={settings.afterHour} />
        ))}
      </ol>
      {!hasPasses && <p className="co-empty-line">{t('memory.card.historyEmpty')}</p>}
    </div>
  )
}

function TidyRow({ entry, companion, afterHour }: { entry: TidyEntry; companion: Companion; afterHour: number }): ReactElement {
  const t = useT()
  const upcoming = entry.kind !== 'pass'
  const pass = entry.pass
  const title =
    entry.kind === 'next'
      ? t('memory.card.nextTitle')
      : entry.kind === 'off'
        ? t('memory.card.offTitle')
        : pass?.status === 'ok'
          ? t('memory.card.passTitleOk', { name: companion.name })
          : pass?.status === 'skipped'
            ? t('memory.card.passTitleSkipped')
            : t('memory.card.passTitleError')
  const text =
    entry.kind === 'next'
      ? t('memory.card.nextBody', { hour: hourLabel(afterHour) })
      : entry.kind === 'off'
        ? t('memory.card.offBody', { name: companion.name })
        : [
            pass?.status === 'ok' ? t('memory.tidy.ok', { count: pass.notesChanged }) : (pass?.reason ?? ''),
            // DC-17: chats the decision model left out; a pass that skipped them all says so in its reason.
            pass?.skippedChats && pass.status !== 'skipped' ? t('memory.jobs.skippedChats', { count: pass.skippedChats }) : '',
          ]
            .filter(Boolean)
            .join(' · ')
  const body = (
    <>
      <span className="co-timeline__title">{title}</span>
      {text && <span className="co-timeline__text">{text}</span>}
    </>
  )
  return (
    <li className="co-timeline__entry">
      <span className="co-timeline__date am-tidy-date">
        {entry.day && <b>{entry.day}</b>}
        {entry.time && <span>{entry.time}</span>}
      </span>
      <span className="co-timeline__rail" aria-hidden="true">
        <i className={cx('co-timeline__node', upcoming ? 'am-node--next' : 'am-node--past', pass?.status === 'error' && 'am-node--error')} />
      </span>
      {pass?.chatId ? (
        <button type="button" className="co-timeline__content" aria-label={`${title}. ${t('memory.card.openChat')}`} onClick={() => void call('pages', 'open', chatUrl(pass.chatId as string))}>
          {body}
          <span className="am-tidy-open">
            <MessageSquareText aria-hidden />
            {t('memory.card.openChat')}
          </span>
        </button>
      ) : (
        <div className="co-timeline__content am-tidy-static">{body}</div>
      )}
    </li>
  )
}
