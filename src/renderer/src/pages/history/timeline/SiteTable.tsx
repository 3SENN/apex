/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Site insights: one row per site in the range, the site in
// mono, its visits, active time and last visit. Sort by a column header or
// the menu, search, and refresh. Excluded sites never reach this table
// (main filters them).
import { useEffect, useState, type ReactElement } from 'react'
import { RefreshCw } from 'lucide-react'
import type { SiteInsight } from '@shared/timeline'
import { activeLabel, lastVisitLabel } from '../../../activity/logic'
import { call, errorText } from '../../../api'
import { useT } from '../../../i18n/useT'
import { SearchField } from '../../../settings/kit'
import { EmptyState, ErrorState, IconButton, Select, SkeletonRows } from '../../../ui'

type Sort = 'time' | 'visits' | 'recent'

type Loaded = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; sites: SiteInsight[] }

export function SiteTable({ range, refreshKey }: { range: { from: number; to: number }; refreshKey: number }): ReactElement {
  const t = useT()
  const [sort, setSort] = useState<Sort>('time')
  const [query, setQuery] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })

  useEffect(() => {
    let live = true
    const timer = setTimeout(
      () =>
        call('timeline', 'sites', { from: range.from, to: range.to, sort, ...(query.trim() ? { query: query.trim().slice(0, 500) } : {}) }).then(
          (sites) => live && setLoaded({ status: 'ready', sites }),
          (err: unknown) => live && setLoaded({ status: 'error', error: errorText(err) }),
        ),
      query ? 200 : 0,
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [range.from, range.to, sort, query, attempt, refreshKey])

  const header = (key: Sort | null, label: string, className?: string): ReactElement =>
    key ? (
      <th scope="col" className={className} aria-sort={sort === key ? 'descending' : 'none'}>
        <button type="button" className="tl-table__sort" onClick={() => setSort(key)}>
          {label}
        </button>
      </th>
    ) : (
      <th scope="col" className={className}>
        {label}
      </th>
    )
  const now = Date.now()

  return (
    <div className="tl-sites">
      <div className="tl-sites__bar">
        <SearchField value={query} onChange={setQuery} placeholder={t('memory.timeline.searchSites')} label={t('memory.timeline.searchSites')} />
        <Select<Sort>
          size="sm"
          aria-label={t('memory.timeline.sort')}
          value={sort}
          options={[
            { value: 'time', label: t('memory.timeline.sortTime') },
            { value: 'visits', label: t('memory.timeline.sortVisits') },
            { value: 'recent', label: t('memory.timeline.sortRecent') },
          ]}
          onChange={setSort}
        />
        <IconButton size="sm" label={t('memory.timeline.refresh')} icon={<RefreshCw />} onClick={() => setAttempt((n) => n + 1)} />
      </div>
      {loaded.status === 'loading' && <SkeletonRows rows={3} label={t('memory.timeline.sites')} />}
      {loaded.status === 'error' && <ErrorState compact message={loaded.error} onRetry={() => setAttempt((n) => n + 1)} />}
      {loaded.status === 'ready' && loaded.sites.length === 0 && <EmptyState compact title={t('memory.timeline.sitesEmpty')} />}
      {loaded.status === 'ready' && loaded.sites.length > 0 && (
        <div className="tl-table__wrap">
          <table className="tl-table">
            <caption className="am-visually-hidden">{t('memory.timeline.sites')}</caption>
            <thead>
              <tr>
                {header(null, t('memory.timeline.site'))}
                {header('visits', t('memory.timeline.visits'), 'tl-table__num')}
                {header('time', t('memory.timeline.activeTime'), 'tl-table__num')}
                {header('recent', t('memory.timeline.lastVisit'), 'tl-table__num')}
              </tr>
            </thead>
            <tbody>
              {loaded.sites.map((site) => (
                <tr key={site.origin}>
                  <th scope="row" className="tl-table__site">
                    <span className="tl-mono">{site.origin.replace(/^https?:\/\//, '')}</span>
                    {site.title && <span className="tl-table__title">{site.title}</span>}
                  </th>
                  <td className="tl-table__num">{site.visits.toLocaleString()}</td>
                  <td className="tl-table__num">{activeLabel(site.activeMs, t)}</td>
                  <td className="tl-table__num">{lastVisitLabel(site.lastVisit, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
