/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useRef, useState, type MouseEvent, type ReactElement, type ReactNode, type Ref } from 'react'
import { ChevronDown, ChevronRight, CircleHelp, Search } from 'lucide-react'
import { Skeleton, cx } from '../ui'
import { SKELETON_DELAY_MS, SKELETON_HOLD_MS, shouldTakeFocus } from './logic/listTemplate'
import { useT } from '../i18n/useT'

// The card's list-tab template (DS-113): every tab but General opens with
// the same header (title, a 36 px round help button and a 36 px ink action
// pill) and a fully rounded 36 px search row with an optional round filter
// or sort button. The help button opens a short explanation in place.

interface ListTabHeaderProps {
  title: ReactNode
  /** What the tab is for, shown when the help button is pressed. */
  help: ReactNode
  action?: { label: string; icon?: ReactNode; onClick(e: MouseEvent<HTMLButtonElement>): void; menu?: boolean; ref?: Ref<HTMLButtonElement>; disabled?: boolean }
  /** Extra content beside the title (a save status). */
  extra?: ReactNode
}

export function ListTabHeader({ title, help, action, extra }: ListTabHeaderProps): ReactElement {
  const t = useT()
  const [helpOpen, setHelpOpen] = useState(false)
  const helpId = useId()
  return (
    <>
      <div className="co-listhead">
        <h3 className="co-listhead__title">{title}</h3>
        {extra}
        <span className="co-listhead__actions">
          <button type="button" className="co-listhead__help" aria-label={t('coCard.list.aboutThisTab')} aria-expanded={helpOpen} aria-controls={helpId} title={t('coCard.list.aboutThisTab')} onClick={() => setHelpOpen((v) => !v)}>
            <CircleHelp aria-hidden />
          </button>
          {action && (
            <button ref={action.ref} type="button" className="co-ink-pill" aria-haspopup={action.menu ? 'menu' : undefined} disabled={action.disabled} onClick={action.onClick}>
              {action.icon}
              {action.label}
            </button>
          )}
        </span>
      </div>
      <p id={helpId} className="co-listhead__about" hidden={!helpOpen}>
        {help}
      </p>
    </>
  )
}

interface ListSearchProps {
  value: string
  onChange(value: string): void
  placeholder: string
  /** A round filter or sort button (or a small control) after the field. */
  trailing?: ReactNode
  /** The field takes focus when the tab opens. */
  focusOnMount?: boolean
}

export function ListSearch({ value, onChange, placeholder, trailing, focusOnMount = true }: ListSearchProps): ReactElement {
  const field = useRef<HTMLInputElement>(null)
  // How focus last arrived: the tab switch and a click keep the hairline
  // field (DS-113); only a keyboard arrival (Tab) adds the focus halo.
  const arrival = useRef<FocusArrival>('keys')
  const [keyed, setKeyed] = useState(false)
  useEffect(() => {
    if (!focusOnMount || !shouldTakeFocus(document.activeElement)) return
    arrival.current = 'auto'
    field.current?.focus({ preventScroll: true })
  }, [focusOnMount])
  return (
    <div className="co-listsearch">
      <label
        className="co-listsearch__field"
        data-keyed={keyed || undefined}
        onPointerDown={() => {
          arrival.current = 'pointer'
        }}
      >
        <Search aria-hidden />
        <input
          ref={field}
          type="search"
          placeholder={placeholder}
          aria-label={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setKeyed(arrival.current === 'keys')}
          onBlur={() => {
            arrival.current = 'keys'
            setKeyed(false)
          }}
        />
      </label>
      {trailing}
    </div>
  )
}

type FocusArrival = 'auto' | 'pointer' | 'keys'

/** The round hairline button after the search field. */
export function ListRoundButton({ label, icon, onClick, pressed, className }: { label: string; icon: ReactNode; onClick(e: MouseEvent<HTMLButtonElement>): void; pressed?: boolean; className?: string }): ReactElement {
  return (
    <button type="button" className={cx('co-listsearch__button', className)} aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}>
      {icon}
    </button>
  )
}

/** DS-113: an empty list is one muted 14 px line. */
export function ListEmpty({ children }: { children: ReactNode }): ReactElement {
  return <p className="co-empty-line">{children}</p>
}

/**
 * DS-114/DS-37: a group's 28 px disclosure (a chevron, a muted label, then a
 * lighter count) that sticks under the tab row while the list scrolls. It is
 * a heading, so screen readers can jump between groups.
 */
export function GroupToggle({ label, count, open, onToggle }: { label: ReactNode; count: number; open: boolean; onToggle(): void }): ReactElement {
  return (
    <h4 className="co-group">
      <button type="button" className="co-group-toggle" aria-expanded={open} onClick={onToggle}>
        {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        <span className="co-group-toggle__label">{label}</span>
        <span className="co-group-toggle__count">{count}</span>
      </button>
    </h4>
  )
}

export type SkeletonPhase = 'wait' | 'skeleton' | 'done'

/**
 * DS-106 for a list tab: while `loading`, nothing shows for the first
 * ~100 ms; then the skeleton shows, and once shown it stays at least
 * ~100 ms more so it never flashes. 'done' means show the data.
 */
export function useSkeletonPhase(loading: boolean): SkeletonPhase {
  const [phase, setPhase] = useState<SkeletonPhase>(loading ? 'wait' : 'done')
  const current = useRef(phase)
  current.current = phase
  const shownAt = useRef(0)
  useEffect(() => {
    if (loading) {
      if (current.current === 'skeleton') return
      setPhase('wait')
      const timer = setTimeout(() => {
        shownAt.current = Date.now()
        setPhase('skeleton')
      }, SKELETON_DELAY_MS)
      return () => clearTimeout(timer)
    }
    if (current.current !== 'skeleton') {
      setPhase('done')
      return
    }
    const timer = setTimeout(() => setPhase('done'), Math.max(0, shownAt.current + SKELETON_HOLD_MS - Date.now()))
    return () => clearTimeout(timer)
  }, [loading])
  return phase
}

/** DS-113: four placeholder rows shaped like the list: an icon square, a bar, a right bar and a round button. */
export function ListSkeleton({ label, rows = 4 }: { label: string; rows?: number }): ReactElement {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="co-skel">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="co-skel__row" aria-hidden="true">
          <Skeleton width={16} height={16} radius={4} className="co-skel__icon" />
          <Skeleton width={`${78 - ((i * 19) % 34)}%`} height={10} radius={5} className="co-skel__bar" />
          <Skeleton width={`${64 - ((i * 13) % 26)}%`} height={9} radius={5} className="co-skel__right" />
          <Skeleton circle width={26} className="co-skel__button" />
        </div>
      ))}
    </div>
  )
}
