/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The activity inspector on Settings › Activity memory: what
// activity memory kept, one local day at a time, with a kind filter and a
// search; select items to delete them, or open a captured address.
import { useEffect, useId, useState, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, FileText, Globe, Image, NotebookPen, Trash2 } from 'lucide-react'
import { localDayBounds, localDayKey, type ActivityItem, type ActivityItemKind } from '@shared/activity'
import { apex, call, errorText } from '../api'
import { useT } from '../i18n/useT'
import { SearchField } from '../settings/kit'
import { Button, EmptyState, ErrorState, IconButton, Select, SkeletonRows, cx, useToast } from '../ui'
import { INSPECTOR_PAGE, KIND_FILTERS, inspectorQuery, shiftDay, timeLabel, type KindFilter } from './logic'

const KIND_ICON: Record<ActivityItemKind, ReactElement> = {
  visit: <Globe aria-hidden />,
  capture: <FileText aria-hidden />,
  screenshot: <Image aria-hidden />,
  note: <NotebookPen aria-hidden />,
}

type Loaded = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; items: ActivityItem[]; total: number }

export function Inspector({ refreshKey }: { refreshKey: number }): ReactElement {
  const t = useT()
  const toast = useToast()
  const ids = useId()
  const today = localDayKey(Date.now())
  const [day, setDay] = useState(today)
  const [kind, setKind] = useState<KindFilter>('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(INSPECTOR_PAGE)
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [attempt, setAttempt] = useState(0)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let live = true
    setLoaded((l) => (l.status === 'ready' ? l : { status: 'loading' }))
    // Typing waits a moment before it searches.
    const timer = setTimeout(
      () =>
        call('activity', 'items', inspectorQuery(day, kind, query, limit)).then(
          (r) => live && setLoaded({ status: 'ready', items: r.items, total: r.total }),
          (err: unknown) => live && setLoaded({ status: 'error', error: errorText(err) }),
        ),
      query ? 200 : 0,
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [day, kind, query, limit, attempt, refreshKey])

  // A new day, filter or search starts a new selection and the first page.
  useEffect(() => {
    setSelected(new Set())
    setLimit(INSPECTOR_PAGE)
  }, [day, kind, query])

  const items = loaded.status === 'ready' ? loaded.items : []
  const toggle = (id: string): void =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const removeSelected = async (): Promise<void> => {
    if (selected.size === 0 || deleting) return
    setDeleting(true)
    try {
      const count = await call('activity', 'remove', [...selected])
      toast.show({ message: t('memory.activity.deletedItems', { count }) })
      setSelected(new Set())
      setAttempt((n) => n + 1)
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setDeleting(false)
    }
  }

  const dayDate = new Date(localDayBounds(day).from)
  const dayText = dayDate.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(dayDate.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })

  return (
    <div className="am-inspector">
      <div className="am-inspector__bar">
        <div className="am-inspector__day" role="group" aria-label={t('memory.activity.dayLabel')}>
          <IconButton size="sm" label={t('memory.activity.prevDay')} icon={<ChevronLeft />} onClick={() => setDay(shiftDay(day, -1))} />
          <label className="am-inspector__date">
            <span className="am-visually-hidden">{t('memory.activity.dayLabel')}</span>
            <input
              type="date"
              className="sp-input sp-input--inline"
              value={day}
              max={today}
              onChange={(e) => {
                if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value) && e.target.value <= today) setDay(e.target.value)
              }}
            />
          </label>
          <IconButton size="sm" label={t('memory.activity.nextDay')} icon={<ChevronRight />} disabled={day >= today} onClick={() => setDay(shiftDay(day, 1))} />
        </div>
        <Select<KindFilter>
          size="sm"
          aria-label={t('memory.activity.kind.all')}
          value={kind}
          options={KIND_FILTERS.map((k) => ({ value: k, label: t(`memory.activity.kind.${k}`) }))}
          onChange={setKind}
        />
        <SearchField value={query} onChange={setQuery} placeholder={t('memory.activity.search')} label={t('memory.activity.search')} />
      </div>
      <p className="am-inspector__caption" id={`${ids}-caption`}>
        {dayText}
        {loaded.status === 'ready' && loaded.total > 0 && ` · ${loaded.total}`}
      </p>

      <div className="sp-list" role="region" aria-labelledby={`${ids}-caption`} aria-busy={loaded.status === 'loading'}>
        {loaded.status === 'loading' && <SkeletonRows rows={3} label={t('memory.activity.inspectorLoading')} />}
        {loaded.status === 'error' && <ErrorState title={t('memory.activity.inspectorError')} message={loaded.error} onRetry={() => setAttempt((n) => n + 1)} />}
        {loaded.status === 'ready' && items.length === 0 && <EmptyState compact title={t('memory.activity.inspectorEmpty')} />}
        {items.map((item) => {
          const checked = selected.has(item.id)
          const title = item.title || item.url || t(`memory.activity.kind.${item.kind}`)
          return (
            <div key={item.id} className={cx('sp-item', 'am-item', checked && 'am-item--selected')}>
              <input type="checkbox" className="am-item__check" checked={checked} aria-label={t('memory.activity.selectItem', { title })} onChange={() => toggle(item.id)} />
              <span className="sp-item__icon" aria-hidden>
                {KIND_ICON[item.kind]}
              </span>
              <div className="sp-item__main am-item__main">
                <span className="sp-item__title">
                  <span className="sp-item__title-text">{title}</span>
                </span>
                <span className="sp-item__sub">
                  {timeLabel(item.at)} · {t(`memory.activity.kind.${item.kind}`)}
                  {item.url && (
                    <>
                      {' · '}
                      <span className="sp-mono am-item__url">{item.url}</span>
                    </>
                  )}
                </span>
                {item.text && <span className="am-item__text">{item.text}</span>}
                {item.media && <img className="am-item__thumb" src={item.media} alt="" loading="lazy" />}
              </div>
              {item.url && (
                <div className="sp-item__actions">
                  <Button size="sm" variant="ghost" icon={<ExternalLink />} onClick={() => void apex.tabs.create(item.url as string)}>
                    {t('memory.activity.openUrl')}
                  </Button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="am-inspector__foot">
        {loaded.status === 'ready' && loaded.total > items.length && (
          <Button size="sm" variant="ghost" onClick={() => setLimit((n) => n + INSPECTOR_PAGE)}>
            {t('memory.activity.more')}
          </Button>
        )}
        <Button size="sm" variant="danger" icon={<Trash2 />} disabled={selected.size === 0} loading={deleting} onClick={() => void removeSelected()}>
          {t('memory.activity.deleteSelected', { count: selected.size })}
        </Button>
      </div>
    </div>
  )
}
