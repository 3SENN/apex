/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { Check, ChevronRight, Lock, Search } from 'lucide-react'
import { t } from '../../i18n/useT'
import { cx } from '../../ui/logic/format'
import { edgeIndex, filterItems, stepIndex, typeAhead } from '../../ui/logic/popover'
import { AIM_GRACE_MS, HOVER_OPEN_MS, cascadeKey, inSafeTriangle, type Box, type Point } from './logic'
import type { KitHandlers, KitItem } from './types'

// One level of a menu (DS-94): an optional search row, headed groups,
// switch rows, check, lock, chevron and shortcut slots. ↑ ↓, Home and End
// move; typing filters (with a search row) or jumps to a label; Enter and
// Space choose; → opens a submenu and ← or Escape close the innermost level;
// Tab closes the menu. Hovering a submenu row opens it after a short intent,
// and a pointer heading for the open submenu keeps it open (SH-54).

export interface MenuListProps {
  items: KitItem[]
  label: string
  /** Cascade depth: 0 is the root card. */
  level: number
  /** Placeholder for a search row at the top. */
  search?: string
  /** Which way this level opened; ← and → mirror for a level on the left. */
  side?: 'right' | 'left'
  /** The row whose submenu is open: it stays highlighted. */
  openIndex: number | null
  /** The open submenu's card, for the forgiving pointer path. */
  openBox: Box | null
  openSide: 'right' | 'left'
  autoFocus: boolean
  handlers: KitHandlers
  onOpen(index: number, row: HTMLElement, how: 'pointer' | 'keyboard'): void
  /** Close the submenu this level opened (the pointer moved to another row). */
  onCloseChild(): void
  /** Close this level (← or Escape in a nested level). */
  onCloseLevel(): void
}

const focusable = (item: KitItem): boolean => item.kind !== 'header' && item.kind !== 'separator' && item.kind !== 'note' && !item.disabled
const opens = (item: KitItem | undefined): boolean => !!item && !item.disabled && (!!item.submenu || !!item.panel)

export function MenuList({ items, label, level, search, side = 'right', openIndex, openBox, openSide, autoFocus, handlers, onOpen, onCloseChild, onCloseLevel }: MenuListProps): ReactElement {
  const id = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const typed = useRef({ text: '', at: 0 })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPoint = useRef<Point | null>(null)

  // With a query, headers, notes and separators drop out and only matching rows stay.
  const shown = useMemo(() => (search && query.trim() ? filterItems(items.filter(focusable), query) : items), [items, query, search])
  const nav = shown.map((item) => ({ focusable: focusable(item), label: item.label }))
  const [active, setActive] = useState(() => (autoFocus ? edgeIndex(nav, 'first') : -1))
  useEffect(() => setActive(search && query ? edgeIndex(nav, 'first') : (a) => (a >= shown.length ? edgeIndex(nav, 'first') : a)), [query, shown.length])

  useEffect(() => {
    if (!autoFocus) return
    // Opening puts the keyboard in this level at once.
    if (search) searchRef.current?.focus({ preventScroll: true })
    else listRef.current?.focus({ preventScroll: true })
    setActive((a) => (a < 0 ? edgeIndex(nav, 'first') : a))
  }, [autoFocus, search])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => () => clearTimer(), [])

  function clearTimer(): void {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  const rowEl = (index: number): HTMLElement | null => listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null

  const choose = (index: number, how: 'pointer' | 'keyboard'): void => {
    const item = shown[index]
    if (!item || !focusable(item)) return
    if (opens(item)) {
      const row = rowEl(index)
      if (row) onOpen(index, row, how)
      return
    }
    if (item.kind === 'custom') {
      // Its own controls take the keyboard (the zoom row's buttons).
      rowEl(index)?.querySelector<HTMLElement>('button:not([disabled])')?.focus()
      return
    }
    if (item.kind === 'switch') return handlers.onAction?.(item, !item.checked)
    if (item.keepOpen) return handlers.onAction?.(item)
    handlers.onChoose(item)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return
    const inSearch = e.target === searchRef.current
    const inCustom = !inSearch && e.target !== listRef.current
    // Inside a custom row's controls, only the arrows and Escape belong to the list.
    if (inCustom && !['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return
    if (inCustom) listRef.current?.focus({ preventScroll: true })
    const move = cascadeKey(e.key, level, opens(shown[active]), side)
    if (move === 'open') {
      e.preventDefault()
      const row = rowEl(active)
      if (row) onOpen(active, row, 'keyboard')
      return
    }
    if (move === 'close-level') {
      e.preventDefault()
      e.stopPropagation()
      onCloseLevel()
      return
    }
    if (move === 'dismiss') {
      e.preventDefault()
      e.stopPropagation()
      handlers.onDismiss(true)
      return
    }
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => stepIndex(nav, i < 0 ? (e.key === 'ArrowDown' ? -1 : 0) : i, e.key === 'ArrowDown' ? 1 : -1))
        return
      case 'Home':
      case 'End':
        if (inSearch) return
        e.preventDefault()
        setActive(edgeIndex(nav, e.key === 'Home' ? 'first' : 'last'))
        return
      case 'Enter':
        e.preventDefault()
        choose(active, 'keyboard')
        return
      case ' ':
        if (inSearch) return
        e.preventDefault()
        choose(active, 'keyboard')
        return
      case 'Tab':
        e.preventDefault()
        handlers.onDismiss(true)
        return
    }
    // Without a search row, typing jumps to the next label starting with what you typed.
    if (!search && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = performance.now()
      typed.current = { text: now - typed.current.at < 700 ? typed.current.text + e.key : e.key, at: now }
      const hit = typeAhead(nav, active, typed.current.text)
      if (hit >= 0) setActive(hit)
    }
  }

  /** Hover intent: open or switch submenus after a beat, longer while the pointer heads for the open one. */
  const onRowPointer = (index: number, point: Point): void => {
    const item = shown[index]
    if (!item) return
    if (focusable(item) && index !== active) setActive(index)
    const previous = lastPoint.current
    lastPoint.current = point
    if (openIndex === index) {
      clearTimer()
      return
    }
    const aiming = openIndex !== null && openBox !== null && previous !== null && inSafeTriangle(point, previous, openBox, openSide)
    clearTimer()
    if (!opens(item) && openIndex === null) return
    timer.current = setTimeout(
      () => {
        timer.current = null
        const row = rowEl(index)
        if (opens(item) && row) onOpen(index, row, 'pointer')
        else onCloseChild()
      },
      aiming ? AIM_GRACE_MS : HOVER_OPEN_MS,
    )
  }

  const activeId = active >= 0 ? `${id}-${active}` : undefined
  return (
    <div className="kit-menu">
      {search && (
        <label className="kit-search">
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            placeholder={search}
            aria-label={search}
            aria-controls={`${id}-list`}
            aria-activedescendant={activeId}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
      )}
      <div
        ref={listRef}
        id={`${id}-list`}
        className="kit-list"
        role="menu"
        aria-label={label}
        tabIndex={-1}
        aria-activedescendant={search ? undefined : activeId}
        onKeyDown={onKeyDown}
        onPointerLeave={() => {
          // Left the rows (toward a submenu, or away): no switch is pending any more.
          clearTimer()
          lastPoint.current = null
        }}
      >
        {shown.length === 0 && <div className="kit-empty">{t('menus.kit.noMatches')}</div>}
        {shown.map((item, index) => {
          if (item.kind === 'separator') return <div key={item.id} className="kit-sep" role="separator" />
          if (item.kind === 'header') return <div key={item.id} className="kit-header" role="presentation">{item.label}</div>
          if (item.kind === 'note') return <div key={item.id} className="kit-note" role="presentation">{item.label}</div>
          const role = item.kind === 'switch' ? 'menuitemcheckbox' : item.checkable ? 'menuitemradio' : 'menuitem'
          const expandable = opens(item)
          return (
            <div
              key={item.id}
              id={`${id}-${index}`}
              data-index={index}
              data-item={item.id}
              role={role}
              aria-checked={role === 'menuitem' ? undefined : Boolean(item.checked)}
              aria-disabled={item.disabled || undefined}
              aria-haspopup={expandable ? 'menu' : undefined}
              aria-expanded={expandable ? openIndex === index : undefined}
              aria-keyshortcuts={undefined}
              className={cx(
                'kit-row',
                index === active && 'kit-row--active',
                openIndex === index && 'kit-row--open',
                item.danger && 'kit-row--danger',
                item.disabled && 'kit-row--disabled',
                item.kind === 'custom' && 'kit-row--custom',
              )}
              onPointerMove={(e) => onRowPointer(index, { x: e.clientX, y: e.clientY })}
              onClick={(e) => {
                if (item.kind === 'custom' && e.target !== e.currentTarget) return
                // A click opens a submenu at once, without the hover beat.
                clearTimer()
                choose(index, 'pointer')
              }}
            >
              {item.kind === 'custom' && item.render ? (
                item.render()
              ) : (
                <>
                  {item.image ? (
                    <img className="kit-favicon" src={item.image} alt="" draggable={false} onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                  ) : (
                    item.icon && <span className="kit-icon" aria-hidden="true">{item.icon}</span>
                  )}
                  <span className="kit-label">
                    {/* Its own box, so a long label ends in an ellipsis (a bare text node in the flex column clips). */}
                    <span className="kit-label__text">{item.label}</span>
                    {item.description && <span className="kit-desc">{item.description}</span>}
                  </span>
                  <Trailing item={item} />
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Trailing({ item }: { item: KitItem }): ReactElement | null {
  if (item.kind === 'switch') {
    return (
      <span className={cx('kit-switch', item.checked && 'kit-switch--on')} aria-hidden="true">
        <span className="kit-switch__thumb" />
      </span>
    )
  }
  if (item.submenu || item.panel) return <ChevronRight className="kit-trail" aria-hidden="true" />
  if (item.locked) return <Lock className="kit-trail" aria-hidden="true" />
  if (item.checkable) {
    return item.checked ? (
      <span className="kit-check" aria-hidden="true">
        <Check />
      </span>
    ) : null
  }
  return item.shortcut ? <kbd className="kit-keys">{item.shortcut}</kbd> : null
}
