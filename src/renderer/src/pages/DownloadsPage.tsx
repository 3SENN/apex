/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://downloads: every download with its progress, speed and time left,
// files waiting for Keep or Discard, and the finished ones to open,
// reveal or drag out.
import { useEffect, useState, type DragEvent, type MouseEvent, type ReactElement } from 'react'
import { Download, FolderOpen, RotateCw, Settings as SettingsIcon, X } from 'lucide-react'
import { downloadActions, downloadPercent, downloadPhase, downloadStatus, fileKind, isClearable, toDownloadRow, type DownloadFolderView } from '@shared/downloads'
import type { DownloadInfo } from '@shared/services'
import { call, errorText, useAppEvent } from '../api'
import { useT } from '../i18n/useT'
import { FileKindIcon } from '../overlay/surfaces/menus/downloads/FileKindIcon'
import '../overlay/surfaces/menus/downloads/downloads.css'
import { Button, EmptyState, IconButton, RelativeTime, cx, showContextMenu, useToast } from '../ui'
import { useLiveResource } from '../settings/data'
import { DestinationFrame, ListState } from '../settings/destinations/common'
import { ListFrame, Notice, PageHeader, SearchField } from '../settings/kit'
import { matchesQuery } from '../settings/logic/filters'

export function DownloadsPage(): ReactElement {
  const t = useT()
  const downloads = useLiveResource(() => call('downloads', 'list'), 'downloads', (e) => e.items)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState<DownloadFolderView | null>(null)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const toast = useToast()
  const all = downloads.data ?? []
  const shown = all.filter((d) => matchesQuery([d.filename, d.url], query))
  const waiting = all.filter((d) => downloadPhase(d) === 'review').length

  // The fallback notice (ST-45): read on open and whenever the settings change.
  const readFolder = (): void => {
    call('downloads', 'folder')
      .then(setFolder)
      .catch(() => setFolder(null))
  }
  useEffect(readFolder, [])
  useAppEvent('settings', readFolder)

  const run = async (d: DownloadInfo, action: () => Promise<unknown>, done?: string): Promise<void> => {
    if (busy.has(d.id)) return
    setBusy((prev) => new Set(prev).add(d.id))
    try {
      await action()
      if (done) toast.show({ message: done })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(d.id)
        return next
      })
    }
  }

  const clear = async (): Promise<void> => {
    try {
      await call('downloads', 'clear')
      toast.show({ message: t('downloads.page.cleared') })
    } catch (err) {
      toast.show({ tone: 'error', message: errorText(err) })
    }
  }

  const openSettings = (): void => void call('pages', 'open', 'apex://settings/downloads')

  const rowMenu = (d: DownloadInfo, e: MouseEvent): void => {
    const actions = downloadActions(downloadPhase(d))
    void showContextMenu(e, [
      { id: 'open', label: t('downloads.action.open', { name: d.filename }), enabled: actions.includes('open') },
      { id: 'reveal', label: t('downloads.action.reveal'), enabled: actions.includes('reveal') },
      { id: 'retry', label: t('downloads.action.retry'), enabled: actions.includes('retry') },
      { id: 'remove', label: t('downloads.action.remove'), enabled: actions.includes('remove') },
    ]).then((id) => {
      if (id === 'open') void run(d, () => call('downloads', 'open', d.id))
      else if (id === 'reveal') void run(d, () => call('downloads', 'showInFolder', d.id))
      else if (id === 'retry') void run(d, () => call('downloads', 'retry', d.id))
      else if (id === 'remove') void run(d, () => call('downloads', 'remove', d.id), t('downloads.toast.removed', { name: d.filename }))
    })
  }

  return (
    <DestinationFrame label={t('downloads.page.title')}>
      <PageHeader
        title={t('downloads.page.title')}
        description={t('downloads.page.description')}
        actions={
          <>
            <Button variant="ghost" icon={<SettingsIcon />} onClick={openSettings}>
              {t('downloads.page.settings')}
            </Button>
            <Button variant="secondary" disabled={!all.some(isClearable)} onClick={() => void clear()}>
              {t('downloads.page.clear')}
            </Button>
          </>
        }
      />
      {folder?.missing && (
        <Notice
          tone="warning"
          action={
            <Button size="sm" onClick={openSettings}>
              {t('downloads.popover.folderSettings')}
            </Button>
          }
        >
          {t('downloads.popover.folderMissing')}
        </Notice>
      )}
      {waiting > 0 && <Notice tone="warning">{t('downloads.page.waiting', { count: waiting })}</Notice>}
      {all.length > 0 && (
        <div className="sp-toolbar">
          <SearchField value={query} onChange={setQuery} placeholder={t('downloads.page.search')} />
        </div>
      )}
      <ListState
        items={downloads.data}
        shown={shown.length}
        error={downloads.error}
        onRetry={downloads.reload}
        loadingLabel={t('downloads.page.loading')}
        onClearFilters={query ? () => setQuery('') : undefined}
        empty={<EmptyState icon={<Download />} title={t('downloads.page.empty')} description={t('downloads.page.emptyDetail')} />}
      >
        <ListFrame label={t('downloads.page.title')}>
          {shown.map((d) => (
            <DownloadItemRow key={d.id} d={d} busy={busy.has(d.id)} run={run} onMenu={rowMenu} />
          ))}
        </ListFrame>
      </ListState>
    </DestinationFrame>
  )
}

function DownloadItemRow({ d, busy, run, onMenu }: { d: DownloadInfo; busy: boolean; run(d: DownloadInfo, action: () => Promise<unknown>, done?: string): Promise<void>; onMenu(d: DownloadInfo, e: MouseEvent): void }): ReactElement {
  const t = useT()
  const phase = downloadPhase(d)
  const actions = downloadActions(phase)
  const percent = downloadPercent(d)
  const canDrag = actions.includes('drag')
  const status = downloadStatus(toDownloadRow(d))
  const tone = phase === 'review' ? (d.danger === 'dangerous' ? 'danger' : 'warning') : phase === 'failed' ? 'danger' : null

  // Main starts the native drag of the file itself.
  const onDragStart = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    void run(d, () => call('downloads', 'startDrag', d.id))
  }

  return (
    <div
      className={cx('sp-item', 'dl-page__item', (phase === 'failed' || phase === 'cancelled') && 'sp-item--muted')}
      draggable={canDrag || undefined}
      onDragStart={canDrag ? onDragStart : undefined}
      onContextMenu={(e) => onMenu(d, e)}
    >
      <FileKindIcon kind={fileKind(d.filename, d.mime)} />
      <div className="dl-page__body">
        <button
          type="button"
          className="sp-item__main"
          aria-disabled={actions.includes('open') ? undefined : true}
          title={canDrag ? t('downloads.action.dragHint') : undefined}
          onClick={() => actions.includes('open') && void run(d, () => call('downloads', 'open', d.id))}
          onKeyDown={(e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && actions.includes('remove')) {
              e.preventDefault()
              void run(d, () => call('downloads', 'remove', d.id), t('downloads.toast.removed', { name: d.filename }))
            }
          }}
          aria-label={actions.includes('open') ? `${t('downloads.action.open', { name: d.filename })}. ${status}` : `${d.filename}. ${status}`}
        >
          <span className="sp-item__title">
            <span className="sp-item__title-text">{d.filename}</span>
            {d.byAgent && <span className="dl-page__badge">{t('downloads.status.byAgent')}</span>}
          </span>
          <span className={cx('sp-item__sub', 'dl-page__status', tone && `dl-page__status--${tone}`)} aria-hidden>
            {status}
          </span>
        </button>
        {phase === 'running' && (
          <span className={cx('dl-bar', percent === null && 'dl-bar--unknown')} role="progressbar" aria-label={t('downloads.progressLabel', { name: d.filename })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
            <i style={percent === null ? undefined : { width: `${percent}%` }} />
          </span>
        )}
        {phase === 'review' && (
          <div className="dl-page__review">
            <Button size="sm" variant="secondary" loading={busy} aria-label={t('downloads.action.keepLabel', { name: d.filename })} onClick={() => void run(d, () => call('downloads', 'keep', d.id), t('downloads.toast.kept', { name: d.filename }))}>
              {t('downloads.action.keep')}
            </Button>
            <Button size="sm" variant="danger" disabled={busy} aria-label={t('downloads.action.discardLabel', { name: d.filename })} onClick={() => void run(d, () => call('downloads', 'discard', d.id), t('downloads.toast.discarded', { name: d.filename }))}>
              {t('downloads.action.discard')}
            </Button>
          </div>
        )}
      </div>
      <span className="sp-item__meta">{phase === 'done' && <RelativeTime value={d.startedAt} />}</span>
      <div className="sp-item__actions">
        {actions.includes('cancel') && <IconButton size="sm" label={t('downloads.action.cancelLabel', { name: d.filename })} icon={<X />} onClick={() => void run(d, () => call('downloads', 'cancel', d.id))} />}
        {actions.includes('reveal') && <IconButton size="sm" label={t('downloads.action.reveal')} icon={<FolderOpen />} onClick={() => void run(d, () => call('downloads', 'showInFolder', d.id))} />}
        {actions.includes('retry') && <IconButton size="sm" label={t('downloads.action.retry')} icon={<RotateCw />} disabled={busy} onClick={() => void run(d, () => call('downloads', 'retry', d.id))} />}
        {actions.includes('remove') && <IconButton size="sm" label={t('downloads.action.remove')} icon={<X />} onClick={() => void run(d, () => call('downloads', 'remove', d.id), t('downloads.toast.removed', { name: d.filename }))} />}
      </div>
    </div>
  )
}
