/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The timeline's month calendar: Monday-first weeks, a dot on days with
// browsing, the chosen day (or week) marked. Arrow keys move a day or a
// week, Home and End go to the week's ends, Enter picks; days after today
// can't be picked.
import { useEffect, useRef, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { localDayBounds } from '@shared/activity'
import { calendarKey, monthGrid, monthOf, shiftMonth, weekDays, type TimelineScope } from '../../../activity/logic'
import { useT } from '../../../i18n/useT'
import { IconButton, cx } from '../../../ui'

export interface MonthCalendarProps {
  view: { year: number; month: number }
  onView(view: { year: number; month: number }): void
  scope: TimelineScope
  day: string
  today: string
  /** Visits per day key, for the dots. */
  busy: ReadonlyMap<string, number>
  onPick(day: string): void
}

export function MonthCalendar({ view, onView, scope, day, today, busy, onPick }: MonthCalendarProps): ReactElement {
  const t = useT()
  const grid = useRef<HTMLDivElement>(null)
  const focusDay = useRef<string | null>(null)
  const weeks = monthGrid(view.year, view.month)
  const week = scope === 'week' ? new Set(weekDays(day)) : null
  const title = new Date(view.year, view.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const weekdayNames = weekDays('2026-11-02').map((d) => new Date(localDayBounds(d).from).toLocaleDateString(undefined, { weekday: 'narrow' }))
  const weekdayLong = weekDays('2026-11-02').map((d) => new Date(localDayBounds(d).from).toLocaleDateString(undefined, { weekday: 'long' }))
  const atLatest = view.year > monthOf(today).year || (view.year === monthOf(today).year && view.month >= monthOf(today).month)
  // The roving tab stop: the chosen day when it is in this month, else the month's first day.
  const inView = weeks.flat().filter((d): d is string => d !== null)
  const stop = inView.includes(day) ? day : inView.includes(today) ? today : inView[0]

  useEffect(() => {
    const want = focusDay.current
    if (!want) return
    focusDay.current = null
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${want}"]`)?.focus()
  })

  const move = (key: string, from: string): boolean => {
    const next = calendarKey(key, from)
    if (!next) return false
    if (next > today) return true
    const m = monthOf(next)
    // Focus follows; the pick waits for Enter or a click, so moving stays cheap.
    if (m.year !== view.year || m.month !== view.month) {
      // The day is drawn after the month changes; focus it then.
      focusDay.current = next
      onView(m)
    } else {
      grid.current?.querySelector<HTMLButtonElement>(`[data-day="${next}"]`)?.focus()
    }
    return true
  }

  return (
    <div className="tl-cal">
      <div className="tl-cal__head">
        <IconButton size="sm" label={t('memory.timeline.prevMonth')} icon={<ChevronLeft />} onClick={() => onView(shiftMonth(view, -1))} />
        <h3 className="tl-cal__title" aria-live="polite">
          {title}
        </h3>
        <IconButton size="sm" label={t('memory.timeline.nextMonth')} icon={<ChevronRight />} disabled={atLatest} onClick={() => onView(shiftMonth(view, 1))} />
      </div>
      <div ref={grid} className="tl-cal__grid" role="grid" aria-label={title}>
        <div className="tl-cal__row" role="row">
          {weekdayNames.map((name, i) => (
            <span key={i} className="tl-cal__dow" role="columnheader" aria-label={weekdayLong[i]}>
              {name}
            </span>
          ))}
        </div>
        {weeks.map((cells, w) => (
          <div key={w} className={cx('tl-cal__row', week && cells.some((c) => c !== null && week.has(c)) && 'tl-cal__row--week')} role="row">
            {cells.map((cell, i) => {
              if (!cell) return <span key={i} className="tl-cal__empty" role="gridcell" />
              const visits = busy.get(cell) ?? 0
              const future = cell > today
              const selected = scope === 'day' ? cell === day : week?.has(cell) === true
              const label = new Date(localDayBounds(cell).from).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
              return (
                <span key={cell} role="gridcell" aria-selected={selected}>
                  <button
                    type="button"
                    data-day={cell}
                    className={cx('tl-cal__day', selected && 'tl-cal__day--selected', cell === today && 'tl-cal__day--today', visits > 0 && 'tl-cal__day--busy')}
                    tabIndex={cell === stop ? 0 : -1}
                    disabled={future}
                    aria-label={visits > 0 ? `${label}, ${t('memory.timeline.dayCount', { count: visits })}` : label}
                    aria-current={cell === today ? 'date' : undefined}
                    onClick={() => onPick(cell)}
                    onKeyDown={(e) => {
                      if (move(e.key, cell)) e.preventDefault()
                    }}
                  >
                    {Number(cell.slice(8))}
                  </button>
                </span>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
