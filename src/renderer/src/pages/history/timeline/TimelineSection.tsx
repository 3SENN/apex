/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Timeline with insights, the
// History page's Timeline view (apex://history?view=timeline). A month
// calendar with day and week scope (?scope=day|week&date=YYYY-MM-DD),
// sessions split on gaps over 20 minutes, top sites and active time,
// thumbnails when they're on, possible to-dos and insights when you opted
// in, and the site insights table. Excluded sites never show. Built from
// this profile's visits log, plus activity memory's notes when it is on.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Clock, Globe, Layers, Lightbulb, RefreshCw, X } from 'lucide-react'
import { localDayBounds, localDayKey, type ActivitySettings } from '@shared/activity'
import { isFlagOn } from '@shared/flags'
import type { Insight, TimelineDay, TimelineSession } from '@shared/timeline'
import { activeLabel, monthGrid, monthOf, parseTimelineQuery, scopeDays, scopeRange, timeLabel, timelineUrl, totals, dateLabel, type TimelineScope } from '../../../activity/logic'
import '../../../activity/activity.css'
import { apex, call, errorText } from '../../../api'
import { useT } from '../../../i18n/useT'
import { Button, EmptyState, ErrorState, IconButton, SegmentedControl, SkeletonRows, cx } from '../../../ui'
import { MonthCalendar } from './MonthCalendar'
import { SiteTable } from './SiteTable'

export interface TimelineSectionProps {
  /** The tab showing the section; with it, scope and date changes update the address. */
  tabId?: string
  /** The tab's address, for ?scope= and ?date=. */
  url?: string
  /** Its own title and description; History's header already names the page. */
  heading?: boolean
}

type DayData = { day: string; sessions: TimelineSession[] }
type Loaded<T> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: T }

function useLoaded<T>(load: () => Promise<T>, deps: readonly unknown[]): [Loaded<T>, () => void] {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    setState({ status: 'loading' })
    load().then(
      (data) => live && setState({ status: 'ready', data }),
      (err: unknown) => live && setState({ status: 'error', error: errorText(err) }),
    )
    return () => {
      live = false
    }
    // The caller lists what the load depends on.
  }, [...deps, attempt])
  return [state, () => setAttempt((n) => n + 1)]
}

export default function TimelineSection({ tabId, url, heading = true }: TimelineSectionProps = {}): ReactElement {
  const t = useT()
  const now = Date.now()
  const today = localDayKey(now)
  const fromUrl = parseTimelineQuery(url?.split('?')[1] ?? '', now)
  const [local, setLocal] = useState(fromUrl)
  // The address leads when there is one; a change goes back into it.
  useEffect(() => setLocal(fromUrl), [fromUrl.scope, fromUrl.day])
  const { scope, day } = local
  const [view, setView] = useState(() => monthOf(day))
  useEffect(() => setView(monthOf(day)), [day])
  const [refreshKey, setRefreshKey] = useState(0)

  const go = (next: { scope: TimelineScope; day: string }): void => {
    setLocal(next)
    if (tabId) void apex.nav.go(tabId, timelineUrl(next.scope, next.day))
  }

  // Activity memory's settings say whether notes, thumbnails and insights apply.
  const [activity, setActivity] = useState<ActivitySettings | null>(null)
  const [flags, setFlags] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    call('activity', 'settings').then((s) => live && setActivity(s), () => undefined)
    apex.settings.get().then((s) => live && setFlags(s.flags ?? {}), () => undefined)
    return () => {
      live = false
    }
  }, [refreshKey])

  const range = useMemo(() => scopeRange(scope, day), [scope, day])
  const monthRange = useMemo(() => {
    const cells = monthGrid(view.year, view.month).flat().filter((c): c is string => c !== null)
    return { from: localDayBounds(cells[0] as string).from, to: localDayBounds(cells[cells.length - 1] as string).to - 1 }
  }, [view.year, view.month])

  const [month] = useLoaded(() => call('timeline', 'days', monthRange), [monthRange.from, monthRange.to, refreshKey])
  const [days, reloadDays] = useLoaded(() => call('timeline', 'days', range), [range.from, range.to, refreshKey])
  const [sessions, reloadSessions] = useLoaded(
    () => Promise.all(scopeDays(scope, day, today).map(async (d): Promise<DayData> => ({ day: d, sessions: await call('timeline', 'sessions', d) }))),
    [scope, day, today, refreshKey],
  )

  const busy = useMemo(() => new Map((month.status === 'ready' ? month.data : []).map((d: TimelineDay) => [d.day, d.visits])), [month])
  const sum = days.status === 'ready' ? totals(days.data) : null
  const screenshots = activity?.enabled === true && isFlagOn(flags, 'activity-screenshots')
  const allSessions = sessions.status === 'ready' ? sessions.data.flatMap((d) => d.sessions) : []
  const topSites = useMemo(() => {
    const by = new Map<string, { origin: string; title: string; activeMs: number; visits: number }>()
    for (const s of allSessions) {
      for (const site of s.sites) {
        const prev = by.get(site.origin)
        by.set(site.origin, { origin: site.origin, title: prev?.title || site.title, activeMs: (prev?.activeMs ?? 0) + site.activeMs, visits: (prev?.visits ?? 0) + site.visits })
      }
    }
    return [...by.values()].sort((a, b) => b.activeMs - a.activeMs).slice(0, 5)
  }, [sessions])
  const thumbs = screenshots ? allSessions.flatMap((s) => s.thumbnails ?? []) : []
  const loading = days.status === 'loading' || sessions.status === 'loading'
  const error = days.status === 'error' ? days.error : sessions.status === 'error' ? sessions.error : null
  const empty = !loading && !error && allSessions.length === 0
  const scopeTitle = scope === 'day' ? dateLabel(localDayBounds(day).from, now) : `${dateLabel(range.from, now)} – ${dateLabel(range.to, now)}`

  return (
    <div className="tl">
      <header className="tl__head">
        {heading && (
          <div className="tl__titles">
            <h2 className="tl__title">{t('memory.timeline.title')}</h2>
            <p className="tl__desc">{t('memory.timeline.description')}</p>
          </div>
        )}
        <div className="tl__controls">
          <SegmentedControl<TimelineScope>
            label={t('memory.timeline.scope')}
            options={[
              { value: 'day', label: t('memory.timeline.day') },
              { value: 'week', label: t('memory.timeline.week') },
            ]}
            value={scope}
            onChange={(next) => go({ scope: next, day })}
          />
          <Button size="sm" variant="ghost" disabled={day === today} onClick={() => go({ scope, day: today })}>
            {t('memory.timeline.today')}
          </Button>
          <IconButton size="sm" label={t('memory.timeline.refresh')} icon={<RefreshCw />} onClick={() => setRefreshKey((k) => k + 1)} />
        </div>
      </header>

      {activity && !activity.enabled && (
        <div className="tl-note" role="note">
          <span>{t('memory.timeline.activityOff')}</span>
          <button type="button" className="tl-link" onClick={() => void call('pages', 'open', 'apex://settings/activity')}>
            {t('memory.timeline.openSettings')}
          </button>
        </div>
      )}

      <div className="tl__layout">
        <aside className="tl__side">
          <MonthCalendar view={view} onView={setView} scope={scope} day={day} today={today} busy={busy} onPick={(d) => go({ scope, day: d })} />
          {sum && (
            <dl className="tl-stats" aria-label={scopeTitle}>
              <div className="tl-stat">
                <dt>
                  <Clock aria-hidden /> {t('memory.timeline.activeTime')}
                </dt>
                <dd>{activeLabel(sum.activeMs, t)}</dd>
              </div>
              <div className="tl-stat">
                <dt>
                  <Globe aria-hidden /> {t('memory.timeline.visits')}
                </dt>
                <dd>{sum.visits.toLocaleString()}</dd>
              </div>
              <div className="tl-stat">
                <dt>
                  <Layers aria-hidden /> {t('memory.timeline.sessions')}
                </dt>
                <dd>{sum.sessions.toLocaleString()}</dd>
              </div>
            </dl>
          )}
          {topSites.length > 0 && (
            <section className="tl-top" aria-labelledby="tl-top-title">
              <h3 id="tl-top-title" className="tl-subtitle">
                {t('memory.timeline.topSites')}
              </h3>
              <ol className="tl-top__list">
                {topSites.map((site) => (
                  <li key={site.origin} className="tl-top__item">
                    <span className="tl-mono tl-top__site">{site.origin.replace(/^https?:\/\//, '')}</span>
                    <span className="tl-top__time">{activeLabel(site.activeMs, t)}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </aside>

        <div className="tl__main">
          <h3 className="tl-scope" aria-live="polite">
            {scopeTitle}
          </h3>

          {activity?.proactive.insights === true && <Insights range={range} refreshKey={refreshKey} />}

          <section aria-labelledby="tl-sessions-title" aria-busy={loading}>
            <h3 id="tl-sessions-title" className="tl-subtitle">
              {t('memory.timeline.sessions')}
            </h3>
            {loading && <SkeletonRows rows={4} label={t('memory.timeline.loading')} />}
            {!loading && error && (
              <ErrorState
                title={t('memory.timeline.error')}
                message={error}
                onRetry={() => {
                  reloadDays()
                  reloadSessions()
                }}
              />
            )}
            {empty && <EmptyState icon={<Clock />} title={day === today && scope === 'day' ? t('memory.timeline.empty') : t('memory.timeline.emptyDay')} description={t('memory.timeline.emptyHint')} />}
            {!loading && !error && sessions.status === 'ready' && (
              <div className="tl-days">
                {sessions.data
                  .filter((d) => d.sessions.length > 0)
                  .reverse()
                  .map((d) => (
                    <div key={d.day} className="tl-day">
                      {scope === 'week' && <h4 className="tl-day__title">{dateLabel(localDayBounds(d.day).from, now)}</h4>}
                      <ol className="tl-sessions">
                        {[...d.sessions].reverse().map((s) => (
                          <SessionRow key={s.id} session={s} />
                        ))}
                      </ol>
                    </div>
                  ))}
              </div>
            )}
          </section>

          {thumbs.length > 0 && (
            <section className="tl-gallery" aria-labelledby="tl-gallery-title">
              <h3 id="tl-gallery-title" className="tl-subtitle">
                {t('memory.timeline.gallery')}
              </h3>
              <ul className="tl-gallery__grid">
                {thumbs.map((thumb) => (
                  <li key={`${thumb.at}-${thumb.url}`}>
                    <button type="button" className="tl-thumb" onClick={() => void apex.tabs.create(thumb.url)} aria-label={`${thumb.url.replace(/^https?:\/\//, '')}, ${timeLabel(thumb.at)}`}>
                      <img src={thumb.media} alt="" loading="lazy" />
                      <span className="tl-thumb__time">{timeLabel(thumb.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="tl-sites-title">
            <h3 id="tl-sites-title" className="tl-subtitle">
              {t('memory.timeline.sites')}
            </h3>
            <SiteTable range={range} refreshKey={refreshKey} />
          </section>
        </div>
      </div>
    </div>
  )
}

function SessionRow({ session }: { session: TimelineSession }): ReactElement {
  const t = useT()
  const [open, setOpen] = useState(false)
  const active = session.sites.reduce((n, s) => n + s.activeMs, 0)
  const shown = open ? session.sites : session.sites.slice(0, 4)
  return (
    <li className="tl-session">
      <div className="tl-session__time">
        <span className="tl-session__range">{t('memory.timeline.session', { start: timeLabel(session.start), end: timeLabel(session.end) })}</span>
        <span className="tl-session__meta">
          {activeLabel(active, t)} · {t('memory.timeline.sessionSites', { count: session.sites.length })}
        </span>
      </div>
      <div className="tl-session__body">
        <ul className="tl-session__sites">
          {shown.map((site) => (
            <li key={site.origin} className="tl-chip" title={site.title || undefined}>
              <span className="tl-mono">{site.origin.replace(/^https?:\/\//, '')}</span>
              <span className="tl-chip__time">{activeLabel(site.activeMs, t)}</span>
            </li>
          ))}
          {session.sites.length > 4 && (
            <li>
              <button type="button" className="tl-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {open ? '−' : `+${session.sites.length - 4}`}
              </button>
            </li>
          )}
        </ul>
        {session.note && <p className="tl-session__note">{session.note}</p>}
      </div>
    </li>
  )
}

/** Possible to-dos and insights: only while you opted in; each can be dismissed. */
function Insights({ range, refreshKey }: { range: { from: number; to: number }; refreshKey: number }): ReactElement {
  const t = useT()
  const [state, retry] = useLoaded(() => call('timeline', 'insights', range), [range.from, range.to, refreshKey])
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const dismiss = (insight: Insight): void => {
    setDismissed((s) => new Set(s).add(insight.id))
    void call('timeline', 'dismissInsight', insight.id).catch(() => setDismissed((s) => new Set([...s].filter((id) => id !== insight.id))))
  }
  const items = state.status === 'ready' ? state.data.filter((i) => !dismissed.has(i.id)) : []
  return (
    <section className="tl-insights" aria-labelledby="tl-insights-title" aria-busy={state.status === 'loading'}>
      <h3 id="tl-insights-title" className="tl-subtitle">
        <Lightbulb aria-hidden /> {t('memory.timeline.insights')}
      </h3>
      {state.status === 'loading' && <SkeletonRows rows={2} label={t('memory.timeline.insightsLoading')} />}
      {state.status === 'error' && <ErrorState compact title={t('memory.timeline.insightsError')} message={state.error} onRetry={retry} />}
      {state.status === 'ready' && items.length === 0 && <p className="tl-muted">{t('memory.timeline.insightsEmpty')}</p>}
      {items.length > 0 && (
        <ul className="tl-insights__list">
          {items.map((insight) => (
            <li key={insight.id} className={cx('tl-insight', `tl-insight--${insight.kind}`)}>
              <div className="tl-insight__text">
                <span className="tl-insight__kind">{t(`memory.timeline.kind.${insight.kind}`)}</span>
                <span className="tl-insight__title">{insight.title}</span>
                {insight.detail && <span className="tl-insight__detail">{insight.detail}</span>}
                {insight.action && (
                  <button type="button" className="tl-link" onClick={() => void call('pages', 'open', (insight.action as { url: string }).url)}>
                    {insight.action.label}
                  </button>
                )}
              </div>
              <IconButton size="sm" label={`${t('memory.timeline.dismiss')}: ${insight.title}`} icon={<X />} onClick={() => dismiss(insight)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
