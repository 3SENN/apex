/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { FindBarProps } from '@shared/overlay/address'
import { CLOSED_FIND, FIND_DEBOUNCE_MS, FIND_QUERY_MAX, findCount, type FindState } from '@shared/find'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { call } from '../../api'
import { useT } from '../../i18n/useT'
import { cx } from '../../ui'
import type { SurfaceComponentProps } from '../../overlay/types'

// The find bar (SH-44): an overlay surface tied to its tab, shown again
// when the tab returns. Main keeps each tab's state (open, query, matches,
// active match), so the query survives tab switches and ⌘G works from
// anywhere. Typing searches after a 60 ms pause; Enter and ⇧Enter step;
// Esc closes and leaves the active match selected in the page.

export function FindBarSurface({ props, resolve }: SurfaceComponentProps<FindBarProps>): ReactElement {
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<FindState>(CLOSED_FIND)
  const [text, setText] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typing = useRef(false)

  // Each ⌘F (focus bumps): main may have seeded the query from the selection.
  useEffect(() => {
    let live = true
    void call('find', 'state', props.tabId).then((s) => {
      if (!live) return
      setState(s)
      if (!typing.current) setText(s.query)
      requestAnimationFrame(() => {
        input.current?.focus()
        input.current?.select()
      })
    }, () => undefined)
    return () => {
      live = false
    }
  }, [props.tabId, props.focus])

  // Main pushes its state into the props as matches come back.
  useEffect(() => {
    const next = props.state
    if (!next) return
    setState(next)
    if (!typing.current) setText(next.query)
  }, [props.state])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const search = (next: string): void => {
    setText(next)
    typing.current = true
    setState((s) => ({ ...s, searching: next.length > 0 }))
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      typing.current = false
      void call('find', 'query', props.tabId, next.slice(0, FIND_QUERY_MAX)).then(setState, () => undefined)
    }, FIND_DEBOUNCE_MS)
  }

  const step = (forward: boolean): void => {
    if (timer.current) {
      // Enter right after typing searches what is in the field first.
      clearTimeout(timer.current)
      timer.current = null
      typing.current = false
      void call('find', 'query', props.tabId, text).then(setState, () => undefined)
      return
    }
    void call('find', 'step', props.tabId, forward).then(setState, () => undefined)
  }

  const closeBar = (): void => {
    void call('find', 'close', props.tabId).catch(() => undefined)
    resolve('close')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Enter') {
      e.preventDefault()
      step(!e.shiftKey)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeBar()
    } else if (mod && e.key.toLowerCase() === 'g') {
      e.preventDefault()
      step(!e.shiftKey)
    } else if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      input.current?.select()
    }
  }

  const count = findCount({ ...state, query: text })
  const countText =
    count.kind === 'searching' ? t('address.find.searching') : count.kind === 'no-matches' ? t('address.find.none') : count.kind === 'count' ? t('address.find.count', { active: count.active, total: count.matches }) : ''
  const none = count.kind === 'no-matches'
  return (
    <div className={cx('fb', none && 'fb--none')} role="search" aria-label={t('address.find.label')}>
      <Search size={14} className="fb__lead" aria-hidden />
      <input
        ref={input}
        data-autofocus
        className="fb__input"
        value={text}
        maxLength={FIND_QUERY_MAX}
        placeholder={t('address.find.placeholder')}
        aria-label={t('address.find.label')}
        aria-invalid={none || undefined}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => search(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="fb__count" aria-live="polite">
        {countText}
      </span>
      <span className="fb__sep" aria-hidden />
      <button type="button" className="fb__btn" aria-label={t('address.find.previous')} title={t('address.find.previous')} disabled={!text || state.matches === 0} onClick={() => step(false)}>
        <ChevronUp size={15} aria-hidden />
      </button>
      <button type="button" className="fb__btn" aria-label={t('address.find.next')} title={t('address.find.next')} disabled={!text || state.matches === 0} onClick={() => step(true)}>
        <ChevronDown size={15} aria-hidden />
      </button>
      <button type="button" className="fb__btn" aria-label={t('address.find.close')} title={t('address.find.close')} onClick={closeBar}>
        <X size={14} aria-hidden />
      </button>
    </div>
  )
}
