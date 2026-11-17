/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type DragEvent } from 'react'
import { ArrowDownAZ, ArrowRight, ChevronRight, ClockArrowDown, File, Folder, FolderOpen, MoreHorizontal } from 'lucide-react'
import type { Companion } from '@shared/companion'
import type { CompanionFileEntry } from '@shared/services'
import { call, errorText, formatBytes } from '../api'
import { Badge, ErrorState, IconButton, Modal, RelativeTime, confirm, menuSeparator, showMenu, toast } from '../ui'
import { libraryFilesUrl } from '@shared/url'
import { breadcrumbs, fileTypeLabel, filterFiles, sortFiles, type FileSort } from './logic/files'
import { ListEmpty, ListRoundButton, ListSearch, ListSkeleton, ListTabHeader, useSkeletonPhase } from './ListTab'
import { useLoaded } from './useLoaded'
import { t } from '../i18n/useT'
import { VersionHistoryPanel } from '../workspace/VersionHistoryPanel'
import { goWorkspace } from '../workspace/open'
import { useFolders } from '../workspace/data'

const MAX_BYTES = 25 * 1024 * 1024

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  // In chunks, so large files don't overflow the argument list.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

interface FilesTabProps {
  companion: Companion
  /** A deep-linked file or folder path. */
  focusPath: string | null
  /** Opens a page and closes the card (Open in Library, DS-115). */
  onOpenPage(url: string): void
}

export function FilesTab({ companion, focusPath, onOpenPage }: FilesTabProps) {
  const initialFolder = focusPath && focusPath.includes('/') ? focusPath.slice(0, focusPath.lastIndexOf('/')) : ''
  const [folder, setFolder] = useState(initialFolder)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<FileSort>('name')
  const [dragging, setDragging] = useState(false)
  const [adding, setAdding] = useState(0)
  const [history, setHistory] = useState<string | null>(null)
  const sharedFolders = (useFolders().data ?? []).filter((f) => f.companionId === companion.id)
  const files = useLoaded(() => call('companionFiles', 'list', companion.id, folder), [companion.id, folder], (e) => e.type === 'companion-files' && e.companionId === companion.id)
  const visible = sortFiles(filterFiles(files.data ?? [], query), sort)
  const phase = useSkeletonPhase(files.status === 'loading' && !files.data)
  // Files can change in Finder too, so the list is read again when Apex comes back to the front.
  useEffect(() => {
    const onFocus = (): void => files.reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [companion.id, folder])

  const fail = (err: unknown): void => void toast.show({ message: errorText(err), tone: 'error' })
  const open = (entry: CompanionFileEntry): void => {
    if (entry.kind === 'folder') {
      setFolder(entry.path)
      setQuery('')
    } else call('companionFiles', 'open', companion.id, entry.path).catch(fail)
  }
  const remove = async (entry: CompanionFileEntry): Promise<void> => {
    const ok = await confirm({
      title: t('coCard.files.delete', { name: entry.name }),
      // OV-32: deletes go to Recently deleted, restorable for 30 days.
      message: entry.kind === 'folder' ? t('workspace.companionFiles.deleteFolderText') : t('workspace.companionFiles.deleteText'),
      destructive: true,
    })
    if (ok)
      call('companionFiles', 'remove', companion.id, entry.path)
        .then(() => toast.show({ message: t('workspace.companionFiles.deleted', { name: entry.name }), tone: 'success', action: { label: t('workspace.section.trash'), onAction: () => goWorkspace('trash') } }))
        .catch(fail)
  }
  const rowMenu = async (entry: CompanionFileEntry, anchor: Element): Promise<void> => {
    const choice = await showMenu(
      [
        { id: 'open', label: entry.kind === 'folder' ? t('coCard.files.openFolder') : t('coCard.files.open') },
        { id: 'reveal', label: t('coCard.files.showInFinder') },
        ...(entry.kind === 'file' ? [{ id: 'versions', label: t('workspace.files.versions') }] : []), // OV-33
        menuSeparator(),
        { id: 'delete', label: t('coCard.files.delete2'), danger: true },
      ],
      anchor,
    )
    if (choice === 'open') open(entry)
    else if (choice === 'reveal') call('companionFiles', 'reveal', companion.id, entry.path).catch(fail)
    else if (choice === 'versions') setHistory(entry.path)
    else if (choice === 'delete') await remove(entry)
  }

  const addFiles = async (list: File[]): Promise<void> => {
    for (const file of list) {
      if (file.size > MAX_BYTES) {
        toast.show({ message: t('coCard.files.isLargerThan25', { name: file.name }), tone: 'error' })
        continue
      }
      setAdding((n) => n + 1)
      try {
        await call('companionFiles', 'add', companion.id, folder, file.name, toBase64(await file.arrayBuffer()))
      } catch (err) {
        fail(err)
      } finally {
        setAdding((n) => n - 1)
      }
    }
  }
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
    const items = Array.from(e.dataTransfer.items)
    // Folders arrive as entries that are directories; they can't be added.
    const folders = items.filter((item) => item.webkitGetAsEntry?.()?.isDirectory).length
    if (folders > 0) toast.show({ message: folders === 1 ? t('coCard.files.foldersCanTBe') : t('coCard.files.foldersCanTBe2'), tone: 'info' })
    const list = Array.from(e.dataTransfer.files).filter((_, i) => !items[i]?.webkitGetAsEntry?.()?.isDirectory)
    void addFiles(list)
  }
  const crumbs = breadcrumbs(folder)

  return (
    <div
      className={`co-tab co-files${dragging ? ' co-files--dragging' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={onDrop}
    >
      <ListTabHeader
        title={
          <button type="button" className="co-listhead__crumb" onClick={() => setFolder('')} aria-label={t('coCard.files.sFilesTopFolder', { name: companion.name })}>
            {t('coCard.files.files')}
          </button>
        }
        help={
          <>
            {t('coCard.files.ownFilesHelp', { name: companion.name })}{' '}
            <button type="button" className="co-link" onClick={() => call('companionFiles', 'reveal', companion.id, folder).catch(fail)}>
              <FolderOpen aria-hidden /> {t('coCard.files.showInFinder')}
            </button>
          </>
        }
        // DS-115: Library › Files narrowed to this companion; the card closes like every other way out.
        action={{ label: t('coCard.files.openInLibrary'), icon: <ArrowRight aria-hidden />, onClick: () => onOpenPage(libraryFilesUrl(companion.id)) }}
      />
      <ListSearch
        value={query}
        onChange={setQuery}
        placeholder={t('coCard.files.filterFiles')}
        trailing={
          <ListRoundButton
            label={sort === 'name' ? t('coCard.files.sortedByNameSort') : t('coCard.files.sortedByLastChange')}
            icon={sort === 'name' ? <ArrowDownAZ aria-hidden /> : <ClockArrowDown aria-hidden />}
            onClick={() => setSort(sort === 'name' ? 'modified' : 'name')}
          />
        }
      />
      <nav className="co-crumbs" aria-label={t('coCard.files.folder')}>
        {crumbs.map((crumb, i) => (
          <span key={crumb.path} className="co-crumbs__part">
            {i > 0 && <ChevronRight aria-hidden />}
            {i === crumbs.length - 1 ? <span aria-current="page">{crumb.label || t('coCard.files.files')}</span> : <button type="button" onClick={() => setFolder(crumb.path)}>{crumb.label || t('coCard.files.files')}</button>}
          </span>
        ))}
        {adding > 0 && <span className="co-hint">{t('coCard.files.adding')}</span>}
      </nav>
      {/* Folders shared with this companion, opened in the Workspace */}
      {sharedFolders.length > 0 && !folder && (
        <p className="co-hint">
          {t('workspace.companionFiles.shared')}{' '}
          {sharedFolders.map((f, i) => (
            <span key={f.id}>
              {i > 0 && ', '}
              <button type="button" className="co-link" onClick={() => goWorkspace('files', f.id)}>
                {f.name}
              </button>
            </span>
          ))}
        </p>
      )}
      {phase === 'skeleton' && <ListSkeleton label={t('coCard.list.loading.files')} />}
      {files.status === 'error' && <ErrorState compact message={files.error ?? undefined} onRetry={files.reload} />}
      {files.data && phase === 'done' && visible.length === 0 && (
        <ListEmpty>{query ? t('coCard.files.empty.match') : folder ? t('coCard.files.empty.folder') : t('coCard.files.empty.own', { companion: companion.name })}</ListEmpty>
      )}
      {phase === 'done' && visible.length > 0 && (
        <ul className="co-list">
          {visible.map((entry) => (
            <li key={entry.path} className={`co-item co-filerow${focusPath === entry.path ? ' co-item--linked' : ''}`}>
              <button type="button" className="co-filerow__open" onClick={() => open(entry)}>
                {entry.kind === 'folder' ? <Folder aria-hidden /> : <File aria-hidden />}
                <span className="co-filerow__name">
                  {entry.name}
                  {entry.kind === 'file' && !entry.readable && <Badge tone="neutral">{t('coCard.files.viewOnly')}</Badge>}
                </span>
                <span className="co-filerow__muted">{fileTypeLabel(entry)}</span>
                <span className="co-filerow__muted">
                  <RelativeTime value={entry.modifiedAt} />
                </span>
                <span className="co-filerow__muted co-filerow__size">{entry.kind === 'file' ? formatBytes(entry.size) : ''}</span>
              </button>
              <IconButton label={t('coCard.files.moreFor', { name: entry.name })} icon={<MoreHorizontal />} size="sm" className="co-filerow__more" aria-haspopup="menu" onClick={(e) => void rowMenu(entry, e.currentTarget)} />
            </li>
          ))}
        </ul>
      )}
      {/* OV-33: a companion file's version history, beside the card */}
      <Modal open={history !== null} onClose={() => setHistory(null)} label={t('workspace.versions.title')} placement="right">
        {history !== null && <VersionHistoryPanel fileRef={{ kind: 'companion', companionId: companion.id, path: history }} onRestore={() => files.reload()} onClose={() => setHistory(null)} />}
      </Modal>
    </div>
  )
}
