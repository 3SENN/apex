/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// A table's rows: a virtualised grid that fetches pages of
// rows as they scroll into view, with a sticky header whose buttons sort.
// Only the rows on screen (plus a margin) are in the DOM, so a million-row
// table scrolls like a small one.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import type { TableSummary } from '@shared/tables'
import { call, errorText } from '../../../api'
import { t } from '../../../i18n/useT'
import { Button, cx } from '../../../ui'

const ROW_H = 32
const PAGE = 200
const OVERSCAN = 12

export interface GridSort {
  column: string
  desc: boolean
}

/** The pages a scroll position needs (pure, for tests). */
export function pagesFor(scrollTop: number, height: number, total: number, rowH = ROW_H, page = PAGE, overscan = OVERSCAN): number[] {
  if (total <= 0) return []
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan)
  const last = Math.min(total - 1, Math.ceil((scrollTop + height) / rowH) + overscan)
  const out: number[] = []
  for (let p = Math.floor(first / page); p <= Math.floor(last / page); p++) out.push(p)
  return out
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12)))
  return String(value)
}

export function TableGrid({ table }: { table: TableSummary }): ReactElement {
  const wrap = useRef<HTMLDivElement>(null)
  const [sort, setSort] = useState<GridSort | null>(null)
  const [view, setView] = useState({ top: 0, height: 480 })
  const [pages, setPages] = useState<Map<number, unknown[][]>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(new Set<number>())
  const generation = useRef(0)

  // A new sort (or a changed table) starts from the top with an empty cache.
  useEffect(() => {
    generation.current++
    inflight.current.clear()
    setPages(new Map())
    setError(null)
    wrap.current?.scrollTo({ top: 0 })
  }, [sort, table.id, table.updatedAt, table.rowCount])

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    const measure = (): void => setView({ top: el.scrollTop, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const load = useCallback(
    (page: number): void => {
      if (inflight.current.has(page)) return
      inflight.current.add(page)
      const gen = generation.current
      Promise.resolve(call('tables', 'rows', table.id, { offset: page * PAGE, limit: PAGE, ...(sort ? { sort: sort.column, desc: sort.desc } : {}) }))
        .then((result) => {
          if (gen !== generation.current) return
          setPages((prev) => new Map(prev).set(page, result.rows))
        })
        .catch((err: unknown) => {
          if (gen !== generation.current) return
          inflight.current.delete(page)
          setError(errorText(err))
        })
    },
    [table.id, sort],
  )

  const needed = pagesFor(view.top, view.height, table.rowCount)
  useEffect(() => {
    if (error) return
    for (const p of needed) if (!pages.has(p)) load(p)
  }, [needed.join(','), pages, load, error])

  const columns = table.columns
  const template = `64px repeat(${columns.length}, minmax(140px, 1fr))`
  const style = { gridTemplateColumns: template, minWidth: 64 + columns.length * 140 } as CSSProperties
  const first = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN)
  const last = Math.min(table.rowCount - 1, Math.ceil((view.top + view.height) / ROW_H) + OVERSCAN)
  const rows: ReactElement[] = []
  for (let i = first; i <= last; i++) {
    const row = pages.get(Math.floor(i / PAGE))?.[i % PAGE]
    rows.push(
      <div key={i} role="row" aria-rowindex={i + 2} className={cx('pl-table__row', i % 2 === 1 && 'pl-table__row--alt')} style={{ ...style, top: i * ROW_H }}>
        <span role="rowheader" className="pl-cell pl-cell--index">
          {i + 1}
        </span>
        {columns.map((c, j) => {
          const value = row?.[j]
          const empty = row !== undefined && (value === null || value === undefined)
          return (
            <span key={c.name} role="gridcell" className={cx('pl-cell', c.type !== 'TEXT' && 'pl-cell--num', empty && 'pl-cell--null')} title={row ? cellText(value) : undefined}>
              {row === undefined ? '' : empty ? t('platform.tables.null') : cellText(value)}
            </span>
          )
        })}
      </div>,
    )
  }

  const toggle = (column: string): void => setSort((s) => (s?.column !== column ? { column, desc: false } : s.desc ? null : { column, desc: true }))

  return (
    <div>
      <div
        ref={wrap}
        className="pl-gridwrap"
        tabIndex={0}
        role="grid"
        aria-label={t('platform.tables.gridLabel', { name: table.name })}
        aria-rowcount={table.rowCount + 1}
        aria-colcount={columns.length + 1}
        onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      >
        <div className="pl-table" style={{ minWidth: style.minWidth }}>
          <div role="row" aria-rowindex={1} className="pl-table__head" style={style}>
            <span role="columnheader" className="pl-th pl-th--static">
              <span className="pl-sr">{t('platform.tables.rowNumber')}</span>
            </span>
            {columns.map((c) => {
              const active = sort?.column === c.name
              return (
                <span key={c.name} role="columnheader" aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'} style={{ display: 'contents' }}>
                  <button type="button" className="pl-th" onClick={() => toggle(c.name)} title={t('platform.tables.sortBy', { column: c.name })}>
                    <span>{c.name}</span>
                    <span className="pl-th__type">{c.type}</span>
                    {active ? sort.desc ? <ArrowDown aria-hidden /> : <ArrowUp aria-hidden /> : <ArrowUpDown aria-hidden className="pl-faint" />}
                  </button>
                </span>
              )
            })}
          </div>
          <div role="rowgroup" style={{ position: 'relative', height: table.rowCount * ROW_H }}>
            {rows}
          </div>
        </div>
      </div>
      <div className="pl-gridnote" aria-live="polite">
        <span>{error ? <span className="pl-error">{error}</span> : sort ? t('platform.tables.sortedBy', { column: sort.column, order: sort.desc ? t('platform.tables.desc') : t('platform.tables.asc') }) : t('platform.tables.importOrder')}</span>
        {error ? (
          <Button size="sm" onClick={() => setError(null)}>
            {t('platform.common.retry')}
          </Button>
        ) : (
          <span>{t('platform.tables.rowCount', { count: table.rowCount })}</span>
        )}
      </div>
    </div>
  )
}
