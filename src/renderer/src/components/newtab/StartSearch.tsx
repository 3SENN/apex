/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { Check, Globe, Sparkles } from 'lucide-react'
import type { SearchEngineDef } from '@shared/searchEngines'
import { useT } from '../../i18n/useT'
import { rowIcon } from '../../overlay/surfaces/address/CommandBar'
import { groupLabel, highlight } from '../../overlay/surfaces/address/rows'
import { cx } from '../../ui'
import { engineMark, type NewTabMode, type StartAction } from './searchLogic'
import type { StartSearch } from './useStartSearch'
import './startSearch.css'

// NT-01: the new tab's ask-or-search switch, the actions and local
// suggestions under the composer, and the one-time search engine choice
// (also used by setup's layout step). Engines show a drawn letter mark,
// never a fetched favicon.

type EngineLike = Pick<SearchEngineDef, 'id' | 'name'>

export function EngineMark({ engine, size = 18 }: { engine: Pick<SearchEngineDef, 'name'>; size?: number }): ReactElement {
  return (
    <span className="nt-engine-mark" style={{ '--mark-size': `${size}px` } as CSSProperties} aria-hidden="true">
      {engineMark(engine.name)}
    </span>
  )
}

/** Two options, one checked: ask the companion or search the web (arrows move between them). */
export function ModeSwitch({ mode, companionName, engine, onChange }: { mode: NewTabMode; companionName: string; engine: EngineLike; onChange(mode: NewTabMode): void }): ReactElement {
  const t = useT()
  const group = useRef<HTMLDivElement>(null)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    const next = mode === 'web' ? 'companion' : 'web'
    onChange(next)
    requestAnimationFrame(() => group.current?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus())
  }
  return (
    <div ref={group} className="nt-mode" role="radiogroup" aria-label={t('newTabSearch.mode.label')} data-mode={mode} onKeyDown={onKeyDown}>
      <button type="button" role="radio" data-mode="companion" aria-checked={mode === 'companion'} tabIndex={mode === 'companion' ? 0 : -1} className="nt-mode__option" onClick={() => onChange('companion')}>
        <Sparkles aria-hidden />
        <span className="nt-mode__text">{t('newTabSearch.mode.ask', { name: companionName })}</span>
      </button>
      <button type="button" role="radio" data-mode="web" aria-checked={mode === 'web'} tabIndex={mode === 'web' ? 0 : -1} className="nt-mode__option" aria-label={t('newTabSearch.mode.web', { engine: engine.name })} onClick={() => onChange('web')}>
        <EngineMark engine={engine} size={16} />
        <span className="nt-mode__text">{engine.name}</span>
      </button>
    </div>
  )
}

function actionTitle(action: StartAction, companionName: string, t: ReturnType<typeof useT>): string {
  if (action.kind === 'go') return t('newTabSearch.action.go', { host: action.label })
  if (action.kind === 'search') return t('newTabSearch.action.search', { engine: action.engine })
  return t('newTabSearch.action.ask', { name: companionName })
}

/** The send button's label and whether it goes, searches or asks, for what Enter would run. */
export function enterLabel(action: StartAction | null, companionName: string, t: ReturnType<typeof useT>): string | null {
  return action ? actionTitle(action, companionName, t) : null
}

function ActionIcon({ action, engine }: { action: StartAction; engine: EngineLike }): ReactElement {
  if (action.kind === 'go') return <Globe aria-hidden />
  if (action.kind === 'search') return <EngineMark engine={engine} />
  return <Sparkles aria-hidden />
}

/** The actions for what is typed, then open tabs, history and bookmarks, under the composer. */
export function StartSuggestions({ search, companionName }: { search: StartSearch; companionName: string }): ReactElement | null {
  const t = useT()
  if (!search.open) return null
  const enterAt = search.selected >= 0 ? search.selected : 0
  const altAt = search.plan.alt ? search.plan.actions.indexOf(search.plan.alt) : -1
  let index = search.plan.actions.length - 1
  const option = (i: number, content: ReactNode, sub: ReactNode, icon: ReactNode, key: string, run: () => void): ReactElement => (
    <li
      key={key}
      id={search.optionId(i)}
      role="option"
      aria-selected={i === search.selected}
      className={cx('nt-suggest__row', i === search.selected && 'nt-suggest__row--selected')}
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={() => search.setSelected(i)}
      onClick={run}
    >
      <span className="nt-suggest__icon">{icon}</span>
      <span className="nt-suggest__text">
        <span className="nt-suggest__title">{content}</span>
        {sub && <span className="nt-suggest__sub">{sub}</span>}
      </span>
      {i === enterAt ? <kbd className="nt-suggest__key">↵</kbd> : i === altAt ? <kbd className="nt-suggest__key">⌥↵</kbd> : null}
    </li>
  )
  return (
    <div className="nt-suggest" role="presentation">
      <ul className="nt-suggest__list" id={search.listId} role="listbox" aria-label={t('newTabSearch.list')}>
        {search.plan.actions.map((action, i) =>
          option(i, actionTitle(action, companionName, t), action.kind === 'go' ? null : action.kind === 'search' ? action.query : action.text, <ActionIcon action={action} engine={search.engine} />, `action:${action.kind}`, () => search.run(i)),
        )}
        {search.groups.map((group) => (
          <li key={group.group} role="presentation" className="nt-suggest__group">
            <div className="nt-suggest__label" aria-hidden="true">
              {groupLabel(group.group, t)}
            </div>
            <ul role="group" aria-label={groupLabel(group.group, t)}>
              {group.rows.map((row) => {
                index += 1
                const i = index
                return option(i, highlight(row.title, row.match), row.subtitle ?? null, rowIcon(row), row.id, () => search.run(i))
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The engines as a row of radio chips (setup and the new tab's one-time
 * choice). Arrows move between them; `pickOnArrow` (setup) also picks, while
 * the new tab's choice picks only on a click, Enter or Space.
 */
export function EngineChoiceList({ engines, value, onChoose, label, pickOnArrow = false }: { engines: readonly EngineLike[]; value: string; onChoose(id: string): void; label: string; pickOnArrow?: boolean }): ReactElement {
  const list = useRef<HTMLDivElement>(null)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.engine : undefined
    const at = Math.max(0, engines.findIndex((x) => x.id === (focusedId ?? value)))
    const next = engines[(at + step + engines.length) % engines.length]
    if (!next) return
    if (pickOnArrow) onChoose(next.id)
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`[data-engine="${next.id}"]`)?.focus())
  }
  return (
    <div ref={list} className="nt-engines" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {engines.map((engine) => (
        <button key={engine.id} type="button" role="radio" data-engine={engine.id} aria-checked={engine.id === value} tabIndex={engine.id === value ? 0 : -1} className="nt-engines__chip" onClick={() => onChoose(engine.id)}>
          <EngineMark engine={engine} size={18} />
          <span className="nt-engines__name">{engine.name}</span>
          {engine.id === value && <Check className="nt-engines__check" aria-hidden />}
        </button>
      ))}
    </div>
  )
}

/** The new tab's one-time engine choice, under the composer: pick one, or keep the current engine (Esc or a click elsewhere). */
export function EngineChooser({ engines, current, onChoose, onKeep }: { engines: readonly EngineLike[]; current: EngineLike; onChoose(id: string): void; onKeep(): void }): ReactElement {
  const t = useT()
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const away = (e: MouseEvent): void => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target) && !(e.target instanceof Element && e.target.closest('.nt-mode'))) onKeep()
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [onKeep])
  return (
    <div
      ref={root}
      className="nt-suggest nt-choose"
      role="group"
      aria-label={t('newTabSearch.choose.label')}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        onKeep()
      }}
    >
      <p className="nt-choose__title">{t('newTabSearch.choose.title')}</p>
      <EngineChoiceList engines={engines} value={current.id} onChoose={onChoose} label={t('newTabSearch.choose.label')} />
      <div className="nt-choose__foot">
        <span className="nt-choose__hint">{t('newTabSearch.choose.hint')}</span>
        <button type="button" className="nt-choose__keep" onClick={onKeep}>
          {t('newTabSearch.choose.keep', { engine: current.name })}
        </button>
      </div>
    </div>
  )
}
