/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { ArrowDownAZ, CalendarClock, ClockArrowDown, MoreHorizontal, Plus } from 'lucide-react'
import type { Companion } from '@shared/companion'
import { SHARED_OWNER } from '@shared/services'
import type { Routine } from '@shared/routines'
import { call, errorText } from '../api'
import { Badge, ErrorState, IconButton, RelativeTime, Switch, confirm, menuSeparator, showMenu, toast } from '../ui'
import { t } from '../i18n/useT'
import { routineMatches, sortRoutines, type RoutineSort } from './logic/listTemplate'
import { describeSchedule } from './logic/schedule'
import { GroupToggle, ListEmpty, ListRoundButton, ListSearch, ListSkeleton, ListTabHeader, useSkeletonPhase } from './ListTab'
import { Nested } from './Nested'
import { RoutineEditorSheet } from '../routines/RoutineEditorSheet'
import { useLoaded } from './useLoaded'

interface RoutinesTabProps {
  companion: Companion
  focusId: string | null
  /** Opens atelier://routines/<id> in a tab and closes the card (after asking). */
  onOpenPage(url: string): void
}

// Pausing goes through setEnabled; a new owner saves the whole routine (skill, destination, zone and
// revision included), so nothing the card doesn't show is lost.
function save(routine: Routine, patch: Partial<Pick<Routine, 'enabled' | 'owner'>>): void {
  const fail = (err: unknown): void => void toast.show({ message: errorText(err), tone: 'error' })
  if (patch.owner === undefined) {
    if (patch.enabled !== undefined) call('routines', 'setEnabled', routine.id, patch.enabled).catch(fail)
    return
  }
  call('routines', 'save', {
    id: routine.id,
    revision: routine.revision,
    name: routine.name,
    prompt: routine.prompt,
    ...(routine.skillId ? { skillId: routine.skillId } : {}),
    schedule: routine.schedule,
    companionId: patch.owner,
    destination: routine.destination,
    timeZone: routine.timeZone,
    enabled: patch.enabled ?? routine.enabled,
  }).catch(fail)
}

export function RoutinesTab({ companion, focusId, onOpenPage }: RoutinesTabProps) {
  const routines = useLoaded(() => call('routines', 'list'), [], (e) => (e.type === 'routines' ? { data: e.items } : false))
  const [editing, setEditing] = useState<Routine | 'new' | null>(null)
  const [sharedOpen, setSharedOpen] = useState(true)
  // DS-113: the same search row as the other list tabs, with a sort button.
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<RoutineSort>('next')
  const phase = useSkeletonPhase(routines.status === 'loading' && !routines.data)
  const all = sortRoutines((routines.data ?? []).filter((r) => routineMatches(r, query)), sort)
  const own = all.filter((r) => r.owner === companion.id)
  const shared = all.filter((r) => r.owner === SHARED_OWNER)

  const open = async (routine: Routine): Promise<void> => {
    const ok = await confirm({ title: t('coCard.routines.open', { name: routine.name }), message: t('coCard.routines.itsPageOpensIn'), confirmLabel: t('coCard.routines.openRoutine') })
    if (ok) onOpenPage(`atelier://routines/${routine.id}`)
  }
  const rowMenu = async (routine: Routine, anchor: Element): Promise<void> => {
    const choice = await showMenu(
      [
        { id: 'open', label: t('coCard.routines.openRoutinePage') },
        { id: 'run', label: t('coCard.routines.runNow') },
        { id: 'edit', label: t('coCard.routines.edit') },
        routine.owner === SHARED_OWNER ? { id: 'own', label: t('coCard.routines.runAsOnly', { name: companion.name }) } : { id: 'share', label: t('coCard.routines.runAsWhicheverCompanion') },
        menuSeparator(),
        { id: 'delete', label: t('coCard.routines.delete'), danger: true },
      ],
      anchor,
    )
    if (choice === 'open') await open(routine)
    else if (choice === 'run') {
      call('routines', 'runNow', routine.id).then(
        () => toast.show({ message: t('coCard.routines.isRunningYouLl', { name: routine.name }), tone: 'info' }),
        (err: unknown) => toast.show({ message: errorText(err), tone: 'error' }),
      )
    } else if (choice === 'edit') setEditing(routine)
    else if (choice === 'own' || choice === 'share') save(routine, { owner: choice === 'share' ? SHARED_OWNER : companion.id })
    else if (choice === 'delete') {
      const ok = await confirm({ title: t('coCard.routines.delete2', { name: routine.name }), message: t('coCard.routines.itStopsRunningChats'), destructive: true })
      if (ok) call('routines', 'remove', routine.id).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
    }
  }

  const row = (routine: Routine) => (
    <li key={routine.id} className={`co-item${focusId === routine.id ? ' co-item--linked' : ''}`} ref={(el) => {
      if (el && focusId === routine.id) el.scrollIntoView({ block: 'nearest' })
    }}>
      <div className="co-item__main">
        <button type="button" className="co-item__toggle" onClick={() => void open(routine)}>
          <CalendarClock aria-hidden />
          <span className="co-item__text">
            <span className="co-item__title">
              {routine.name}
              {routine.lastStatus === 'error' && <Badge tone="danger">{t('coCard.routines.lastRunFailed')}</Badge>}
            </span>
            <span className="co-item__meta">
              {describeSchedule(routine.schedule)}
              {' · '}
              {routine.enabled ? (routine.nextRunAt ? <>{t('coCard.routines.nextRun')} <RelativeTime value={routine.nextRunAt} /></> : t('coCard.routines.scheduled')) : t('coCard.routines.paused')}
            </span>
          </span>
        </button>
        <Switch size="sm" checked={routine.enabled} onChange={(on) => save(routine, { enabled: on })} aria-label={routine.enabled ? t('coCard.routines.pause', { name: routine.name }) : t('coCard.routines.turnOn', { name: routine.name })} />
        <IconButton label={t('coCard.routines.moreFor', { name: routine.name })} icon={<MoreHorizontal />} size="sm" aria-haspopup="menu" onClick={(e) => void rowMenu(routine, e.currentTarget)} />
      </div>
    </li>
  )

  return (
    <div className="co-tab">
      <ListTabHeader
        title={t('coCard.routines.routines')}
        help={t('coCard.routines.routinesRunOnA')}
        action={{ label: t('coCard.routines.newRoutine'), icon: <Plus aria-hidden />, onClick: () => setEditing('new') }}
      />
      <ListSearch
        value={query}
        onChange={setQuery}
        placeholder={t('coCard.routines.search')}
        trailing={
          <ListRoundButton
            label={sort === 'next' ? t('coCard.routines.sort.byNext') : t('coCard.routines.sort.byName')}
            icon={sort === 'next' ? <ClockArrowDown aria-hidden /> : <ArrowDownAZ aria-hidden />}
            onClick={() => setSort(sort === 'next' ? 'name' : 'next')}
          />
        }
      />
      {phase === 'skeleton' && <ListSkeleton label={t('coCard.list.loading.routines')} />}
      {routines.status === 'error' && <ErrorState compact message={routines.error ?? undefined} onRetry={routines.reload} />}
      {routines.data && phase === 'done' && (
        <>
          {own.length > 0 ? (
            <ul className="co-list">{own.map(row)}</ul>
          ) : (
            <ListEmpty>{query ? t('coCard.routines.empty.match') : t('coCard.routines.empty.own', { companion: companion.name })}</ListEmpty>
          )}
          <GroupToggle label={t('coCard.routines.group.shared')} count={shared.length} open={sharedOpen} onToggle={() => setSharedOpen((v) => !v)} />
          {sharedOpen && (shared.length > 0 ? <ul className="co-list">{shared.map(row)}</ul> : <ListEmpty>{query ? t('coCard.routines.empty.match') : t('coCard.routines.empty.shared')}</ListEmpty>)}
        </>
      )}
      {editing && (
        <Nested>
          {/* The full editor (SK-07), so cron, once, zones and destinations survive an edit from the card. */}
          {editing === 'new' ? (
            <RoutineEditorSheet draft={{ name: '', prompt: '', schedule: { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }, companionId: companion.id }} onClose={() => setEditing(null)} />
          ) : (
            <RoutineEditorSheet routineId={editing.id} onClose={() => setEditing(null)} />
          )}
        </Nested>
      )}
    </div>
  )
}

