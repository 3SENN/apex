/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://routines/<id> (SK-09): one routine. Its state, when it was made
// and changed, the next run, what it does, Run now, Pause or Resume, Edit
// and Delete, and its run history with links to each run's chat.
import { useEffect, useState, type ReactElement } from 'react'
import { ArrowLeft, CalendarClock, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { SHARED_OWNER } from '@shared/chats'
import { isPastRoutine, type Routine } from '@shared/routines'
import { routineUrl } from '@shared/url'
import { apex, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Badge, Button, EmptyState, formatAbsolute, useConfirm, useNow, useToast } from '../ui'
import { useCompanions, useEvent, useResource } from '../settings/data'
import { DestinationFrame } from '../settings/destinations/common'
import { Card, PageSkeleton } from '../settings/kit'
import { describeTiming, formatRunTime, nextRunLabel } from '../settings/logic/routines'
import { RunHistory, useRuns } from './RunHistory'
import '../skills/skills.css'
import './routines.css'

export interface RoutineDetailProps {
  tabId: string
  routineId: string
}

type Load = { kind: 'loading' } | { kind: 'missing' } | { kind: 'ready'; routine: Routine }

export function RoutineDetail({ tabId, routineId }: RoutineDetailProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const now = useNow()
  const companions = useCompanions()
  const skills = useResource(() => call('skills', 'list'))
  const runs = useRuns(routineId)
  const chats = useResource(() => call('chats', 'list', { limit: 200, routine: 'exclude' }))
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const locale = typeof navigator === 'undefined' ? undefined : navigator.language

  useEffect(() => {
    let live = true
    call('routines', 'get', routineId).then(
      (routine) => live && setLoad({ kind: 'ready', routine }),
      () => live && setLoad({ kind: 'missing' }),
    )
    return () => void (live = false)
  }, [routineId])
  useEvent('routines', (e) => {
    const next = e.items.find((r) => r.id === routineId)
    setLoad(next ? { kind: 'ready', routine: next } : { kind: 'missing' })
  })
  const back = (): void => void apex.nav.go(tabId, 'apex://routines')
  const fail = (err: unknown): void => void toast.show({ tone: 'error', message: errorText(err) })

  if (load.kind === 'loading') {
    return (
      <DestinationFrame label={t('skills.routines.title')}>
        <PageSkeleton label={t('skills.detail.loading')} rows={5} />
      </DestinationFrame>
    )
  }
  if (load.kind === 'missing') {
    return (
      <DestinationFrame label={t('skills.routines.title')}>
        <EmptyState icon={<CalendarClock />} title={t('skills.detail.missing')} description={t('skills.detail.missingHint')} action={<Button variant="secondary" icon={<ArrowLeft />} onClick={back}>{t('skills.detail.back')}</Button>} />
        <RunHistory state={runs} routineId={routineId} />
      </DestinationFrame>
    )
  }

  const r = load.routine
  const past = isPastRoutine(r)
  const state = r.needsCompanion ? 'needsCompanion' : past ? 'past' : r.enabled ? 'active' : 'paused'
  const companion = r.owner === SHARED_OWNER ? t('skills.routines.shared') : (companions.items?.find((c) => c.id === r.owner)?.name ?? r.owner)
  const skill = r.skillId ? skills.data?.find((s) => s.id === r.skillId) : undefined
  const edit = (): void => void apex.nav.go(tabId, routineUrl(r.id, true))
  const runNow = (): void => {
    call('routines', 'runNow', r.id).then(() => toast.show({ message: t('skills.routines.running', { name: r.name }) }), fail)
  }
  const toggle = (): void => {
    call('routines', 'setEnabled', r.id, !r.enabled).catch(fail)
  }
  const remove = async (): Promise<void> => {
    const ok = await confirm({ title: t('skills.routines.deleteTitle', { name: r.name }), message: r.schedule.kind === 'once' ? t('skills.routines.deleteTaskBody') : t('skills.routines.deleteBody'), destructive: true })
    if (!ok) return
    try {
      await call('routines', 'remove', r.id)
      toast.show({ message: t('skills.routines.deleted', { name: r.name }) })
      back()
    } catch (err) {
      fail(err)
    }
  }
  const appendTo = r.destination.kind === 'append' ? r.destination.chatId : null
  const destination = appendTo ? t('skills.detail.appendTo', { title: chats.data?.find((c) => c.id === appendTo)?.title ?? '…' }) : t('skills.detail.newChat')

  return (
    <DestinationFrame label={t('skills.routines.title')}>
      <div className="rt-detail">
        <button type="button" className="sp-back" onClick={back}>
          <ArrowLeft aria-hidden /> {t('skills.detail.back')}
        </button>
        <header className="rt-detail__head">
          <div>
            <h1 className="rt-detail__title">{r.name}</h1>
            <div className="rt-detail__badges">
              <Badge tone={state === 'active' ? 'success' : state === 'needsCompanion' ? 'warning' : 'neutral'}>{t(`skills.detail.state.${state}`)}</Badge>
              <span className="sk-muted">{nextRunLabel(r, now, locale)}</span>
            </div>
          </div>
          <div className="rt-detail__actions">
            {r.needsCompanion ? (
              <Button variant="primary" onClick={edit}>
                {t('skills.routines.pickCompanion')}
              </Button>
            ) : (
              <>
                <Button variant="secondary" icon={<Play />} onClick={runNow}>
                  {t('skills.routines.runNow')}
                </Button>
                {!past && (
                  <Button variant="secondary" icon={r.enabled ? <Pause /> : <Play />} onClick={toggle}>
                    {r.enabled ? t('skills.routines.pause') : t('skills.routines.resume')}
                  </Button>
                )}
              </>
            )}
            <Button variant="secondary" icon={<Pencil />} onClick={edit}>
              {t('skills.routines.edit')}
            </Button>
            <Button variant="ghost" className="sk-danger" icon={<Trash2 />} onClick={() => void remove()}>
              {t('skills.routines.delete')}
            </Button>
          </div>
        </header>
        {r.needsCompanion && <p className="rt-warning" role="status">{t('skills.routines.needsCompanion')}</p>}
        {r.notice && <p className="rt-warning" role="status">{r.notice}</p>}
        <Card>
          <dl className="rt-facts" aria-label={t('skills.detail.facts')}>
            <dt>{t('skills.detail.schedule')}</dt>
            <dd>{describeTiming(r.schedule, r.timeZone, locale)}</dd>
            <dt>{t('skills.detail.next')}</dt>
            <dd>{r.enabled && r.nextRunAt !== null ? formatRunTime(r.nextRunAt, r.timeZone, locale) : t('skills.detail.none')}</dd>
            <dt>{t('skills.detail.companion')}</dt>
            <dd>{companion}</dd>
            <dt>{t('skills.detail.destination')}</dt>
            <dd>{destination}</dd>
            <dt>{t('skills.detail.created')}</dt>
            <dd>{formatAbsolute(r.createdAt)}</dd>
            <dt>{t('skills.detail.updated')}</dt>
            <dd>{formatAbsolute(r.updatedAt)}</dd>
          </dl>
        </Card>
        <section className="rt-detail__section" aria-labelledby="rt-instructions">
          <h2 id="rt-instructions" className="sk-section-title">
            {t('skills.detail.instructions')}
          </h2>
          <Card>
            {r.skillId && <p className="rt-detail__skill sp-mono">{t('skills.detail.skill', { name: skill?.name ?? '…' })}</p>}
            {r.prompt && <p className="rt-detail__prompt">{r.prompt}</p>}
          </Card>
        </section>
        <section className="rt-detail__section" aria-labelledby="rt-history">
          <h2 id="rt-history" className="sk-section-title">
            {t('skills.detail.history')}
          </h2>
          <RunHistory state={runs} routineId={r.id} />
        </section>
      </div>
    </DestinationFrame>
  )
}
