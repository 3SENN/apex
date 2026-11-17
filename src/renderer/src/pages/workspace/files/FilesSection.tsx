/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Files, atelier://workspace/files[/<folder id>]: the folders
// shared with Atelier (read only or read and edit, all chats or one chat, an
// optional companion), each browsable with breadcrumbs, a filter and a sort,
// opening files in the file viewer, revealing them, and showing a file's version
// history beside the list. Companions' own files are linked below, then the
// tables (TablesBlock) when the tables flag is on.
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactElement } from 'react'
import { ArrowLeft, File, Folder, FolderOpen, FolderPlus, MoreHorizontal, UserRound } from 'lucide-react'
import { isFlagOn } from '@shared/flags'
import { companionUrl } from '@shared/url'
import type { FolderEntry, WatchedFolder } from '@shared/workspace'
import { call, formatBytes } from '../../../api'
import { useSettingsView } from '../../../companion-card/useLoaded'
import { useT } from '../../../i18n/useT'
import { useCompanions, useResource } from '../../../settings/data'
import { Button, EmptyState, ErrorState, IconButton, RelativeTime, Select, SkeletonRows, VisuallyHidden, confirm, menuSeparator, showMenu, toast } from '../../../ui'
import { changeFolderAccess, shareFolder } from '../../../workspace/FolderAccessDialog'
import { VersionHistoryPanel } from '../../../workspace/VersionHistoryPanel'
import { useFolders } from '../../../workspace/data'
import { SearchBox, SectionHead } from '../../../workspace/kit'
import { breadcrumbs, parentPath, sortEntries, type EntrySort } from '../../../workspace/logic'
import { fail, goWorkspace, openFileRef } from '../../../workspace/open'
import type { WorkspaceSectionProps } from '../sections'
import { TablesBlock } from '../tables/TablesSection'

export default function FilesSection({ itemId = null }: WorkspaceSectionProps): ReactElement {
  const folders = useFolders()
  const folder = itemId ? (folders.data?.find((f) => f.id === itemId) ?? null) : null
  if (itemId && folders.data && !folder) return <MissingFolder />
  if (itemId && folder) return <FolderView key={folder.id} folder={folder} folders={folders.data ?? []} />
  if (itemId) return <SkeletonRows rows={6} />
  return <FolderList folders={folders.data} loading={folders.loading} error={folders.error} reload={folders.reload} />
}

function scopeLabel(t: ReturnType<typeof useT>, folder: WatchedFolder, companionName: string | null): string {
  const scope = folder.scope === 'all-chats' ? t('workspace.files.allChats') : t('workspace.files.oneChat')
  return companionName ? `${scope} · ${t('workspace.files.forCompanion', { name: companionName })}` : scope
}

async function stopSharing(t: ReturnType<typeof useT>, folder: WatchedFolder): Promise<boolean> {
  const ok = await confirm({ title: t('workspace.files.stopTitle', { name: folder.name }), message: t('workspace.files.stopText'), confirmLabel: t('workspace.files.stop'), destructive: true })
  if (!ok) return false
  try {
    await call('folders', 'revoke', folder.id)
    toast.show({ message: t('workspace.files.stopped', { name: folder.name }), tone: 'success' })
    return true
  } catch (err) {
    fail(err)
    return false
  }
}

function FolderList({ folders, loading, error, reload }: { folders: WatchedFolder[] | null; loading: boolean; error: string | null; reload(): Promise<void> }): ReactElement {
  const t = useT()
  const companions = useCompanions()
  const tablesOn = isFlagOn(useSettingsView()?.flags ?? {}, 'tables')
  const nameOf = (id: string | null): string | null => (id ? (companions.items?.find((c) => c.id === id)?.name ?? null) : null)

  const share = (): void => {
    shareFolder(null)
      .then((granted) => granted && goWorkspace('files', granted.id))
      .catch(fail)
  }

  const rowMenu = async (folder: WatchedFolder, anchor: Element): Promise<void> => {
    const id = await showMenu(
      [
        { id: 'open', label: t('workspace.files.open') },
        { id: 'reveal', label: t('workspace.files.reveal') },
        menuSeparator(),
        { id: 'access', label: t('workspace.files.changeAccess') },
        { id: 'stop', label: t('workspace.files.stop'), danger: true },
      ],
      anchor,
    )
    if (id === 'open') goWorkspace('files', folder.id)
    else if (id === 'reveal') Promise.resolve(call('folders', 'reveal', folder.id, '')).catch(fail)
    else if (id === 'access') void changeFolderAccess(folder).catch(fail)
    else if (id === 'stop') void stopSharing(t, folder)
  }

  let body: ReactElement
  if (loading && !folders) body = <SkeletonRows rows={4} label={t('workspace.section.files')} />
  else if (error && !folders) body = <ErrorState title={t('workspace.loadError')} message={error} onRetry={reload} />
  else if (!folders || folders.length === 0)
    body = <EmptyState compact icon={<FolderPlus />} title={t('workspace.files.emptyTitle')} description={t('workspace.files.emptyText')} />
  else
    body = (
      <table className="ws-table">
        <thead>
          <tr>
            <th scope="col">{t('workspace.files.colName')}</th>
            <th className="ws-col-kind" scope="col">
              {t('workspace.folder.what')}
            </th>
            <th scope="col">{t('workspace.folder.which')}</th>
            <th className="ws-col-num" scope="col">
              {t('workspace.projects.colFiles')}
            </th>
            <th className="ws-col-more" scope="col">
              <VisuallyHidden>{t('workspace.more')}</VisuallyHidden>
            </th>
          </tr>
        </thead>
        <tbody>
          {folders.map((f) => (
            <tr key={f.id}>
              <td>
                <span className="ws-name">
                  <span className="ws-name__tile">
                    <Folder aria-hidden />
                  </span>
                  <button type="button" className="ws-link" title={f.path} onClick={() => goWorkspace('files', f.id)}>
                    {f.name}
                  </button>
                </span>
              </td>
              <td>
                <span className="ws-pill">{f.mode === 'read' ? t('workspace.files.read') : t('workspace.files.readWrite')}</span>
              </td>
              <td>{scopeLabel(t, f, nameOf(f.companionId))}</td>
              <td>{f.fileCount === null ? <span className="ws-muted">{t('workspace.files.counting')}</span> : t('workspace.files.count', { count: f.fileCount })}</td>
              <td className="ws-col-more">
                <IconButton size="sm" label={t('workspace.more')} icon={<MoreHorizontal />} aria-haspopup="menu" onClick={(e) => void rowMenu(f, e.currentTarget)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )

  const people = companions.items ?? []
  return (
    <>
      <SectionHead title={t('workspace.section.files')} subtitle={t('workspace.files.subtitle')} />
      <div className="ws-card__body">
        <section className="ws-block" aria-labelledby="ws-shared-folders">
          <div className="ws-block__head">
            <h3 id="ws-shared-folders" className="ws-block__title">
              {t('workspace.files.shared')}
            </h3>
            <Button size="sm" icon={<FolderPlus />} onClick={share}>
              {t('workspace.files.add')}
            </Button>
          </div>
          <p className="ws-block__hint">{t('workspace.files.sharedHint')}</p>
          {body}
        </section>
        {people.length > 0 && (
          <section className="ws-block" aria-labelledby="ws-companion-files">
            <div className="ws-block__head">
              <h3 id="ws-companion-files" className="ws-block__title">
                {t('workspace.files.companions')}
              </h3>
            </div>
            <p className="ws-block__hint">{t('workspace.files.companionHint')}</p>
            <div className="ws-home__grid">
              {people.map((c) => (
                <button key={c.id} type="button" className="ws-tile" onClick={() => Promise.resolve(call('pages', 'open', companionUrl(c.id, 'files'))).catch(fail)}>
                  <span className="ws-tile__title">
                    <UserRound aria-hidden />
                    {c.name}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        {tablesOn && <TablesBlock />}
      </div>
    </>
  )
}

function MissingFolder(): ReactElement {
  const t = useT()
  return (
    <>
      <SectionHead title={t('workspace.section.files')} />
      <div className="ws-card__body">
        <EmptyState
          icon={<Folder />}
          title={t('workspace.files.missingTitle')}
          action={
            <Button icon={<ArrowLeft />} onClick={() => goWorkspace('files')}>
              {t('workspace.files.root')}
            </Button>
          }
        />
      </div>
    </>
  )
}

const SORTS: readonly EntrySort[] = ['name', 'modified', 'size']

function FolderView({ folder, folders }: { folder: WatchedFolder; folders: WatchedFolder[] }): ReactElement {
  const t = useT()
  const [sub, setSub] = useState('')
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<EntrySort>('name')
  const [history, setHistory] = useState<string | null>(null)
  const entries = useResource(() => call('folders', 'entries', folder.id, sub), `${folder.id}:${sub}`)
  const shown = useMemo(() => sortEntries(entries.data ?? [], sort, filter), [entries.data, sort, filter])
  const crumbs = breadcrumbs(sub)

  // Files change in Finder too: read again when Atelier comes back to the front.
  useEffect(() => {
    const onFocus = (): void => void entries.reload()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [folder.id, sub])

  const go = (path: string): void => {
    setSub(path)
    setFilter('')
    setHistory(null)
  }
  const openEntry = (entry: FolderEntry): void => {
    if (entry.kind === 'folder') go(entry.path)
    else if (entry.readable) openFileRef({ kind: 'folder', folderId: folder.id, path: entry.path }, folders, entry.name)
    else Promise.resolve(call('folders', 'open', folder.id, entry.path)).catch(fail)
  }
  const rowMenu = async (entry: FolderEntry, anchor: Element): Promise<void> => {
    const file = entry.kind === 'file'
    const id = await showMenu(
      [
        { id: 'open', label: t('workspace.files.open') },
        ...(file ? [{ id: 'app', label: t('workspace.files.openApp') }] : []),
        { id: 'reveal', label: t('workspace.files.reveal') },
        ...(file && entry.readable ? [menuSeparator(), { id: 'versions', label: t('workspace.files.versions') }] : []),
      ],
      anchor,
    )
    if (id === 'open') openEntry(entry)
    else if (id === 'app') Promise.resolve(call('folders', 'open', folder.id, entry.path)).catch(fail)
    else if (id === 'reveal') Promise.resolve(call('folders', 'reveal', folder.id, entry.path)).catch(fail)
    else if (id === 'versions') setHistory(entry.path)
  }
  const folderMenu = async (anchor: Element): Promise<void> => {
    const id = await showMenu(
      [{ id: 'reveal', label: t('workspace.files.reveal') }, { id: 'access', label: t('workspace.files.changeAccess') }, menuSeparator(), { id: 'stop', label: t('workspace.files.stop'), danger: true }],
      anchor,
    )
    if (id === 'reveal') Promise.resolve(call('folders', 'reveal', folder.id, sub)).catch(fail)
    else if (id === 'access') void changeFolderAccess(folder).catch(fail)
    else if (id === 'stop' && (await stopSharing(t, folder))) goWorkspace('files')
  }
  const onTableKey = (e: KeyboardEvent<HTMLTableSectionElement>): void => {
    if (e.key === 'Backspace' && sub && !(e.target instanceof HTMLInputElement)) {
      go(parentPath(sub))
      e.preventDefault()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = [...e.currentTarget.querySelectorAll<HTMLTableRowElement>('tr[tabindex]')]
    const at = rows.indexOf(document.activeElement as HTMLTableRowElement)
    rows[Math.max(0, Math.min(rows.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    e.preventDefault()
  }

  let body: ReactElement
  if (entries.loading && !entries.data) body = <SkeletonRows rows={6} label={folder.name} />
  else if (entries.error && !entries.data) body = <ErrorState title={t('workspace.files.missing')} message={entries.error} onRetry={() => entries.reload()} />
  else if (shown.length === 0) body = <EmptyState compact icon={<FolderOpen />} title={filter ? t('workspace.files.noMatch', { query: filter }) : t('workspace.files.emptyFolder')} />
  else
    body = (
      <table className="ws-table">
        <thead>
          <tr>
            <th scope="col">{t('workspace.files.colName')}</th>
            <th className="ws-col-time" scope="col">
              {t('workspace.files.colModified')}
            </th>
            <th className="ws-col-num" scope="col">
              {t('workspace.files.colSize')}
            </th>
            <th className="ws-col-more" scope="col">
              <VisuallyHidden>{t('workspace.more')}</VisuallyHidden>
            </th>
          </tr>
        </thead>
        <tbody onKeyDown={onTableKey}>
          {shown.map((entry) => (
            <tr
              key={entry.path}
              tabIndex={0}
              aria-selected={history === entry.path}
              onDoubleClick={() => openEntry(entry)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.target === e.currentTarget) openEntry(entry)
              }}
            >
              <td>
                <span className="ws-name">
                  <span className="ws-name__tile">{entry.kind === 'folder' ? <Folder aria-hidden /> : <File aria-hidden />}</span>
                  <button type="button" className="ws-link" tabIndex={-1} onClick={() => openEntry(entry)} title={entry.readable || entry.kind === 'folder' ? entry.name : t('workspace.files.notReadable')}>
                    {entry.name}
                  </button>
                </span>
              </td>
              <td>
                <RelativeTime value={entry.modifiedAt} />
              </td>
              <td>{entry.kind === 'folder' ? '—' : formatBytes(entry.size)}</td>
              <td className="ws-col-more">
                <IconButton size="sm" tabIndex={-1} label={t('workspace.more')} icon={<MoreHorizontal />} aria-haspopup="menu" onClick={(e) => void rowMenu(entry, e.currentTarget)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )

  return (
    <>
      <SectionHead
        title={folder.name}
        subtitle={`${folder.mode === 'read' ? t('workspace.files.read') : t('workspace.files.readWrite')} · ${folder.scope === 'all-chats' ? t('workspace.files.allChats') : t('workspace.files.oneChat')}`}
        lead={<IconButton label={t('workspace.files.root')} icon={<ArrowLeft />} onClick={() => goWorkspace('files')} />}
        actions={<IconButton label={t('workspace.more')} icon={<MoreHorizontal />} aria-haspopup="menu" onClick={(e) => void folderMenu(e.currentTarget)} />}
      />
      <div className="ws-files">
        <div className="ws-card__body">
          <nav aria-label={t('workspace.files.path')}>
            <ol className="ws-crumbs">
              <li>
                <button type="button" onClick={() => goWorkspace('files')}>
                  {t('workspace.files.root')}
                </button>
              </li>
              {crumbs.map((c, i) => (
                <li key={c.path || '/'}>
                  {i === crumbs.length - 1 ? (
                    <span aria-current="page">{c.name || folder.name}</span>
                  ) : (
                    <button type="button" onClick={() => go(c.path)}>
                      {c.name || folder.name}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <div className="ws-toolbar">
            <SearchBox className="ws-toolbar__grow" value={filter} onChange={setFilter} placeholder={t('workspace.files.filter')} />
            <Select<EntrySort>
              value={sort}
              onChange={setSort}
              aria-label={t('workspace.files.sort')}
              options={SORTS.map((s) => ({ value: s, label: t(s === 'name' ? 'workspace.files.sortName' : s === 'modified' ? 'workspace.files.sortModified' : 'workspace.files.sortSize') }))}
            />
          </div>
          {body}
        </div>
        {history && <VersionHistoryPanel fileRef={{ kind: 'folder', folderId: folder.id, path: history }} onRestore={() => void entries.reload()} onClose={() => setHistory(null)} />}
      </div>
    </>
  )
}
