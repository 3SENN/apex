/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { Check, ChevronRight, Lock, Plus, Search } from 'lucide-react'
import { cx } from './logic/format'
import { edgeIndex, filterItems, stepIndex, typeAhead } from './logic/popover'
import { useT } from '../i18n/useT'

// The rows of an in-window menu (DS-94): headed groups, a search row, switch
// rows, and check, lock and chevron trailing slots. Arrow keys, Home and End
// move; typing filters (with a search row) or jumps to a label; Enter and
// Space choose; Escape and Tab close.

export interface PopoverItem {
  id: string
  label: string
  /** 'header' labels a group; 'switch' flips in place; 'create' is the plus-tile row. */
  kind?: 'item' | 'header' | 'separator' | 'switch' | 'create'
  /** A leading 16 px glyph, or a face. */
  icon?: ReactNode
  /** A muted second part of the row. */
  description?: string
  /** For check and switch rows. */
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  /** Tooltip, e.g. why a row is disabled. */
  title?: string
  /** 'check' shows an ink check circle on the checked row; 'lock' and 'chevron' a muted glyph. */
  trailing?: 'check' | 'lock' | 'chevron' | ReactNode
  /** Extra words the search row matches. */
  keywords?: string
  /** Semibold label (the current row in a switcher). */
  strong?: boolean
}

interface MenuListProps {
  items: PopoverItem[]
  label: string
  search?: { placeholder: string }
  onChoose(id: string): void
  onDismiss(refocus: boolean): void
  onToggle?(id: string, next: boolean): void
}

const isFocusable = (item: PopoverItem): boolean => item.kind !== 'header' && item.kind !== 'separator' && !item.disabled

export function MenuList({ items, label, search, onChoose, onDismiss, onToggle }: MenuListProps): ReactElement {
  const t = useT()
  const id = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [switches, setSwitches] = useState<Record<string, boolean>>({})
  const typed = useRef({ text: '', at: 0 })

  // With a query, headers and separators drop out and only matching rows stay.
  const shown = useMemo(() => {
    if (!search || !query.trim()) return items
    return filterItems(items.filter(isFocusable), query)
  }, [items, query, search])
  const nav = shown.map((item) => ({ focusable: isFocusable(item), label: item.label }))
  const [active, setActive] = useState(() => edgeIndex(nav, 'first'))
  useEffect(() => setActive(edgeIndex(nav, 'first')), [query])

  useEffect(() => {
    // Opening puts the keyboard in the menu at once.
    if (search) searchRef.current?.focus({ preventScroll: true })
    else listRef.current?.focus({ preventScroll: true })
  }, [search])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (index: number): void => {
    const item = shown[index]
    if (!item || !isFocusable(item)) return
    if (item.kind === 'switch') {
      const next = !(switches[item.id] ?? item.checked ?? false)
      setSwitches((s) => ({ ...s, [item.id]: next }))
      onToggle?.(item.id, next)
      return
    }
    onChoose(item.id)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.nativeEvent.isComposing) return
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => stepIndex(nav, i, e.key === 'ArrowDown' ? 1 : -1))
        return
      case 'Home':
      case 'End':
        if (search && e.target === searchRef.current) return
        e.preventDefault()
        setActive(edgeIndex(nav, e.key === 'Home' ? 'first' : 'last'))
        return
      case 'Enter':
        e.preventDefault()
        choose(active)
        return
      case ' ':
        if (search && e.target === searchRef.current) return
        e.preventDefault()
        choose(active)
        return
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        onDismiss(true)
        return
      case 'Tab':
        e.preventDefault()
        onDismiss(true)
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

  const activeId = active >= 0 ? `${id}-${active}` : undefined
  return (
    <div className="ui-pop__body">
      {search && (
        <label className="ui-pop__search">
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            placeholder={search.placeholder}
            aria-label={search.placeholder}
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
        className="ui-pop__list"
        role="menu"
        aria-label={label}
        tabIndex={-1}
        aria-activedescendant={search ? undefined : activeId}
        onKeyDown={search ? undefined : onKeyDown}
      >
        {shown.length === 0 && <div className="ui-pop__empty">{t('core.menuList.noMatches')}</div>}
        {shown.map((item, index) => {
          if (item.kind === 'separator') return <div key={item.id} className="ui-pop__sep" role="separator" />
          if (item.kind === 'header') return <div key={item.id} className="ui-pop__header" role="presentation">{item.label}</div>
          const checked = item.kind === 'switch' ? (switches[item.id] ?? item.checked ?? false) : item.checked
          const role = item.kind === 'switch' ? 'menuitemcheckbox' : item.trailing === 'check' ? 'menuitemradio' : 'menuitem'
          return (
            <div
              key={item.id}
              id={`${id}-${index}`}
              data-index={index}
              role={role}
              aria-checked={role === 'menuitem' ? undefined : Boolean(checked)}
              aria-disabled={item.disabled || undefined}
              title={item.title}
              className={cx(
                'ui-pop__item',
                index === active && 'ui-pop__item--active',
                item.danger && 'ui-pop__item--danger',
                item.disabled && 'ui-pop__item--disabled',
                item.strong && 'ui-pop__item--strong',
                item.kind === 'create' && 'ui-pop__item--create',
              )}
              onPointerMove={() => {
                if (isFocusable(item) && index !== active) setActive(index)
              }}
              onClick={() => choose(index)}
            >
              {item.kind === 'create' ? (
                <span className="ui-pop__tile" aria-hidden="true">
                  {item.icon ?? <Plus />}
                </span>
              ) : (
                item.icon && <span className="ui-pop__icon" aria-hidden="true">{item.icon}</span>
              )}
              <span className="ui-pop__label">
                {item.label}
                {item.description && <span className="ui-pop__desc">{item.description}</span>}
              </span>
              <Trailing item={item} checked={Boolean(checked)} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Trailing({ item, checked }: { item: PopoverItem; checked: boolean }): ReactElement | null {
  if (item.kind === 'switch') {
    return (
      <span className={cx('ui-pop__switch', checked && 'ui-pop__switch--on')} aria-hidden="true">
        <span className="ui-pop__switch-thumb" />
      </span>
    )
  }
  if (item.trailing === 'check') {
    return checked ? (
      <span className="ui-pop__check" aria-hidden="true">
        <Check />
      </span>
    ) : null
  }
  if (item.trailing === 'lock') return <Lock className="ui-pop__trail" aria-hidden="true" />
  if (item.trailing === 'chevron') return <ChevronRight className="ui-pop__trail" aria-hidden="true" />
  return item.trailing ? <span className="ui-pop__trail">{item.trailing}</span> : null
}
