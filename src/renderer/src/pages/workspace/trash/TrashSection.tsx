/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Recently deleted: files, companion files, memory notes,
// skills, projects, apps and tables stay 30 days. Search, a kind filter,
// select one or many to restore or delete for good, and Empty (confirmed).
// Chats are not here: they keep their own delete.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { AppWindow, ArrowLeft, Brain, File, FolderKanban, MoreHorizontal, RotateCcw, Table2, Trash2, UserRound, WandSparkles } from 'lucide-react'
import { TRASH_KINDS, type TrashItem, type TrashKind } from '@shared/workspace'
import { call, formatBytes } from '../../../api'
import { useT } from '../../../i18n/useT'
import { useEvent, useResource } from '../../../settings/data'
import { Button, EmptyState, ErrorState, IconButton, RelativeTime, Select, SkeletonRows, VisuallyHidden, confirm, menuSeparator, showMenu, toast } from '../../../ui'
import { SearchBox, SectionHead } from '../../../workspace/kit'
import { daysLeft, pruneSelection, selectionState, toggled } from '../../../workspace/logic'
import { fail, goWorkspace } from '../../../workspace/open'

const ALL = 'all'

const KIND_ICON: Record<TrashKind, ReactElement> = {
  file: <File aria-hidden />,
  'companion-file': <UserRound aria-hidden />,
  memory: <Brain aria-hidden />,
  skill: <WandSparkles aria-hidden />,
  project: <FolderKanban aria-hidden />,
  app: <AppWindow aria-hidden />,
  table: <Table2 aria-hidden />,
}

export default function TrashSection(): ReactElement {
  const t = useT()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<TrashKind | typeof ALL>(ALL)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const filter = useMemo(() => ({ ...(kind === ALL ? {} : { kind }), ...(query ? { query } : {}) }), [kind, query])
  const items = useResource(() => call('trash', 'list', filter), JSON.stringify(filter), { keep: true })
  useEvent('trash', () => void items.reload())

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 160)
    return () => clearTimeout(timer)
  }, [text])

  const shown = items.data ?? []
  const shownIds = shown.map((i) => i.id)
  useEffect(() => setSelected((s) => pruneSelection(s, shownIds)), [shownIds.join(',')])
  const all = selectionState(shownIds, selected)

  const restore = async (ids: string[]): Promise<void> => {
    setBusy(true)
    try {
      const result = await call('trash', 'restore', ids)
      toast.show({ message: t('workspace.trash.restoredToast', { count: result.restored }), tone: 'success' })
      for (const name of result.renamed) toast.show({ message: t('workspace.trash.renamedToast', { name }), tone: 'info' })
      setSelected(new Set())
      await items.reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const purge = async (ids: string[]): Promise<void> => {
    const ok = await confirm({ title: t('workspace.trash.purgeTitle', { count: ids.length }), message: t('workspace.trash.purgeText'), confirmLabel: t('workspace.trash.purge'), destructive: true })
    if (!ok) return
    setBusy(true)
    try {
      const n = await call('trash', 'purge', ids)
      toast.show({ message: t('workspace.trash.purgedToast', { count: n }), tone: 'success' })
      setSelected(new Set())
      await items.reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const empty = async (): Promise<void> => {
    const total = await call('trash', 'list').then((all) => all.length, () => shown.length)
    const ok = await confirm({ title: t('workspace.trash.emptyConfirmTitle'), message: t('workspace.trash.emptyConfirmText', { count: total }), confirmLabel: t('workspace.trash.emptyConfirm'), destructive: true })
    if (!ok) return
    setBusy(true)
    try {
      const n = await call('trash', 'empty')
      toast.show({ message: t('workspace.trash.purgedToast', { count: n }), tone: 'success' })
      setSelected(new Set())
      await items.reload()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  const rowMenu = async (item: TrashItem, anchor: Element): Promise<void> => {
    const id = await showMenu([{ id: 'restore', label: t('workspace.trash.restore') }, menuSeparator(), { id: 'purge', label: t('workspace.trash.purge'), danger: true }], anchor)
    if (id === 'restore') void restore([item.id])
    else if (id === 'purge') void purge([item.id])
  }

  const filtered = Boolean(query) || kind !== ALL
  let body: ReactElement
  if (items.loading && !items.data) body = <SkeletonRows rows={6} label={t('workspace.section.trash')} />
  else if (items.error && !items.data) body = <ErrorState title={t('workspace.loadError')} message={items.error} onRetry={() => items.reload()} />
  else if (shown.length === 0)
    body = filtered ? (
      <EmptyState compact title={t('workspace.trash.noMatch')} description={t('workspace.trash.noMatchText')} />
    ) : (
      <EmptyState icon={<Trash2 />} title={t('workspace.trash.emptyTitle')} description={t('workspace.trash.emptyText')} />
    )
  else
    body = (
      <table className="ws-table">
        <thead>
          <tr>
            <th className="ws-col-check" scope="col">
              <input
                type="checkbox"
                aria-label={t('workspace.trash.selectAll')}
                checked={all === 'all'}
                ref={(el) => {
                  if (el) el.indeterminate = all === 'some'
                }}
                onChange={() => setSelected(all === 'all' ? new Set() : new Set(shownIds))}
              />
            </th>
            <th scope="col">{t('workspace.trash.colName')}</th>
            <th className="ws-col-kind" scope="col">
              {t('workspace.trash.colKind')}
            </th>
            <th className="ws-col-time" scope="col">
              {t('workspace.trash.colDeleted')}
            </th>
            <th className="ws-col-time" scope="col">
              <VisuallyHidden>{t('workspace.trash.daysLeftCol')}</VisuallyHidden>
            </th>
            <th className="ws-col-num" scope="col">
              {t('workspace.trash.colSize')}
            </th>
            <th className="ws-col-more" scope="col">
              <VisuallyHidden>{t('workspace.more')}</VisuallyHidden>
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((item) => (
            <tr key={item.id} aria-selected={selected.has(item.id)}>
              <td className="ws-col-check">
                <input type="checkbox" aria-label={t('workspace.trash.select', { name: item.title })} checked={selected.has(item.id)} onChange={() => setSelected((s) => toggled(s, item.id))} />
              </td>
              <td>
                <span className="ws-name">
                  <span className="ws-name__tile">{KIND_ICON[item.kind]}</span>
                  <span title={item.title}>{item.title}</span>
                </span>
              </td>
              <td>{t(`workspace.trash.kind.${item.kind}`)}</td>
              <td>
                <RelativeTime value={item.deletedAt} />
              </td>
              <td className="ws-muted">{t('workspace.trash.daysLeft', { count: daysLeft(item.expiresAt) })}</td>
              <td>{item.size === null ? '—' : formatBytes(item.size)}</td>
              <td className="ws-col-more">
                <IconButton size="sm" label={t('workspace.more')} icon={<MoreHorizontal />} aria-haspopup="menu" onClick={(e) => void rowMenu(item, e.currentTarget)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )

  const chosen = [...selected]
  return (
    <>
      <SectionHead
        lead={<IconButton label={t('workspace.back')} icon={<ArrowLeft />} onClick={() => goWorkspace('home')} />}
        title={t('workspace.section.trash')}
        subtitle={t('workspace.trash.subtitle')}
        actions={
          shown.length > 0 || filtered ? (
            <Button variant="danger" size="sm" icon={<Trash2 />} disabled={busy || (shown.length === 0 && !filtered)} onClick={() => void empty()}>
              {t('workspace.trash.empty')}
            </Button>
          ) : null
        }
      />
      <div className="ws-card__body">
        <div className="ws-toolbar">
          <SearchBox className="ws-toolbar__grow" value={text} onChange={setText} placeholder={t('workspace.trash.searchPlaceholder')} />
          <Select<TrashKind | typeof ALL>
            value={kind}
            onChange={setKind}
            aria-label={t('workspace.trash.colKind')}
            options={[{ value: ALL, label: t('workspace.trash.allKinds') }, ...TRASH_KINDS.map((k) => ({ value: k, label: t(`workspace.trash.kind.${k}`) }))]}
          />
        </div>
        {chosen.length > 0 && (
          <div className="ws-bulk" role="toolbar" aria-label={t('workspace.trash.selected', { count: chosen.length })}>
            <span className="ws-bulk__count" aria-live="polite">
              {t('workspace.trash.selected', { count: chosen.length })}
            </span>
            <Button size="sm" icon={<RotateCcw />} disabled={busy} onClick={() => void restore(chosen)}>
              {t('workspace.trash.restore')}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void purge(chosen)}>
              {t('workspace.trash.purge')}
            </Button>
          </div>
        )}
        {body}
      </div>
    </>
  )
}

