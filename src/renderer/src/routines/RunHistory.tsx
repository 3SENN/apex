/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Routine runs (SK-09): the Past runs view and a routine's run
// history. Each run links to its chat, with its status and how it started;
// Mark all read and Load more work on the run records in routines.sqlite.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { CalendarClock } from 'lucide-react'
import type { RoutineRun } from '@shared/routines'
import { chatUrl } from '@shared/url'
import { call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { Button, ErrorState, RelativeTime, SkeletonRows, StatusDot, cx, useToast } from '../ui'
import { useEvent } from '../settings/data'
import { DestinationEmpty } from '../settings/destinations/common'
import { RUN_RECORD_LABEL, RUN_TRIGGER_LABEL, runRecordDot } from '../settings/logic/routines'

const PAGE = 50

export interface RunsState {
  runs: RoutineRun[] | null
  total: number
  error: string | null
  loading: boolean
  reload(): Promise<void>
  more(): Promise<void>
}

/** Runs of one routine (or every routine), newest first, kept fresh by 'routine-runs' events. */
export function useRuns(routineId: string | null): RunsState {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const count = useRef(PAGE)
  const fetchRuns = useCallback(
    async (limit: number): Promise<void> => {
      setLoading(true)
      try {
        const page = await call('routines', 'runs', { ...(routineId ? { routineId } : {}), offset: 0, limit })
        setRuns(page.runs)
        setTotal(page.total)
        setError(null)
      } catch (err) {
        setError(errorText(err))
      } finally {
        setLoading(false)
      }
    },
    [routineId],
  )
  useEffect(() => {
    count.current = PAGE
    void fetchRuns(PAGE)
  }, [fetchRuns])
  useEvent('routine-runs', (e) => {
    if (!routineId || e.routineId === null || e.routineId === routineId) void fetchRuns(count.current)
  })
  return {
    runs,
    total,
    error,
    loading,
    reload: () => fetchRuns(count.current),
    more: () => {
      count.current += PAGE
      return fetchRuns(count.current)
    },
  }
}

export interface RunHistoryProps {
  state: RunsState
  /** Routine names by id; shown when listing every routine. */
  names?: ReadonlyMap<string, string>
  routineId: string | null
  locale?: string
}

export function RunHistory({ state, names, routineId }: RunHistoryProps): ReactElement {
  const t = useT()
  const toast = useToast()
  const unread = (state.runs ?? []).some((r) => !r.read)
  const markAll = (): void => {
    call('routines', 'markRunsRead', ...(routineId ? [routineId] : [])).catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
  }
  if (state.runs === null && state.loading) return <SkeletonRows rows={4} label={t('skills.runs.loading')} />
  if (state.runs === null && state.error) return <ErrorState message={state.error} onRetry={state.reload} />
  const runs = state.runs ?? []
  return (
    <div className="rt-runs">
      <div className="rt-runs__bar">
        <span className="sp-toolbar__count">{t('skills.runs.count', { shown: runs.length, total: state.total })}</span>
        <Button size="sm" variant="ghost" disabled={!unread} onClick={markAll}>
          {t('skills.runs.markAllRead')}
        </Button>
      </div>
      {runs.length === 0 ? (
        <DestinationEmpty icon={<CalendarClock />} title={t('skills.runs.empty')} description={t('skills.runs.emptyHint')} />
      ) : (
        <ul className="rt-runs__list" aria-label={t('skills.runs.list')}>
          {runs.map((run) => {
            const dot = runRecordDot(run)
            const name = names ? (names.get(run.routineId) ?? t('skills.runs.deletedRoutine')) : null
            const body = (
              <>
                <StatusDot status={dot} label={RUN_RECORD_LABEL[run.status]} />
                <span className="rt-run__text">
                  <span className={cx('rt-run__title', !run.read && 'rt-run__title--unread')}>
                    {name ?? RUN_RECORD_LABEL[run.status]}
                    {!run.read && <span className="rt-run__new">{t('skills.runs.unread')}</span>}
                  </span>
                  <span className="rt-run__sub">
                    {name ? `${RUN_RECORD_LABEL[run.status]} · ` : ''}
                    {RUN_TRIGGER_LABEL[run.trigger]}
                    {!run.chatId && ` · ${t('skills.runs.noChat')}`}
                  </span>
                </span>
                <span className="rt-run__time">
                  <RelativeTime value={run.startedAt} />
                </span>
              </>
            )
            return (
              <li key={run.id} className="rt-run">
                {run.chatId ? (
                  <button type="button" className="rt-run__main" aria-label={`${name ?? RUN_RECORD_LABEL[run.status]}: ${t('skills.runs.open')}`} onClick={() => void call('pages', 'open', chatUrl(run.chatId!))}>
                    {body}
                  </button>
                ) : (
                  <div className="rt-run__main">{body}</div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {runs.length < state.total && (
        <div className="sp-guide-pill">
          <Button variant="secondary" loading={state.loading} onClick={() => void state.more()}>
            {t('skills.runs.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}
