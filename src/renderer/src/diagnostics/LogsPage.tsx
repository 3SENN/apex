/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { ArrowDown, ClipboardCopy, FolderOpen, RefreshCw, ScrollText, Trash2 } from 'lucide-react'
import { LOG_LEVELS, type LogEntry, type LogLevel } from '@shared/diagnostics'
import { call, errorText, useAppEvent } from '../api'
import { useT } from '../i18n/useT'
import { DestinationFrame } from '../settings/destinations/common'
import { PageHeader, SearchField } from '../settings/kit'
import { Button, EmptyState, ErrorState, Select, SkeletonRows, Switch, cx, isMac, useConfirm, useToast } from '../ui'
import { formatSize } from './logic/estimate'
import {
  EMPTY_FILTER,
  LOG_PAGE,
  appendLive,
  atBottom,
  copyText,
  dataText,
  formatStamp,
  formatTime,
  isFiltered,
  moveSelection,
  prependOlder,
  sourcesOf,
  toLogQuery,
  toggleLevel,
  visibleRange,
  type LogFilterState,
} from './logic/logFilter'
import './diagnostics.css'

// The log viewer at atelier://logs: search, level
// chips, a source menu, the live tail, copy, reveal and clear, over a
// virtualized monospace list that keeps to the bottom while new lines come in.

const ROW = 24
const SEARCH_DEBOUNCE_MS = 200
const LEVEL_KEYS: Record<LogLevel, 'diagnostics.logs.level.debug' | 'diagnostics.logs.level.info' | 'diagnostics.logs.level.warn' | 'diagnostics.logs.level.error'> = {
  debug: 'diagnostics.logs.level.debug',
  info: 'diagnostics.logs.level.info',
  warn: 'diagnostics.logs.level.warn',
  error: 'diagnostics.logs.level.error',
}

export function LogsPage(_props: { tabId: string }): ReactElement {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const listId = useId()
  const [filter, setFilter] = useState<LogFilterState>(EMPTY_FILTER)
  const [text, setText] = useState('')
  const [entries, setEntries] = useState<LogEntry[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [disk, setDisk] = useState({ bytes: 0, files: 0 })
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [selected, setSelected] = useState<number | null>(null)
  const [unseen, setUnseen] = useState(0)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [scroll, setScroll] = useState({ top: 0, height: 400 })
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const generation = useRef(0)
  const state = useRef({ filter, live })
  state.current = { filter, live }

  // Typing settles before the query goes to main.
  useEffect(() => {
    const timer = setTimeout(() => setFilter((f) => (f.text === text ? f : { ...f, text })), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text])

  const load = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    setError(null)
    try {
      const page = await call('diagnostics', 'logs', toLogQuery(state.current.filter, { limit: LOG_PAGE }))
      if (mine !== generation.current) return
      setEntries(page.entries)
      setHasMore(page.hasMore)
      setDisk({ bytes: page.totalBytes, files: page.files })
      setSelected(null)
      setUnseen(0)
      pinned.current = true
    } catch (err) {
      if (mine === generation.current) setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [filter, load])

  // The live tail: main sends 'log' events only while some page asks for them.
  useEffect(() => {
    if (!live) return
    void call('diagnostics', 'tail', true).catch(() => undefined)
    return () => void call('diagnostics', 'tail', false).catch(() => undefined)
  }, [live])

  useAppEvent('log', (e) => {
    if (!state.current.live) return
    setEntries((current) => {
      if (!current) return current
      const next = appendLive(current, e.entry, state.current.filter)
      if (!next) return current
      if (!pinned.current) setUnseen((n) => n + 1)
      return next
    })
  })

  const count = entries?.length ?? 0
  // Keep to the bottom while pinned; otherwise leave the view where it is.
  useLayoutEffect(() => {
    const el = list.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [count])

  useEffect(() => {
    const el = list.current
    if (!el) return
    const measure = (): void => setScroll({ top: el.scrollTop, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [entries !== null])

  const onScroll = (): void => {
    const el = list.current
    if (!el) return
    setScroll({ top: el.scrollTop, height: el.clientHeight })
    pinned.current = atBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
    if (pinned.current) setUnseen(0)
  }

  const jumpToLatest = (): void => {
    const el = list.current
    if (!el) return
    pinned.current = true
    setUnseen(0)
    el.scrollTop = el.scrollHeight
  }

  const loadOlder = async (): Promise<void> => {
    const first = entries?.[0]
    if (!first) return
    setLoadingOlder(true)
    try {
      const page = await call('diagnostics', 'logs', toLogQuery(filter, { before: first.t, limit: LOG_PAGE }))
      const el = list.current
      const before = el?.scrollHeight ?? 0
      setEntries((current) => prependOlder(page.entries, current ?? []))
      setHasMore(page.hasMore)
      setSelected((s) => (s === null ? s : s + page.entries.length))
      // Hold the lines you were reading in place.
      requestAnimationFrame(() => {
        if (el) el.scrollTop += el.scrollHeight - before
      })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setLoadingOlder(false)
    }
  }

  const clearAll = async (): Promise<void> => {
    const ok = await confirm({ title: t('diagnostics.logs.clearTitle'), message: t('diagnostics.logs.clearBody'), confirmLabel: t('diagnostics.logs.clearConfirm'), destructive: true })
    if (!ok) return
    try {
      await call('diagnostics', 'clearLogs')
      await load()
      toast.show({ tone: 'success', message: t('diagnostics.logs.cleared') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  const copyVisible = async (): Promise<void> => {
    if (!entries?.length) return
    try {
      await navigator.clipboard.writeText(copyText(entries))
      toast.show({ tone: 'success', message: t('diagnostics.logs.copied', { count: entries.length }) })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  const reveal = (): void => {
    void call('diagnostics', 'revealLogs').catch((err: unknown) => toast.show({ tone: 'error', message: errorText(err) }))
  }

  const sources = useMemo(() => sourcesOf(entries ?? []), [entries])
  const sourceOptions = useMemo(() => [{ value: '', label: t('diagnostics.logs.allSources') }, ...sources.map((s) => ({ value: s, label: s }))], [sources, t])
  const { start, end } = visibleRange(scroll.top, scroll.height, ROW, count)
  const pageRows = Math.max(1, Math.floor(scroll.height / ROW) - 1)

  const select = (index: number | null): void => {
    setSelected(index)
    const el = list.current
    if (index === null || !el) return
    const top = index * ROW
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && selected !== null) {
      e.preventDefault()
      setSelected(null)
      return
    }
    const next = moveSelection(e.key, selected, count, pageRows)
    if (next === null) return
    e.preventDefault()
    select(next)
  }

  const chosen = selected !== null ? (entries?.[selected] ?? null) : null
  const filtered = isFiltered(filter) || text.trim() !== ''
  const clearFilters = (): void => {
    setText('')
    setFilter(EMPTY_FILTER)
  }

  const body = (): ReactElement => {
    if (entries === null) {
      return error ? <ErrorState message={error} onRetry={load} /> : <SkeletonRows rows={6} label={t('diagnostics.logs.loading')} />
    }
    if (entries.length === 0) {
      return filtered ? (
        <EmptyState
          icon={<ScrollText />}
          title={t('diagnostics.logs.noMatch')}
          description={t('diagnostics.logs.noMatchDetail')}
          action={
            <button type="button" className="sp-link" onClick={clearFilters}>
              {t('diagnostics.logs.clearFilters')}
            </button>
          }
        />
      ) : (
        <EmptyState icon={<ScrollText />} title={t('diagnostics.logs.empty')} description={t('diagnostics.logs.emptyDetail')} />
      )
    }
    return (
      <div className="dg-logs__viewport">
        <div
          ref={list}
          id={listId}
          className="dg-logs__list"
          role="listbox"
          tabIndex={0}
          aria-label={t('diagnostics.logs.list')}
          aria-activedescendant={selected !== null ? `${listId}-${selected}` : undefined}
          onScroll={onScroll}
          onKeyDown={onListKey}
        >
          {hasMore && (
            <div className="dg-logs__older">
              <Button size="sm" variant="ghost" loading={loadingOlder} onClick={() => void loadOlder()}>
                {t('diagnostics.logs.older')}
              </Button>
            </div>
          )}
          <div className="dg-logs__rows" style={{ height: count * ROW }}>
            {entries.slice(start, end).map((entry, i) => {
              const index = start + i
              const data = dataText(entry)
              return (
                <div
                  key={`${entry.t}-${index}`}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === selected}
                  aria-setsize={count}
                  aria-posinset={index + 1}
                  className={cx('dg-log-row', `dg-log-row--${entry.level}`, index === selected && 'dg-log-row--selected')}
                  style={{ top: index * ROW, height: ROW }}
                  title={formatStamp(entry.t)}
                  onClick={() => select(index)}
                >
                  <span className="dg-log-row__time">{formatTime(entry.t)}</span>
                  <span className="dg-log-row__level">{entry.level}</span>
                  <span className="dg-log-row__source">{entry.source}</span>
                  <span className="dg-log-row__message">
                    {entry.message}
                    {data && <span className="dg-log-row__data"> {data}</span>}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
        {unseen > 0 && (
          <Button size="sm" variant="primary" className="dg-logs__jump" icon={<ArrowDown />} onClick={jumpToLatest}>
            {t('diagnostics.logs.newLines', { count: unseen })}
          </Button>
        )}
        {unseen === 0 && !pinned.current && count > 0 && (
          <Button size="sm" variant="secondary" className="dg-logs__jump" icon={<ArrowDown />} onClick={jumpToLatest}>
            {t('diagnostics.logs.jumpLatest')}
          </Button>
        )}
      </div>
    )
  }

  return (
    <DestinationFrame label={t('diagnostics.logs.title')}>
      <PageHeader
        title={t('diagnostics.logs.title')}
        description={t('diagnostics.logs.description')}
        actions={
          <>
            <Button variant="secondary" size="sm" icon={<RefreshCw />} onClick={() => void load()}>
              {t('diagnostics.logs.refresh')}
            </Button>
            <Button variant="secondary" size="sm" icon={<FolderOpen />} onClick={reveal}>
              {isMac ? t('diagnostics.logs.revealMac') : t('diagnostics.logs.revealOther')}
            </Button>
            <Button variant="secondary" size="sm" icon={<Trash2 />} disabled={!entries || (entries.length === 0 && !filtered)} onClick={() => void clearAll()}>
              {t('diagnostics.logs.clear')}
            </Button>
          </>
        }
      />
      <div className="dg-logs__toolbar">
        <SearchField value={text} onChange={setText} placeholder={t('diagnostics.logs.search')} />
        <div className="dg-chips" role="group" aria-label={t('diagnostics.logs.levels')}>
          {LOG_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              className={cx('dg-chip', `dg-chip--${level}`, filter.levels.includes(level) && 'dg-chip--on')}
              aria-pressed={filter.levels.includes(level)}
              onClick={() => setFilter((f) => ({ ...f, levels: toggleLevel(f.levels, level) }))}
            >
              {t(LEVEL_KEYS[level])}
            </button>
          ))}
        </div>
        <Select size="sm" aria-label={t('diagnostics.logs.source')} value={filter.source} options={sourceOptions} onChange={(source) => setFilter((f) => ({ ...f, source }))} />
        <Switch size="sm" label={t('diagnostics.logs.live')} checked={live} onChange={setLive} className="dg-logs__live" />
        <Button size="sm" variant="ghost" icon={<ClipboardCopy />} disabled={!entries?.length} onClick={() => void copyVisible()}>
          {t('diagnostics.logs.copy')}
        </Button>
      </div>
      <div className={cx('dg-logs', chosen && 'dg-logs--detail')}>{body()}</div>
      {chosen && (
        <section className="dg-logs__detail" aria-label={t('diagnostics.logs.detail')}>
          <div className="dg-logs__detail-head">
            <span className={cx('dg-badge', `dg-badge--${chosen.level}`)}>{chosen.level}</span>
            <span>{chosen.source}</span>
            <time dateTime={new Date(chosen.t).toISOString()}>{formatStamp(chosen.t)}</time>
          </div>
          <pre className="dg-logs__detail-text">{chosen.message}</pre>
          {chosen.data && <pre className="dg-logs__detail-data">{JSON.stringify(chosen.data, null, 2)}</pre>}
        </section>
      )}
      {entries !== null && (
        <p className="dg-logs__summary" aria-live="polite">
          {t('diagnostics.logs.summary', { count, size: formatSize(disk.bytes) })}
        </p>
      )}
    </DestinationFrame>
  )
}
