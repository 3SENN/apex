/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// apex://bookmarks (SH-47): the bookmark manager. The bar and other
// roots and their folders, with breadcrumbs; search across everything;
// rename in place; new folders; delete with Undo (a folder with links asks
// first); drag to reorder or onto a folder; and Netscape HTML import and
// export (main's bookmarksHtml.ts) so other browsers' bookmarks come along.
import { useMemo, useState, type DragEvent, type MouseEvent, type ReactElement } from 'react'
import { Bookmark as BookmarkIcon, ChevronRight, Download, ExternalLink, FolderClosed, FolderPlus, Pencil, Trash2, Upload } from 'lucide-react'
import { flattenLinks, linksIn, locate, dropPlace, dropTarget, type BookmarkFolder, type BookmarkItem, type BookmarkTree, type DropPlace } from '@shared/bookmarks'
import { matchRanges } from '@shared/omnibox'
import { apex, call, errorText } from '../api'
import { useT, type T } from '../i18n/useT'
import { Button, EmptyState, IconButton, InlineRename, cx, showContextMenu, useConfirm, useToast } from '../ui'
import { useBookmarkTree, openAllIn } from '../components/bars/BookmarksBar'
import { DestinationFrame, ListState } from '../settings/destinations/common'
import { ListFrame, PageHeader, SearchField } from '../settings/kit'
import { siteInitial } from '../settings/logic/collections'
import { openFrom } from './HistoryPage'

const DRAG_TYPE = 'application/x-apex-bookmark'

/** The folders from a root down to `id`, for the breadcrumbs. */
export function folderPath(tree: BookmarkTree, id: string): BookmarkFolder[] {
  const walk = (folder: BookmarkFolder, trail: BookmarkFolder[]): BookmarkFolder[] | null => {
    const here = [...trail, folder]
    if (folder.id === id) return here
    for (const child of folder.children) {
      if (child.kind !== 'folder') continue
      const found = walk(child, here)
      if (found) return found
    }
    return null
  }
  return walk(tree.bar, []) ?? walk(tree.other, []) ?? [tree.bar]
}

/** Every link whose title or address matches, for the page's search. */
export function searchLinks(tree: BookmarkTree, query: string): BookmarkItem[] {
  const q = query.trim()
  if (!q) return []
  return flattenLinks(tree).filter((b) => matchRanges(b.title, q).length > 0 || b.url.toLowerCase().includes(q.toLowerCase()))
}

function rootTitle(folder: BookmarkFolder, t: T): string {
  if (folder.id === 'bar') return t('address.bookmarks.bar')
  if (folder.id === 'other') return t('address.bookmarks.other')
  return folder.title
}

export function BookmarksPage({ tabId }: { tabId: string }): ReactElement {
  const t = useT()
  const tree = useBookmarkTree()
  const toast = useToast()
  const confirm = useConfirm()
  const [folderId, setFolderId] = useState('bar')
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; place: DropPlace } | null>(null)

  const found = tree ? locate(tree, folderId) : null
  const folder: BookmarkFolder | null = tree ? (found?.item.kind === 'folder' ? found.item : tree.bar) : null
  const path = tree && folder ? folderPath(tree, folder.id) : []
  const searching = query.trim() !== ''
  const items = useMemo(() => (tree ? (searching ? searchLinks(tree, query) : (folder?.children ?? [])) : null), [tree, searching, query, folder])
  const total = tree ? flattenLinks(tree).length : 0

  const fail = (err: unknown): void => {
    toast.show({ tone: 'error', message: errorText(err) })
  }

  const remove = async (item: BookmarkItem): Promise<void> => {
    if (item.kind === 'folder') {
      const count = linksIn(item).length
      if (count > 0 && !(await confirm({ title: t('address.page.deleteFolder', { title: item.title, count }), destructive: true }))) return
    }
    try {
      const removal = await call('bookmarks', 'removeItem', item.id)
      toast.show({ message: t('address.editor.removed'), undo: () => void call('bookmarks', 'restore', removal).catch(fail) })
    } catch (err) {
      fail(err)
    }
  }

  const newFolder = async (): Promise<void> => {
    if (!folder) return
    try {
      const created = await call('bookmarks', 'createFolder', folder.id, t('address.bookmarks.newFolderName'))
      setQuery('')
      setRenaming(created.id)
    } catch (err) {
      fail(err)
    }
  }

  const importHtml = async (): Promise<void> => {
    try {
      const result = await call('bookmarks', 'importHtml')
      if (!result) return
      toast.show({ tone: 'success', message: result.skipped ? t('address.page.importedSkipped', result) : t('address.page.imported', result) })
    } catch (err) {
      fail(err)
    }
  }
  const exportHtml = async (): Promise<void> => {
    try {
      const path = await call('bookmarks', 'exportHtml')
      if (path) toast.show({ tone: 'success', message: t('address.page.exported', { path }) })
    } catch (err) {
      fail(err)
    }
  }

  // ---- drag to reorder or into folders ----
  const onDragOver = (e: DragEvent, item: BookmarkItem): void => {
    if (!drag || drag === item.id) return
    e.preventDefault()
    const box = e.currentTarget.getBoundingClientRect()
    const place = searching ? (item.kind === 'folder' ? 'inside' : null) : dropPlace(e.clientY - box.top, box.height, item.kind === 'folder')
    if (!place) return
    if (drop?.id !== item.id || drop.place !== place) setDrop({ id: item.id, place })
  }
  const onDrop = (e: DragEvent, overId: string): void => {
    const id = drag
    const place = drop?.id === overId ? drop.place : 'inside'
    setDrop(null)
    setDrag(null)
    if (!id || !tree) return
    e.preventDefault()
    const target = dropTarget(tree, overId, place)
    if (target) void call('bookmarks', 'move', id, target.parentId, target.index).catch(fail)
  }

  const menu = (e: MouseEvent, item: BookmarkItem): void => {
    const link = item.kind === 'bookmark'
    void showContextMenu(e, [
      ...(link
        ? [
            { id: 'open', label: t('address.bookmarks.open') },
            { id: 'new-tab', label: t('address.bookmarks.openNewTab') },
            { id: 'window', label: t('address.bookmarks.openNewWindow') },
            { id: 'private', label: t('address.bookmarks.openPrivate') },
          ]
        : [
            { id: 'open-folder', label: t('address.bookmarks.open') },
            { id: 'open-all', label: t('address.bookmarks.openAll', { count: linksIn(item).length }), enabled: linksIn(item).length > 0 },
            { id: 'open-all-group', label: t('address.bookmarks.openAllGroup'), enabled: linksIn(item).length > 0 },
          ]),
      { id: 'sep', label: '', type: 'separator' as const },
      { id: 'rename', label: t('address.bookmarks.rename') },
      { id: 'delete', label: t('address.bookmarks.delete'), danger: true },
    ]).then((id) => {
      if (id === 'open' && link) void apex.nav.go(tabId, item.url)
      else if (id === 'new-tab' && link) void apex.tabs.create(item.url, { afterId: tabId })
      else if ((id === 'window' || id === 'private') && link) void call('windows', 'open', id === 'private' ? 'private' : 'normal', { url: item.url }).catch(fail)
      else if (id === 'open-folder') {
        setQuery('')
        setFolderId(item.id)
      } else if ((id === 'open-all' || id === 'open-all-group') && item.kind === 'folder') void openAllIn(item, id === 'open-all-group')
      else if (id === 'rename') setRenaming(item.id)
      else if (id === 'delete') void remove(item)
    })
  }

  return (
    <DestinationFrame label={t('address.page.bookmarks')}>
      <PageHeader
        title={t('address.page.bookmarks')}
        description={t('address.page.bookmarksDescription')}
        actions={
          <>
            <Button variant="secondary" icon={<Upload size={14} />} onClick={() => void importHtml()}>
              {t('address.page.import')}
            </Button>
            <Button variant="secondary" icon={<Download size={14} />} disabled={total === 0} onClick={() => void exportHtml()}>
              {t('address.page.export')}
            </Button>
          </>
        }
      />
      <div className="sp-toolbar">
        <SearchField value={query} onChange={setQuery} placeholder={t('address.page.bookmarksSearch')} />
        {total > 0 && <span className="sp-toolbar__count">{t('address.page.items', { count: total })}</span>}
        {!searching && (
          <Button variant="ghost" size="sm" icon={<FolderPlus size={14} />} onClick={() => void newFolder()}>
            {t('address.bookmarks.newFolder')}
          </Button>
        )}
      </div>
      {!searching && tree && (
        <nav className="bm-crumbs" aria-label={t('address.editor.folder')}>
          {[tree.bar, tree.other].map((root) => (
            <button key={root.id} type="button" className={cx('bm-root', path[0]?.id === root.id && 'bm-root--on')} aria-current={folder?.id === root.id ? 'page' : undefined} onClick={() => setFolderId(root.id)} onDragOver={(e) => drag && e.preventDefault()} onDrop={(e) => onDrop(e, root.id)}>
              {rootTitle(root, t)}
            </button>
          ))}
          {path.slice(1).map((f) => (
            <span key={f.id} className="bm-crumb">
              <ChevronRight size={13} aria-hidden />
              <button type="button" aria-current={folder?.id === f.id ? 'page' : undefined} onClick={() => setFolderId(f.id)} onDragOver={(e) => drag && e.preventDefault()} onDrop={(e) => onDrop(e, f.id)}>
                {f.title}
              </button>
            </span>
          ))}
        </nav>
      )}
      <ListState
        items={items === null ? null : searching ? [query] : total > 0 || (folder?.children.length ?? 0) > 0 ? [folderId] : []}
        shown={items?.length ?? 0}
        error={null}
        onRetry={async () => undefined}
        loadingLabel={t('address.page.loading')}
        avatar
        onClearFilters={searching ? () => setQuery('') : undefined}
        empty={<EmptyState icon={<BookmarkIcon />} title={t('address.page.noBookmarks')} description={t('address.page.noBookmarksBody')} />}
      >
        {items && items.length === 0 && !searching && <p className="sp-section__note">{t('address.page.folderEmpty')}</p>}
        <ListFrame label={folder ? rootTitle(folder, t) : undefined}>
          {(items ?? []).map((item) => {
            const isFolder = item.kind === 'folder'
            const title = item.title || (item.kind === 'bookmark' ? item.url : '')
            return (
              <div
                key={item.id}
                className={cx('sp-item', drop?.id === item.id && `bm-drop--${drop.place}`, drag === item.id && 'bm-dragging')}
                draggable={renaming !== item.id}
                onDragStart={(e) => {
                  setDrag(item.id)
                  e.dataTransfer.setData(DRAG_TYPE, item.id)
                  if (item.kind === 'bookmark') e.dataTransfer.setData('text/uri-list', item.url)
                  e.dataTransfer.effectAllowed = 'copyMove'
                }}
                onDragOver={(e) => onDragOver(e, item)}
                onDragLeave={() => drop?.id === item.id && setDrop(null)}
                onDrop={(e) => onDrop(e, item.id)}
                onDragEnd={() => {
                  setDrag(null)
                  setDrop(null)
                }}
                onContextMenu={(e) => menu(e, item)}
              >
                {isFolder ? (
                  <span className="sp-favicon" aria-hidden>
                    <FolderClosed size={15} />
                  </span>
                ) : item.favicon ? (
                  <img className="sp-favicon" src={item.favicon} alt="" width={16} height={16} draggable={false} />
                ) : (
                  <span className="sp-favicon" aria-hidden>
                    {siteInitial(item.url, item.title)}
                  </span>
                )}
                {renaming === item.id ? (
                  <div className="sp-item__main">
                    <InlineRename
                      value={item.title}
                      label={t('address.bookmarks.renameLabel')}
                      editing
                      activation="none"
                      maxLength={1024}
                      onEditingChange={(editing) => !editing && setRenaming(null)}
                      onCommit={(next) => call('bookmarks', 'update', item.id, { title: next })}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="sp-item__main"
                    onClick={(e) => {
                      if (item.kind === 'folder') {
                        setQuery('')
                        setFolderId(item.id)
                      } else openFrom(e, tabId, item.url)
                    }}
                    onAuxClick={(e) => e.button === 1 && item.kind === 'bookmark' && openFrom(e, tabId, item.url)}
                  >
                    <span className="sp-item__title">
                      <span className="sp-item__title-text">{title}</span>
                    </span>
                    <span className="sp-item__sub">{item.kind === 'folder' ? t('address.page.items', { count: linksIn(item).length }) : item.url}</span>
                  </button>
                )}
                <div className="sp-item__actions sp-item__actions--reveal">
                  {item.kind === 'bookmark' && <IconButton size="sm" label={t('address.bookmarks.openNewTab')} icon={<ExternalLink />} onClick={() => void apex.tabs.create(item.url, { afterId: tabId })} />}
                  <IconButton size="sm" label={t('address.bookmarks.rename')} icon={<Pencil />} onClick={() => setRenaming(item.id)} />
                  <IconButton size="sm" tone="danger" label={t('address.bookmarks.delete')} icon={<Trash2 />} onClick={() => void remove(item)} />
                </div>
              </div>
            )
          })}
        </ListFrame>
      </ListState>
    </DestinationFrame>
  )
}
