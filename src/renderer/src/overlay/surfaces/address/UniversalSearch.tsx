/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { UniversalSearchProps } from '@shared/overlay/address'
import { flattenGroups, groupJump, type OmniboxGroup, type OmniboxRow, type UniversalFilter } from '@shared/omnibox'
import { CornerDownLeft, Search } from 'lucide-react'
import { call, errorText } from '../../../api'
import { useT, type MessageKey } from '../../../i18n/useT'
import { Kbd, cx } from '../../../ui'
import type { SurfaceComponentProps } from '../../types'
import { rowIcon } from './CommandBar'
import { groupLabel, highlight } from './rows'

// Universal search: a centred palette over every window's tabs and
// chats, Apex pages and commands. ↑↓ move, ⌘↑ and ⌘↓ jump between groups,
// Home and End go to the ends, Enter opens (switching to a tab focuses its
// window), Esc closes. The chips narrow it to one kind.
// DS-90 geometry: a ~20 px input with the shortcut hint at its right, 24 px
// chips, 40 px rows on a 44 px pitch with 20 px icons, and a go-hint on the
// preselected row.

/** The palette's own shortcut, shown light at the input's right. */
const PALETTE_SHORTCUT = 'CmdOrCtrl+Shift+A'

const FILTERS: readonly [UniversalFilter, MessageKey][] = [
  ['all', 'address.universal.all'],
  ['tabs', 'address.universal.tabs'],
  ['chats', 'address.universal.chats'],
  ['pages', 'address.universal.commands'],
]

/** Main's commit needs a tab id; universal search has none of its own, so rows run in the focused window. */
const NO_TAB = 'universal-search'

export function UniversalSearch({ props, resolve, close }: SurfaceComponentProps<UniversalSearchProps>): ReactElement {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [text, setText] = useState('')
  const [filter, setFilter] = useState<UniversalFilter>(props.filter)
  const [groups, setGroups] = useState<OmniboxGroup[]>([])
  const [selected, setSelected] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const seq = useRef(0)
  const rows = useMemo(() => flattenGroups(groups), [groups])

  useEffect(() => {
    const id = ++seq.current
    void call('omnibox', 'universal', text, filter).then(
      (next) => {
        if (id !== seq.current) return
        setGroups(next)
        setSelected(0)
        setLoaded(true)
      },
      (err: unknown) => {
        if (id === seq.current) setError(errorText(err))
      },
    )
  }, [text, filter])

  useEffect(() => {
    list.current?.querySelector(`#us-row-${selected}`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const run = async (row: OmniboxRow | undefined, background: boolean): Promise<void> => {
    if (!row) return
    try {
      const result = await call('omnibox', 'commit', NO_TAB, text, row.action, { background })
      if (!result.ok) setError(result.error)
      else resolve({ kind: 'done' })
    } catch (err) {
      setError(errorText(err))
    }
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const mod = e.metaKey || e.ctrlKey
    const count = rows.length
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void run(rows[selected], mod)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (count === 0) return
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setSelected((s) => (mod ? groupJump(groups, s, delta) : (s + delta + count) % count))
    } else if ((e.key === 'Home' || e.key === 'End') && count > 0 && (e.target !== input.current || !text)) {
      e.preventDefault()
      setSelected(e.key === 'Home' ? 0 : count - 1)
    }
  }

  let index = -1
  return (
    <div className="us" role="dialog" aria-label={t('address.universal.label')} onKeyDown={onKeyDown}>
      <div className="us__field">
        <Search size={20} aria-hidden />
        <input
          ref={input}
          data-autofocus
          value={text}
          placeholder={t('address.universal.placeholder')}
          aria-label={t('address.universal.label')}
          role="combobox"
          aria-expanded
          aria-controls="us-list"
          aria-activedescendant={rows.length ? `us-row-${selected}` : undefined}
          aria-describedby="us-hint"
          aria-keyshortcuts="Meta+Shift+A Control+Shift+A"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
        <span className="us__shortcut" aria-hidden>
          <Kbd shortcut={PALETTE_SHORTCUT} />
        </span>
      </div>
      <div className="us__chips" role="radiogroup" aria-label={t('address.universal.label')}>
        {FILTERS.map(([id, key]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={filter === id}
            className={cx('us__chip', filter === id && 'us__chip--on')}
            onClick={() => {
              setFilter(id)
              input.current?.focus()
            }}
          >
            {t(key)}
          </button>
        ))}
      </div>
      {error && (
        <p className="us__error" role="alert">
          {error}
        </p>
      )}
      <ul ref={list} className="us__list" id="us-list" role="listbox" aria-label={t('address.universal.label')}>
        {groups.map((group) =>
          group.rows.length === 0 ? null : (
            <li key={group.group} role="presentation" className="us__group">
              <div className="cb-group__label" aria-hidden>
                {groupLabel(group.group, t)}
              </div>
              <ul role="group" aria-label={groupLabel(group.group, t)}>
                {group.rows.map((row) => {
                  index += 1
                  const i = index
                  return (
                    <li
                      key={row.id}
                      id={`us-row-${i}`}
                      role="option"
                      aria-selected={i === selected}
                      className={cx('cb-row', i === selected && 'cb-row--selected')}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => setSelected(i)}
                      onClick={(e) => void run(row, e.metaKey || e.ctrlKey)}
                    >
                      <span className="cb-row__icon">{rowIcon(row)}</span>
                      <span className="cb-row__text">
                        <span className="cb-row__title">{highlight(row.title, row.match)}</span>
                        {row.subtitle && <span className="cb-row__sub">{row.subtitle}</span>}
                      </span>
                      {i === selected && (
                        <span className="us__go" aria-hidden>
                          {t('address.universal.go')}
                          <CornerDownLeft size={14} />
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </li>
          ),
        )}
      </ul>
      {loaded && rows.length === 0 && <p className="us__empty">{text.trim() ? t('address.universal.empty', { text: text.trim() }) : t('address.universal.emptyIdle')}</p>}
      <p className="ui-sr-only" id="us-hint">
        {t('address.universal.hint')}
      </p>
    </div>
  )
}
