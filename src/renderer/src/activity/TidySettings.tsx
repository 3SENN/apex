/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tidy memory on Settings › Memory (ST-48): the nightly switch (off by
// default), the hour it may start after, the last and next pass, Tidy now,
// and the recent passes, each linking to the background chat that did it.
import { useState, type ReactElement } from 'react'
import { CircleCheck, CircleSlash, MessageSquareText, TriangleAlert } from 'lucide-react'
import type { TidyPass } from '@shared/activity'
import { chatUrl } from '@shared/url'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { useEvent, useResource } from '../settings/data'
import { ListFrame, Row, SwitchRow } from '../settings/kit'
import { Button, EmptyState, ErrorState, RelativeTime, Select, SkeletonRows, useToast } from '../ui'
import { hourLabel, whenLabel } from './logic'

const HOURS = Array.from({ length: 24 }, (_, h) => h)

const PASS_ICON: Record<TidyPass['status'], ReactElement> = {
  ok: <CircleCheck aria-hidden />,
  skipped: <CircleSlash aria-hidden />,
  error: <TriangleAlert aria-hidden />,
}

export function TidySettings({ companionName }: { companionName(id: string): string }): ReactElement {
  const t = useT()
  const toast = useToast()
  const settings = useResource(() => call('memoryUpkeep', 'settings'))
  const schedule = useResource(() => call('memoryUpkeep', 'schedule'))
  const passes = useResource(() => call('memoryUpkeep', 'passes', 20))
  const [starting, setStarting] = useState(false)

  useEvent('tidy', () => {
    void passes.reload()
    void schedule.reload()
  })

  const update = async (patch: { enabled?: boolean; afterHour?: number }): Promise<void> => {
    if (settings.data) settings.set({ ...settings.data, ...patch })
    try {
      settings.set(await call('memoryUpkeep', 'update', patch))
      void schedule.reload()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
      void settings.reload()
    }
  }
  const runNow = async (): Promise<void> => {
    setStarting(true)
    try {
      await call('memoryUpkeep', 'runNow')
      toast.show({ message: t('memory.tidy.started') })
      void schedule.reload()
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setStarting(false)
    }
  }

  const s = settings.data
  const sch = schedule.data
  const now = Date.now()
  if (!s) {
    return settings.error ? <ErrorState compact message={settings.error} onRetry={settings.reload} /> : <SkeletonRows rows={2} label={t('memory.tidy.title')} />
  }

  const lines = [sch?.lastAt ? t('memory.tidy.last', { when: whenLabel(sch.lastAt, now) }) : t('memory.tidy.never')]
  if (s.enabled && sch?.nextAt) lines.unshift(t('memory.tidy.next', { when: whenLabel(sch.nextAt, now) }))

  return (
    <div className="am-tidy">
      <div className="sp-card">
        <SwitchRow anchor="tidy-memory" checked={s.enabled} onChange={(enabled) => void update({ enabled })} label={t('memory.tidy.switch')} description={t('memory.tidy.switchHint')} />
        <Row title={t('memory.tidy.afterHour')} description={t('memory.tidy.afterHourHint')}>
          <Select<string>
            size="sm"
            aria-label={t('memory.tidy.afterHour')}
            disabled={!s.enabled}
            value={String(s.afterHour)}
            options={HOURS.map((h) => ({ value: String(h), label: hourLabel(h) }))}
            onChange={(v) => void update({ afterHour: Number(v) })}
          />
        </Row>
        <Row title={lines.join(' · ')}>
          <Button size="sm" loading={starting || sch?.running === true} onClick={() => void runNow()}>
            {sch?.running ? t('memory.tidy.running') : t('memory.tidy.runNow')}
          </Button>
        </Row>
      </div>

      <h3 className="am-subtitle">{t('memory.tidy.passes')}</h3>
      <ListFrame label={t('memory.tidy.passes')}>
        {passes.data === null ? (
          passes.error ? (
            <ErrorState compact message={passes.error} onRetry={passes.reload} />
          ) : (
            <SkeletonRows rows={2} label={t('memory.tidy.passes')} />
          )
        ) : passes.data.length === 0 ? (
          <EmptyState compact title={t('memory.tidy.passesEmpty')} />
        ) : (
          passes.data.map((pass) => (
            <div key={pass.id} className="sp-item am-pass" data-status={pass.status}>
              <span className="sp-item__icon" aria-hidden>
                {PASS_ICON[pass.status]}
              </span>
              <div className="sp-item__main">
                <span className="sp-item__title">
                  <span className="sp-item__title-text">{companionName(pass.companionId)}</span>
                </span>
                <span className="sp-item__sub">
                  {pass.status === 'ok' ? t('memory.tidy.ok', { count: pass.notesChanged }) : pass.status === 'skipped' ? t('memory.tidy.skipped') : t('memory.tidy.error')}
                  {pass.reason && ` · ${pass.reason}`}
                  {pass.skippedChats && pass.status !== 'skipped' ? ` · ${t('memory.jobs.skippedChats', { count: pass.skippedChats })}` : ''} · <RelativeTime value={pass.at} />
                </span>
              </div>
              {pass.chatId && (
                <div className="sp-item__actions">
                  <Button size="sm" variant="ghost" icon={<MessageSquareText />} onClick={() => void call('pages', 'open', chatUrl(pass.chatId as string))}>
                    {t('memory.jobs.openChat')}
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </ListFrame>
    </div>
  )
}
