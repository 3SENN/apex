/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// atelier://routines (SK-05): routines and past runs. Filters by status,
// companion and schedule type, search, and sort by name or next run. Rows
// run now, pause or resume, edit, delete and open the last result; a
// routine whose companion was deleted asks you to pick one. Finished
// one-off tasks sit under Past, and suggested routines follow the list.
// atelier://routines/<id> is the detail page; /new and /<id>/edit open the
// editor sheet over the page.
import { useMemo, useState, type MouseEvent, type ReactElement } from 'react'
import { CalendarClock, MoreHorizontal, Play, Plus } from 'lucide-react'
import { SHARED_OWNER } from '@shared/chats'
import { ROUTINE_SCHEDULE_KINDS, filterRoutines, type Routine, type RoutineDraft, type RoutineFilter, type RoutineScheduleKind } from '@shared/routines'
import { chatUrl, internalQuery, parseInternalUrl, routineUrl } from '@shared/url'
import { atelier, call, errorText } from '../api'
import { useRunningRoutines } from '../components/routineRunning'
import './routinesRunning.css'
import { useT } from '../i18n/useT'
import { Badge, Button, ErrorState, IconButton, RelativeTime, SkeletonRows, StatusDot, Switch, cx, showContextMenu, showMenu, useConfirm, useNow, useToast } from '../ui'
import { useCompanions, useEvent, useLocalPreference, useResource } from '../settings/data'
import { DestinationEmpty, DestinationFrame } from '../settings/destinations/common'
import { DestinationToolbar, ListFrame, PageHeader } from '../settings/kit'
import { describeTiming, nextRunLabel, splitPast } from '../settings/logic/routines'
import { RoutineDetail } from '../routines/RoutineDetail'
import { RoutineEditorSheet } from '../routines/RoutineEditorSheet'
import { RoutineSuggestions } from '../routines/RoutineSuggestions'
import { RunHistory, useRuns } from '../routines/RunHistory'
import '../routines/routines.css'

type View = 'routines' | 'runs'
type Status = 'all' | 'active' | 'paused'
type Sort = 'next-run' | 'name'

export interface RoutinesPageProps {
  tabId: string
  /** atelier://routines/<id> is the detail page; 'new' opens the editor. */
  itemId?: string | null
  /** The whole address, for /<id>/edit and ?view=runs. */
  url?: string
}

export function RoutinesPage({ tabId, itemId = null, url = '' }: RoutinesPageProps): ReactElement {
  const route = parseInternalUrl(url)
  const editing = route?.section === 'edit'
  if (itemId && itemId !== 'new') {
    return (
      <>
        <RoutineDetail key={itemId} tabId={tabId} routineId={itemId} />
        {editing && <RoutineEditorSheet routineId={itemId} onClose={() => void atelier.nav.go(tabId, routineUrl(itemId))} />}
      </>
    )
  }
  return <RoutinesList tabId={tabId} creating={itemId === 'new'} startView={internalQuery(url, 'view') === 'runs' ? 'runs' : null} />
}

function RoutinesList({ tabId, creating, startView }: { tabId: string; creating: boolean; startView: View | null }): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const now = useNow()
  const locale = typeof navigator === 'undefined' ? undefined : navigator.language
  const routines = useResource(() => call('routines', 'list'))
  useEvent('routines', (e) => routines.set(e.items))
  const running = useRunningRoutines()
  const companions = useCompanions()
  const runs = useRuns(null)
  const [storedView, setView] = useLocalPreference<View>('atelier.routines.view', 'routines', ['routines', 'runs'])
  const view = startView ?? storedView
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<Status>('all')
  const [companionId, setCompanionId] = useState('')
  const [kind, setKind] = useState<RoutineScheduleKind | ''>('')
  const [sort, setSort] = useLocalPreference<Sort>('atelier.routines.sortD', 'next-run', ['next-run', 'name'])
  const [sheet, setSheet] = useState<{ routineId?: string; draft?: RoutineDraft } | null>(null)
  const names = new Map((companions.items ?? []).map((c) => [c.id, c.name]))
  const all = routines.data ?? []
  const routineNames = useMemo(() => new Map(all.map((r) => [r.id, r.name])), [all])
  const unread = (runs.runs ?? []).filter((r) => !r.read).length

  const { current, past } = useMemo(() => {
    const filter: RoutineFilter = { ...(query ? { query } : {}), ...(companionId ? { companionId } : {}), ...(kind ? { kind } : {}), sort }
    const split = splitPast(all)
    return {
      current: filterRoutines(split.current, { ...filter, ...(status !== 'all' ? { status } : {}) }),
      past: status === 'all' ? filterRoutines(split.past, filter) : [],
    }
  }, [all, query, companionId, kind, sort, status])
  const filtered = query !== '' || companionId !== '' || kind !== '' || status !== 'all'

  const fail = (err: unknown): void => void toast.show({ tone: 'error', message: errorText(err) })
  const pickView = (next: View): void => {
    setView(next)
    if (startView) void atelier.nav.go(tabId, 'atelier://routines')
  }
  const newRoutine = (): void => setSheet({})
  const edit = (r: Routine): void => setSheet({ routineId: r.id })
  const details = (r: Routine): void => void atelier.nav.go(tabId, routineUrl(r.id))
  const runNow = (r: Routine): void => {
    call('routines', 'runNow', r.id).then(() => toast.show({ message: t('skills.routines.running', { name: r.name }), action: { label: t('skills.routines.viewRuns'), onAction: () => pickView('runs') } }), fail)
  }
  const setEnabled = (r: Routine, enabled: boolean): void => {
    call('routines', 'setEnabled', r.id, enabled).catch(fail)
  }
  const remove = async (r: Routine): Promise<void> => {
    const ok = await confirm({ title: t('skills.routines.deleteTitle', { name: r.name }), message: r.schedule.kind === 'once' ? t('skills.routines.deleteTaskBody') : t('skills.routines.deleteBody'), destructive: true })
    if (!ok) return
    call('routines', 'remove', r.id).then(() => toast.show({ message: t('skills.routines.deleted', { name: r.name }) }), fail)
  }
  const menuItems = (r: Routine) => [
    ...(r.needsCompanion ? [{ id: 'edit', label: t('skills.routines.pickCompanion') }] : [{ id: 'run', label: t('skills.routines.runNow'), enabled: !running.has(r.id) }]),
    ...(!r.needsCompanion ? [{ id: 'toggle', label: r.enabled ? t('skills.routines.pause') : t('skills.routines.resume') }, { id: 'edit', label: t('skills.routines.edit') }] : []),
    { id: 'details', label: t('skills.routines.details') },
    { id: 'sep', label: '', type: 'separator' as const },
    { id: 'delete', label: t('skills.routines.delete'), danger: true },
  ]
  const act = (r: Routine, id: string | null): void => {
    if (id === 'run') runNow(r)
    else if (id === 'toggle') setEnabled(r, !r.enabled)
    else if (id === 'edit') edit(r)
    else if (id === 'details') details(r)
    else if (id === 'delete') void remove(r)
  }
  const filterMenu = async (anchor: HTMLElement): Promise<void> => {
    const radio = (id: string, label: string, checked: boolean) => ({ id, label, type: 'radio' as const, checked })
    const choice = await showMenu(
      [
        { id: 'status', label: t('skills.routines.status'), submenu: (['all', 'active', 'paused'] as const).map((s) => radio(`status:${s}`, t(`skills.routines.status.${s}`), status === s)) },
        { id: 'companion', label: t('skills.routines.companion'), submenu: [radio('companion:', t('skills.routines.companion.all'), companionId === ''), radio(`companion:${SHARED_OWNER}`, t('skills.routines.shared'), companionId === SHARED_OWNER), ...(companions.items ?? []).map((c) => radio(`companion:${c.id}`, c.name, companionId === c.id))] },
        { id: 'kind', label: t('skills.routines.kind'), submenu: [radio('kind:', t('skills.routines.kind.all'), kind === ''), ...ROUTINE_SCHEDULE_KINDS.map((k) => radio(`kind:${k}`, t(`skills.routines.kind.${k}`), kind === k))] },
        { id: 'sort', label: t('skills.routines.sort'), submenu: [radio('sort:next-run', t('skills.routines.sort.next'), sort === 'next-run'), radio('sort:name', t('skills.routines.sort.name'), sort === 'name')] },
      ],
      anchor,
    )
    if (!choice) return
    const [key, value = ''] = choice.split(':')
    if (key === 'status') setStatus(value as Status)
    else if (key === 'companion') setCompanionId(value)
    else if (key === 'kind') setKind(value as RoutineScheduleKind | '')
    else if (key === 'sort') setSort(value as Sort)
  }
  const clear = (): void => {
    setQuery('')
    setStatus('all')
    setCompanionId('')
    setKind('')
  }
  const closeSheet = (): void => {
    setSheet(null)
    if (creating) void atelier.nav.go(tabId, 'atelier://routines')
  }
  const row = (r: Routine): ReactElement => (
    <RoutineRow
      key={r.id}
      routine={r}
      ownerLabel={r.owner === SHARED_OWNER ? null : (names.get(r.owner) ?? null)}
      when={describeTiming(r.schedule, r.timeZone, locale)}
      next={nextRunLabel(r, now, locale)}
      running={running.has(r.id)}
      onEnabled={(v) => setEnabled(r, v)}
      onRun={() => runNow(r)}
      onOpen={() => details(r)}
      onFix={() => edit(r)}
      onMenu={(anchor) => void showMenu(menuItems(r), anchor).then((id) => act(r, id))}
      onContextMenu={(e) => void showContextMenu(e, menuItems(r)).then((id) => act(r, id))}
    />
  )

  return (
    <DestinationFrame label={t('skills.routines.title')}>
      <PageHeader
        title={t('skills.routines.title')}
        description={t('skills.routines.description')}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={newRoutine}>
            {t('skills.routines.new')}
          </Button>
        }
      />
      <DestinationToolbar
        segments={{
          label: t('skills.routines.views'),
          value: view,
          options: [
            { value: 'routines', label: t('skills.routines.viewRoutines') },
            { value: 'runs', label: <>{t('skills.routines.viewRuns')}{unread > 0 && <Badge tone="accent" count={unread} className="rt-unread" />}</> },
          ],
          onChange: pickView,
        }}
        {...(view === 'routines'
          ? {
              search: { value: query, onChange: setQuery, placeholder: t('skills.routines.search') },
              filter: { label: t('skills.routines.filters'), active: status !== 'all' || companionId !== '' || kind !== '' || sort !== 'next-run', onOpen: (a: HTMLElement) => void filterMenu(a) },
            }
          : {})}
      />

      {view === 'routines' && (
        <>
          {routines.loading && !routines.data && <SkeletonRows rows={4} label={t('skills.routines.loading')} />}
          {routines.error && !routines.data && <ErrorState message={routines.error} onRetry={routines.reload} />}
          {routines.data && all.length === 0 && (
            <DestinationEmpty icon={<CalendarClock />} title={t('skills.routines.empty')} description={t('skills.routines.emptyHint')} primary={<Button variant="primary" icon={<Plus />} onClick={newRoutine}>{t('skills.routines.new')}</Button>} />
          )}
          {routines.data && all.length > 0 && current.length === 0 && past.length === 0 && (
            <DestinationEmpty icon={<CalendarClock />} title={t('skills.routines.noMatch')} primary={filtered ? <Button variant="secondary" onClick={clear}>{t('skills.routines.clear')}</Button> : undefined} />
          )}
          {current.length > 0 && <ListFrame label={t('skills.routines.list')}>{current.map(row)}</ListFrame>}
          {past.length > 0 && (
            <section className="sp-group" aria-labelledby="rt-past">
              <h2 id="rt-past" className="sp-group__label">
                {t('skills.routines.past')} <span className="sp-group__count">{past.length}</span>
              </h2>
              <p className="sp-field__hint">{t('skills.routines.pastHint')}</p>
              <ListFrame>{past.map(row)}</ListFrame>
            </section>
          )}
          {routines.data && <RoutineSuggestions refreshKey={all.length} onPick={(s) => setSheet({ draft: s.draft })} />}
        </>
      )}
      {view === 'runs' && <RunHistory state={runs} names={routineNames} routineId={null} />}

      {(sheet || creating) && <RoutineEditorSheet {...(sheet?.routineId ? { routineId: sheet.routineId } : {})} {...(sheet?.draft ? { draft: sheet.draft } : {})} onClose={closeSheet} />}
    </DestinationFrame>
  )
}

interface RoutineRowProps {
  routine: Routine
  ownerLabel: string | null
  when: string
  next: string
  running: boolean
  onEnabled(enabled: boolean): void
  onRun(): void
  onOpen(): void
  onFix(): void
  onMenu(anchor: Element): void
  onContextMenu(e: MouseEvent<HTMLElement>): void
}

function RoutineRow({ routine: r, ownerLabel, when, next, running, onEnabled, onRun, onOpen, onFix, onMenu, onContextMenu }: RoutineRowProps): ReactElement {
  const t = useT()
  const past = r.schedule.kind === 'once' && r.lastRunAt !== null && r.nextRunAt === null
  return (
    <div className={cx('sp-item', (!r.enabled || past || r.needsCompanion) && 'sp-item--muted')} onContextMenu={onContextMenu}>
      {!past && !r.needsCompanion && <Switch aria-label={r.enabled ? t('skills.routines.pauseLabel', { name: r.name }) : t('skills.routines.resumeLabel', { name: r.name })} checked={r.enabled} onChange={onEnabled} size="sm" />}
      <button type="button" className="sp-item__main" onClick={onOpen}>
        <span className="sp-item__title">
          <span className="sp-item__title-text">{r.name}</span>
          {ownerLabel && <Badge>{ownerLabel}</Badge>}
          {r.notice && <Badge tone="warning" title={r.notice}>{t('skills.routines.notice')}</Badge>}
          {running && (
            <span className="routine-running" role="status">
              <StatusDot status="working" size={6} label="" />
              {t('atWork.routines.running')}
            </span>
          )}
        </span>
        <span className="sp-item__sub">{r.needsCompanion ? t('skills.routines.needsCompanion') : past ? when : `${when} · ${next}`}</span>
      </button>
      {r.lastStatus && (
        <span className="sp-item__meta">
          {r.lastChatId ? (
            <button type="button" className="sp-link" onClick={() => void call('pages', 'open', chatUrl(r.lastChatId!))} title={t('skills.routines.openLast')}>
              <Badge tone={r.lastStatus === 'ok' ? 'success' : 'danger'}>{r.lastStatus === 'ok' ? t('skills.routines.lastOk') : t('skills.routines.lastError')}</Badge>
            </button>
          ) : (
            <Badge tone={r.lastStatus === 'ok' ? 'success' : 'danger'}>{r.lastStatus === 'ok' ? t('skills.routines.lastOk') : t('skills.routines.lastError')}</Badge>
          )}
          {r.lastRunAt && <RelativeTime value={r.lastRunAt} style="short" />}
        </span>
      )}
      <div className="sp-item__actions">
        {r.needsCompanion ? (
          <Button size="sm" variant="secondary" onClick={onFix}>
            {t('skills.routines.pickCompanion')}
          </Button>
        ) : (
          <IconButton size="sm" label={running ? t('skills.routines.alreadyRunning', { name: r.name }) : t('skills.routines.runNowLabel', { name: r.name })} icon={<Play />} onClick={onRun} disabled={running} />
        )}
        <IconButton size="sm" label={t('skills.routines.more', { name: r.name })} icon={<MoreHorizontal />} aria-haspopup="menu" onClick={(e) => onMenu(e.currentTarget)} />
      </div>
    </div>
  )
}
