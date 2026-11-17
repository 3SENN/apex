/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tables: CSV files imported into local SQLite
// tables. Their list is a block in Workspace › Files (TablesBlock: import
// with pick → preview → confirm, search, right-click to export or delete);
// apex://workspace/tables/<id> is one table (this section): a virtualised
// grid that sorts, rename, export CSV and delete to Recently Deleted, with a
// back arrow to Files. Companions read them with list_tables and
// query_table, and change them only with approval.
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { ArrowLeft, Download, FileUp, Table2, Trash2 } from 'lucide-react'
import { SHARED_OWNER } from '@shared/chats'
import type { CsvPreview, TableSummary } from '@shared/tables'
import { call, errorText } from '../../../api'
import { t } from '../../../i18n/useT'
import { useCompanions, useLiveResource } from '../../../settings/data'
import { Badge, Button, EmptyState, ErrorState, IconButton, InlineRename, RelativeTime, Select, SkeletonRows, showContextMenu, useConfirm, useToast } from '../../../ui'
import { SearchBox, SectionHead } from '../../../workspace/kit'
import { goWorkspace } from '../../../workspace/open'
import { companionLabel } from '../apps/AppsSection'
import { ImportDialog } from './ImportDialog'
import { TableGrid } from './TableGrid'
import '../../../workspace/workspace.css'
import '../../../apps/platform.css'

export interface TablesSectionProps {
  /** apex://workspace/tables/<id> opens that table. */
  itemId?: string | null
}

/** What the list and a table's page both do to a table. */
function useTableActions(): { exportCsv(table: TableSummary): Promise<void>; remove(table: TableSummary): Promise<boolean>; rename(table: TableSummary, next: string): Promise<void>; failed(err: unknown): void } {
  const confirm = useConfirm()
  const toast = useToast()
  const failed = (err: unknown): void => {
    toast.show({ tone: 'error', message: errorText(err) })
  }
  return {
    failed,
    async exportCsv(table) {
      try {
        const path = await call('tables', 'exportCsv', table.id)
        if (path) toast.show({ tone: 'success', message: t('platform.tables.exported', { name: table.name }) })
      } catch (err) {
        failed(err)
      }
    },
    async remove(table) {
      const ok = await confirm({ title: t('platform.tables.delete.title', { name: table.name }), message: t('platform.tables.delete.message'), confirmLabel: t('platform.tables.delete.confirm'), destructive: true })
      if (!ok) return false
      try {
        await call('tables', 'remove', table.id)
        toast.show({ message: t('platform.tables.deleted', { name: table.name }), action: { label: t('platform.common.recentlyDeleted'), onAction: () => goWorkspace('trash') } })
        return true
      } catch (err) {
        failed(err)
        return false
      }
    },
    async rename(table, next) {
      try {
        const renamed = await call('tables', 'rename', table.id, next)
        if (renamed.name !== next.trim()) toast.show({ message: t('platform.tables.renamedAs', { name: renamed.name }) })
      } catch (err) {
        failed(err)
      }
    },
  }
}

/** One table, apex://workspace/tables/<id>. */
export default function TablesSection({ itemId = null }: TablesSectionProps): ReactElement {
  const tables = useLiveResource(() => call('tables', 'list'), 'tables', (e) => e.items)
  const companions = useCompanions()
  const [renaming, setRenaming] = useState(false)
  const actions = useTableActions()

  const current = itemId ? ((tables.data ?? []).find((x) => x.id === itemId) ?? null) : null
  // A table deleted elsewhere (or by the agent) goes back to Files.
  useEffect(() => {
    if (tables.data && !current) goWorkspace('files')
  }, [tables.data, current])

  const back = <IconButton label={t('platform.tables.back')} icon={<ArrowLeft />} onClick={() => goWorkspace('files')} />
  if (!current) {
    return (
      <section className="ws-card" aria-label={t('platform.tables.title')}>
        <SectionHead lead={back} title={t('platform.tables.title')} />
        <div className="ws-card__body">
          {tables.error && !tables.data ? <ErrorState title={t('platform.tables.loadError')} message={tables.error} onRetry={tables.reload} /> : <SkeletonRows rows={4} avatar label={t('platform.tables.loading')} />}
        </div>
      </section>
    )
  }

  return (
    <section className="ws-card" aria-label={current.name}>
      <SectionHead
        lead={back}
        title={<InlineRename value={current.name} label={t('platform.tables.rename')} editing={renaming} onEditingChange={setRenaming} activation="double-click" onCommit={(next) => actions.rename(current, next)} />}
        subtitle={t('platform.tables.summary', { rows: t('platform.tables.rowCount', { count: current.rowCount }), columns: t('platform.tables.columnCount', { count: current.columns.length }), owner: companionLabel(current.owner, companions.items) })}
        actions={
          <>
            <Button variant="ghost" onClick={() => setRenaming(true)}>
              {t('platform.tables.renameButton')}
            </Button>
            <IconButton label={t('platform.tables.export')} icon={<Download />} onClick={() => void actions.exportCsv(current)} />
            <IconButton label={t('platform.tables.delete.menu')} tone="danger" icon={<Trash2 />} onClick={() => void actions.remove(current).then((gone) => gone && goWorkspace('files'))} />
          </>
        }
      />
      <div className="ws-card__body">
        <TableGrid key={current.id} table={current} />
        <p className="pl-faint" style={{ margin: '12px 0 0' }}>
          {current.owner === SHARED_OWNER ? t('platform.tables.agentNoteShared', { name: current.name }) : t('platform.tables.agentNoteOwn', { name: current.name, companion: companionLabel(current.owner, companions.items) })}
        </p>
      </div>
    </section>
  )
}

/** The tables, as a block in Workspace › Files: who an import is for, Import CSV, search and the list. */
export function TablesBlock(): ReactElement {
  const tables = useLiveResource(() => call('tables', 'list'), 'tables', (e) => e.items)
  const companions = useCompanions()
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState<string>(SHARED_OWNER)
  const [picking, setPicking] = useState(false)
  const [preview, setPreview] = useState<CsvPreview | null>(null)
  const toast = useToast()
  const actions = useTableActions()

  const all = tables.data ?? []
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter((x) => !q || x.name.toLowerCase().includes(q) || x.columns.some((c) => c.name.includes(q)))
  }, [all, query])

  const pick = async (): Promise<void> => {
    setPicking(true)
    try {
      const next = await call('tables', 'pickCsv', owner)
      if (next) setPreview(next)
    } catch (err) {
      actions.failed(err)
    } finally {
      setPicking(false)
    }
  }
  const menu = (table: TableSummary) => (e: { clientX: number; clientY: number; currentTarget: EventTarget | null; preventDefault(): void }) =>
    void showContextMenu(e, [
      { id: 'open', label: t('platform.tables.open') },
      { id: 'export', label: t('platform.tables.export') },
      { id: 'delete', label: t('platform.tables.delete.menu'), danger: true },
    ]).then((id) => {
      if (id === 'open') goWorkspace('tables', table.id)
      else if (id === 'export') void actions.exportCsv(table)
      else if (id === 'delete') void actions.remove(table)
    })

  const owners = [{ value: SHARED_OWNER, label: t('platform.common.shared') }, ...(companions.items ?? []).map((c) => ({ value: c.id, label: c.name }))]

  return (
    <section className="ws-block" aria-labelledby="ws-tables-title">
      <div className="ws-block__head">
        <h3 id="ws-tables-title" className="ws-block__title">
          {t('platform.tables.title')}
        </h3>
        {owners.length > 1 && <Select size="sm" value={owner} options={owners} onChange={setOwner} aria-label={t('platform.tables.importFor')} />}
        <Button size="sm" icon={<FileUp />} loading={picking} onClick={() => void pick()}>
          {t('platform.tables.import.button')}
        </Button>
      </div>
      <p className="ws-block__hint">{t('platform.tables.subtitle')}</p>
      {all.length > 5 && (
        <div className="pl-toolbar">
          <SearchBox value={query} onChange={setQuery} placeholder={t('platform.tables.search')} />
        </div>
      )}
      {tables.error && !tables.data ? (
        <ErrorState title={t('platform.tables.loadError')} message={tables.error} onRetry={tables.reload} />
      ) : !tables.data ? (
        <SkeletonRows rows={2} avatar label={t('platform.tables.loading')} />
      ) : all.length === 0 ? (
        <EmptyState compact icon={<Table2 />} title={t('platform.tables.empty.title')} description={t('platform.tables.empty.description')} />
      ) : shown.length === 0 ? (
        <EmptyState compact title={t('platform.common.noMatch', { query })} action={<Button onClick={() => setQuery('')}>{t('platform.common.clearSearch')}</Button>} />
      ) : (
        <ul className="pl-list" aria-label={t('platform.tables.title')}>
          {shown.map((table) => (
            <li key={table.id}>
              <button type="button" className="pl-list__row" onClick={() => goWorkspace('tables', table.id)} onContextMenu={menu(table)}>
                <span className="pl-list__icon">
                  <Table2 aria-hidden />
                </span>
                <span className="pl-list__text">
                  <span className="pl-list__name">{table.name}</span>
                  <span className="pl-list__sub">
                    {t('platform.tables.rowCount', { count: table.rowCount })} · {table.columns.map((c) => c.name).join(', ')}
                  </span>
                </span>
                {table.owner !== SHARED_OWNER && <Badge>{companionLabel(table.owner, companions.items)}</Badge>}
                <RelativeTime value={table.updatedAt} className="pl-faint" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ImportDialog
        preview={preview}
        onClose={(table) => {
          setPreview(null)
          if (!table) return
          toast.show({ tone: 'success', message: t('platform.tables.imported', { count: table.rowCount, name: table.name }) })
          goWorkspace('tables', table.id)
        }}
      />
    </section>
  )
}
