/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { Check, ChevronDown, ChevronUp, X } from 'lucide-react'
import { PLAN_COLLAPSED, gridStep, showMoreLabel, visiblePlan, type FirstWeekItem } from '@shared/firstWeek'
import { IconButton, Spinner, menuSeparator, showContextMenu, useFlip, type MenuItemSpec } from '../ui'
import { Glyph } from './glyphs'
import { useT, t } from '../i18n/useT'

interface PlanGridProps {
  items: readonly FirstWeekItem[]
  done: number
  total: number
  /** The card whose action is starting (a chat on its way). */
  busyId: string | null
  onRun(item: FirstWeekItem): void
  onDismiss(item: FirstWeekItem): void
  onSetDone(item: FirstWeekItem, done: boolean): void
}

function cardMenu(item: FirstWeekItem): MenuItemSpec[] {
  const items: MenuItemSpec[] = [{ id: 'open', label: item.kind === 'starter' ? t('firstRun.weekPlanGrid.startThisChat') : t('firstRun.weekPlanGrid.open') }]
  // Starters are ticked off by hand; the rest tick themselves off when the step is done.
  if (item.kind === 'starter') items.push({ id: item.done ? 'undone' : 'done', label: item.done ? t('firstRun.weekPlanGrid.markAsNotDone') : t('firstRun.weekPlanGrid.markAsDone') })
  items.push(menuSeparator(), { id: 'dismiss', label: t('firstRun.weekPlanGrid.putAside') })
  return items
}

/**
 * The plan: a two-column grid of cards, six at first and the rest behind a
 * pill. Arrow keys move between cards, Delete puts one aside, and the
 * context menu has the rest. Finished cards show a check and sink to the end.
 */
export function PlanGrid({ items, done, total, busyId, onRun, onDismiss, onSetDone }: PlanGridProps): ReactElement {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  // The page's entry stagger runs once; later reorders only glide (useFlip).
  const [entered, setEntered] = useState(false)
  // Cards that just appeared from Show more: they rise in, staggered from the first new one.
  const [revealedFrom, setRevealedFrom] = useState<number | null>(null)
  const grid = useRef<HTMLUListElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  /** After Delete, the card that takes the dismissed one's place gets focus once the grid updates. */
  const pendingFocus = useRef<number | null>(null)
  const { shown, more } = visiblePlan(items, expanded)
  const order = shown.map((i) => i.id).join(' ')
  useFlip(grid, order)

  useEffect(() => {
    const timer = setTimeout(() => setEntered(true), 900)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (revealedFrom === null) return
    const timer = setTimeout(() => setRevealedFrom(null), 700)
    return () => clearTimeout(timer)
  }, [revealedFrom])

  const focusCard = (index: number): void => {
    const buttons = grid.current?.querySelectorAll<HTMLButtonElement>('.fw-card__main')
    if (!buttons?.length) {
      pill.current?.focus()
      return
    }
    buttons[Math.max(0, Math.min(index, buttons.length - 1))]?.focus()
  }
  useEffect(() => {
    if (pendingFocus.current === null) return
    focusCard(pendingFocus.current)
    pendingFocus.current = null
  }, [order])

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number, item: FirstWeekItem): void => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      pendingFocus.current = index
      onDismiss(item)
      return
    }
    const next = gridStep(index, event.key, shown.length)
    if (next === null) return
    event.preventDefault()
    focusCard(next)
  }

  const onMenu = (item: FirstWeekItem) => (event: MouseEvent) => {
    void showContextMenu(event, cardMenu(item)).then((picked) => {
      if (picked === 'open') onRun(item)
      else if (picked === 'done' || picked === 'undone') onSetDone(item, picked === 'done')
      else if (picked === 'dismiss') onDismiss(item)
    })
  }

  return (
    <section className="fw-plan" aria-label={t('firstRun.weekPlanGrid.thingsToTryOf', { done, total })}>
      <ul ref={grid} className={`fw-plan__grid${entered ? ' fw-plan__grid--entered' : ''}`}>
        {shown.map((item, index) => {
          const revealed = revealedFrom !== null && index >= revealedFrom
          return (
            <li key={item.id} data-flip={item.id} data-revealed={revealed ? '' : undefined} style={{ '--i': revealed ? index - revealedFrom : index } as CSSProperties}>
              <div className={`fw-card${item.done ? ' fw-card--done' : ''}`} style={{ '--fw-hue': `var(--fw-hue-${item.hue})` } as CSSProperties} onContextMenu={onMenu(item)}>
                <button
                  type="button"
                  className="fw-card__main"
                  onClick={() => onRun(item)}
                  onKeyDown={(e) => onKey(e, index, item)}
                    aria-keyshortcuts="Delete"
                  aria-busy={busyId === item.id || undefined}
                >
                  <span className="fw-card__glyph">
                    {busyId === item.id ? (
                      <Spinner size={16} />
                    ) : item.done ? (
                      <span className="fw-card__check" role="img" aria-label={t('firstRun.weekPlanGrid.done')}>
                        <Check size={14} strokeWidth={3} aria-hidden />
                      </span>
                    ) : (
                      <Glyph glyph={item.glyph} />
                    )}
                  </span>
                  <span className="fw-card__text">
                    <span className="fw-card__title">{item.title}</span>
                    <span className="fw-card__desc">
                      {item.description}
                    </span>
                  </span>
                </button>
                <IconButton className="fw-card__dismiss" label={t('firstRun.weekPlanGrid.putAsideItem', { title: item.title })} tooltip={t('firstRun.weekPlanGrid.putAside')} icon={<X />} size="sm" tabIndex={-1} onClick={() => onDismiss(item)} />
              </div>
            </li>
          )
        })}
      </ul>
      {items.length > PLAN_COLLAPSED && (
        <div className="fw-plan__more">
          <button
            ref={pill}
            type="button"
            className="fw-pill"
            aria-expanded={expanded}
            onClick={() => {
              setRevealedFrom(expanded ? null : shown.length)
              setExpanded((e) => !e)
            }}
          >
            {showMoreLabel(more, expanded)}
            {expanded ? <ChevronUp size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
          </button>
        </div>
      )}
    </section>
  )
}
