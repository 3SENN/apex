/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { AppWindow, ArrowDown, ArrowUp, Cog, Cpu, Globe, Layers, PanelLeft, X } from 'lucide-react'
import type { TaskKind, TaskManagerSurfaceProps, TaskRow } from '@shared/dialogs'
import { call, formatBytes } from '../../../../api'
import { useT } from '../../../../i18n/useT'
import { tabbables } from '../../../../ui/layers'
import { cx } from '../../../../ui/logic/format'
import { trapFocusIndex } from '../../../../ui/logic/keys'
import type { SurfaceComponentProps } from '../../../types'
import { TASK_POLL_MS, formatCpu, keepSelection, moveSelection, nextSort, sortTasks, totals, type TaskSort, type TaskSortKey } from './taskLogic'
import '../dialog/dialog.css'
import './taskManager.css'

// The `task-manager` sheet (⇧Esc): the browser, the GPU, each
// window's chrome, the overlays and every tab, with memory and CPU, refreshed
// every two seconds. A tab can be ended; the crash page then offers a
// reload. Arrow keys move the selection, Delete ends it, Esc closes.

const KIND_ICON: Record<TaskKind, ReactNode> = {
  browser: <AppWindow />,
  gpu: <Cpu />,
  chrome: <PanelLeft />,
  overlay: <Layers />,
  tab: <Globe />,
  view: <Globe />,
  utility: <Cog />,
}

function RowIcon({ row }: { row: TaskRow }): ReactElement {
  const [broken, setBroken] = useState(false)
  if (row.icon && !broken) return <img className="tm__favicon" src={row.icon} alt="" onError={() => setBroken(true)} />
  return <span className="tm__kind">{KIND_ICON[row.kind]}</span>
}

export function TaskManagerSheet({ close, exiting }: SurfaceComponentProps<TaskManagerSurfaceProps>): ReactElement {
  const t = useT()
  const titleId = useId()
  const rowIdBase = useId()
  const [rows, setRows] = useState<TaskRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [sort, setSort] = useState<TaskSort | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const tableRef = useRef<HTMLTableElement>(null)
  const panelRef = useRef<HTMLElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await call('taskManager', 'list')
      setRows(next)
      setFailed(false)
      setSelected((id) => keepSelection(next, id))
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    if (exiting) return
    void refresh()
    const timer = setInterval(() => void refresh(), TASK_POLL_MS)
    return () => clearInterval(timer)
  }, [exiting, refresh])

  useEffect(() => {
    tableRef.current?.focus()
  }, [])

  const shown = useMemo(() => sortTasks(rows ?? [], sort), [rows, sort])
  const sum = useMemo(() => totals(shown), [shown])
  const current = shown.find((r) => r.id === selected) ?? null
  const rowDomId = (id: string): string => `${rowIdBase}-${id.replace(/[^a-z0-9_-]/gi, '_')}`

  const end = (): void => {
    if (!current?.canEnd) return
    void Promise.resolve(call('taskManager', 'end', current.id)).finally(() => void refresh())
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>): void => {
    const moved = moveSelection(shown, selected, e.key)
    if (moved !== undefined) {
      e.preventDefault()
      setSelected(moved)
      if (moved) document.getElementById(rowDomId(moved))?.scrollIntoView({ block: 'nearest' })
      return
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && current?.canEnd) {
      e.preventDefault()
      end()
    }
  }

  // Tab stays inside the sheet.
  const trap = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'Tab') return
    const items = tabbables(panelRef.current)
    if (items.length === 0) return
    e.preventDefault()
    items[trapFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey)]?.focus()
  }

  const header = (key: TaskSortKey, label: string, numeric = false): ReactElement => {
    const active = sort?.key === key
    return (
      <th scope="col" className={cx('tm__th', numeric && 'tm__num')} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className="tm__sort" tabIndex={-1} onClick={() => setSort((s) => nextSort(s, key))}>
          {label}
          {active && <span aria-hidden>{sort.dir === 'asc' ? <ArrowUp /> : <ArrowDown />}</span>}
        </button>
      </th>
    )
  }

  return (
    <div className="dlg-layer" data-state={exiting ? 'closing' : 'open'}>
      <div className="dlg-layer__scrim" aria-hidden onPointerDown={() => !exiting && close()} />
      <section ref={panelRef} className="tm" role="dialog" aria-modal="true" aria-labelledby={titleId} data-state={exiting ? 'closing' : 'open'} onKeyDown={trap}>
        <header className="tm__header">
          <h2 id={titleId} className="tm__title">
            {t('menus.taskManager.title')}
          </h2>
          <button type="button" className="tm__close" aria-label={t('menus.dialog.close')} onClick={() => close()}>
            <X aria-hidden />
          </button>
        </header>
        <div className="tm__body">
          {rows === null && !failed && <p className="tm__note" role="status">{t('menus.taskManager.loading')}</p>}
          {rows === null && failed && <p className="tm__note tm__note--error" role="alert">{t('menus.taskManager.failed')}</p>}
          {rows !== null && (
            <table
              ref={tableRef}
              className="tm__table"
              role="grid"
              aria-labelledby={titleId}
              aria-rowcount={shown.length + 1}
              tabIndex={0}
              aria-activedescendant={current ? rowDomId(current.id) : undefined}
              onKeyDown={onKeyDown}
            >
              <thead>
                <tr>
                  {header('title', t('menus.taskManager.task'))}
                  {header('memory', t('menus.taskManager.memory'), true)}
                  {header('cpu', t('menus.taskManager.cpu'), true)}
                  {header('pid', t('menus.taskManager.pid'), true)}
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr
                    key={row.id}
                    id={rowDomId(row.id)}
                    className={cx('tm__row', row.id === selected && 'tm__row--selected')}
                    aria-selected={row.id === selected}
                    onPointerDown={() => setSelected(row.id)}
                    onDoubleClick={() => row.canEnd && end()}
                  >
                    <td className="tm__task">
                      <RowIcon row={row} />
                      <span className="tm__name" title={row.title}>
                        {row.title}
                      </span>
                    </td>
                    <td className="tm__num">{formatBytes(row.memoryBytes)}</td>
                    <td className="tm__num">{formatCpu(row.cpuPercent)}</td>
                    <td className="tm__num tm__pid">{row.pid || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <footer className="tm__footer">
          <div className="tm__summary">
            <span>{t('menus.taskManager.total', { count: sum.count, memory: formatBytes(sum.memoryBytes) })}</span>
            {failed && rows !== null && (
              <span className="tm__stale" role="status">
                {t('menus.taskManager.failed')}
              </span>
            )}
            {current && !current.canEnd && <span className="tm__hint">{t('menus.taskManager.endHint')}</span>}
          </div>
          <button type="button" className="ui-btn ui-btn--md ui-btn--danger" disabled={!current?.canEnd} onClick={end}>
            {t('menus.taskManager.end')}
          </button>
        </footer>
      </section>
    </div>
  )
}
