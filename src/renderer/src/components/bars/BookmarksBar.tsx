/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactElement } from 'react'
import type { MenuItemSpec } from '@shared/menu'
import type { BookmarkFolderResult } from '@shared/overlay/address'
import type { Bookmark } from '@shared/services'
import { dropPlace, dropTarget, linksIn, locate, type BookmarkFolder, type BookmarkItem, type BookmarkTree, type DropPlace } from '@shared/bookmarks'
import { ChevronsRight, FolderClosed, Globe } from 'lucide-react'
import { atelier, call, errorText, useAppEvent } from '../../api'
import { useT } from '../../i18n/useT'
import { pressAnchor } from '../../overlay/kit'
import { anchorFromElement, openSurface } from '../../overlay/useSurface'
import { InlineRename, confirm, cx, showContextMenu, toast } from '../../ui'
import { bookmarkCurrentPage } from '../AddressPill'
import { barLayout, dispositionFor, type Disposition } from '../address'
import { copyText } from '../sidebar/util'

// The bookmarks bar (SH-47, DS-25): 37 px under the toolbar, items with the
// page's favicon or an outline folder, titles in the strong tone that fade
// at the end. A click opens here; ⌘-click and a middle click open in the
// background, ⇧⌘-click in front. Folders open cascading panels
// (bookmark-folder). Items rename inline, drag to reorder with an
// insertion line, and drop into a folder over its middle third. The bar
// follows its width: the longest titles shrink to a shared cap before any
// item goes behind the overflow button (barLayout), short ones stay whole,
// and only a title that is actually cut fades out.

const DRAG_TYPE = 'application/x-atelier-bookmark'

function BookmarkIcon({ src }: { src: string | null | undefined }): ReactElement {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <Globe size={16} strokeWidth={1.75} aria-hidden />
  return <img src={src} alt="" width={16} height={16} draggable={false} onError={() => setFailed(true)} />
}

/** The tree, kept live from main's bookmark-tree events. */
export function useBookmarkTree(): BookmarkTree | null {
  const [tree, setTree] = useState<BookmarkTree | null>(null)
  useEffect(() => {
    void call('bookmarks', 'tree').then(setTree, () => undefined)
  }, [])
  useAppEvent('bookmark-tree', (e) => setTree(e.tree))
  return tree
}

export function openBookmark(url: string, disposition: Disposition, activeTabId: string | null): void {
  if (disposition === 'here' && activeTabId) void atelier.nav.go(activeTabId, url)
  else void atelier.tabs.create(url, { afterId: activeTabId ?? undefined, background: disposition !== 'foreground' })
}

/** "Open all": the folder's links as tabs after the active one, optionally as a new group. */
export async function openAllIn(folder: BookmarkFolder, group: boolean): Promise<void> {
  try {
    const ids = await call('bookmarks', 'openAll', folder.id, { background: true })
    if (group && ids.length > 0) await call('tabGroups', 'create', ids, folder.title)
  } catch (err) {
    toast.show({ message: errorText(err), tone: 'error' })
  }
}

export function BookmarksBar({ activeTabId }: { bookmarks?: Bookmark[]; activeTabId: string | null }): ReactElement | null {
  const t = useT()
  const tree = useBookmarkTree()
  const bar = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<number | null>(null)
  const [cap, setCap] = useState<number | undefined>(undefined)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [drop, setDrop] = useState<{ id: string; place: DropPlace } | null>(null)
  const dragging = useRef<string | null>(null)
  const openFolder = useRef<string | null>(null)
  const lastClosed = useRef<{ key: string; at: number } | null>(null)
  const items = tree?.bar.children ?? []

  // Marks the titles cut short, so only they fade at the end.
  const markClipped = (): void => {
    for (const title of bar.current?.querySelectorAll<HTMLElement>(':scope > .bookmark-chip .bookmark-chip__title') ?? []) {
      title.parentElement?.toggleAttribute('data-clipped', title.scrollWidth > title.clientWidth + 1)
    }
  }
  // Fit by the hidden measuring row's widths: long titles shrink to a shared
  // cap first, then the rest go behind the overflow button.
  useLayoutEffect(() => {
    const el = bar.current
    const row = measure.current
    if (!el || !row) return
    const update = (): void => {
      const widths = [...row.children].map((c) => (c as HTMLElement).offsetWidth)
      const style = getComputedStyle(el)
      const available = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const layout = barLayout(widths, available)
      setFit(layout.count)
      setCap(layout.cap)
      markClipped()
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [items])
  useLayoutEffect(markClipped)

  const tabMenu = useCallback(
    async (anchor: HTMLElement, folderId: string, ids?: string[]): Promise<void> => {
      const key = ids ? 'overflow' : folderId
      // A second click on the open folder closes it: the press outside the card already did.
      const last = lastClosed.current
      if (openFolder.current === key || (last && last.key === key && Date.now() - last.at < 400)) return
      openFolder.current = key
      const unpress = pressAnchor(anchor)
      try {
        const result = await openSurface(ids ? 'bookmarks-overflow' : 'bookmark-folder', anchorFromElement(anchor), ids ? { folderId, ids } : { folderId })
        if (!('value' in result) || !tree) return
        const value = result.value as BookmarkFolderResult
        if (value.kind === 'open') openBookmark(value.url, value.disposition, activeTabId)
        else {
          const found = locate(tree, value.folderId)
          if (found?.item.kind === 'folder') void openAllIn(found.item, value.group)
        }
      } catch (err) {
        toast.show({ message: errorText(err), tone: 'error' })
      } finally {
        unpress()
        if (openFolder.current === key) openFolder.current = null
        lastClosed.current = { key, at: Date.now() }
      }
    },
    [tree, activeTabId],
  )

  const remove = async (item: BookmarkItem): Promise<void> => {
    const folder = item.kind === 'folder'
    if (folder && linksIn(item).length > 0) {
      const ok = await confirm({ title: t('address.bookmarks.delete'), message: item.title, destructive: true })
      if (!ok) return
    }
    try {
      const removal = await call('bookmarks', 'removeItem', item.id)
      toast.show({ message: t('address.editor.removed'), action: { label: t('address.editor.undo'), onAction: () => void call('bookmarks', 'restore', removal) } })
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }

  const contextMenu = async (e: MouseEvent, item: BookmarkItem | null): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const settings = atelier.initial.settings
    const mode = settings.bookmarksBar
    const spec: MenuItemSpec[] = []
    if (item?.kind === 'bookmark') {
      spec.push(
        { id: 'open-new-tab', label: t('address.bookmarks.openNewTab') },
        { id: 'open-window', label: t('address.bookmarks.openNewWindow') },
        { id: 'open-private', label: t('address.bookmarks.openPrivate') },
        { id: 'sep1', label: '', type: 'separator' },
        { id: 'copy', label: t('address.bookmarks.copyLink') },
      )
    } else if (item?.kind === 'folder') {
      const count = linksIn(item).length
      spec.push(
        { id: 'open-all', label: t('address.bookmarks.openAll', { count }), enabled: count > 0 },
        { id: 'open-all-group', label: t('address.bookmarks.openAllGroup'), enabled: count > 0 },
        { id: 'open-all-window', label: t('address.bookmarks.openAllWindow'), enabled: count > 0 },
      )
    }
    if (item) {
      spec.push(
        { id: 'sep2', label: '', type: 'separator' },
        { id: 'rename', label: t('address.bookmarks.rename') },
        ...(item.kind === 'bookmark' ? [{ id: 'edit', label: t('address.bookmarks.edit') }] : []),
        { id: 'delete', label: t('address.bookmarks.delete'), danger: true },
      )
    }
    spec.push(
      { id: 'sep3', label: '', type: 'separator' },
      { id: 'add-page', label: t('address.bookmarks.addPage') },
      { id: 'add-folder', label: t('address.bookmarks.newFolder') },
      { id: 'manage', label: t('address.bookmarks.manage') },
      {
        id: 'visibility',
        label: t('address.bookmarks.showBar'),
        submenu: [
          { id: 'bar-always', label: t('address.bookmarks.barAlways'), type: 'radio', checked: mode === 'always' },
          { id: 'bar-newtab', label: t('address.bookmarks.barNewTab'), type: 'radio', checked: mode === 'newtab' },
          { id: 'bar-never', label: t('address.bookmarks.barNever'), type: 'radio', checked: mode === 'never' },
        ],
      },
    )
    const chosen = await showContextMenu(e, spec)
    if (!chosen) return
    const index = item ? items.findIndex((i) => i.id === item.id) + 1 : items.length
    try {
      switch (chosen) {
        case 'open-new-tab':
          if (item?.kind === 'bookmark') openBookmark(item.url, 'foreground', activeTabId)
          break
        case 'open-window':
        case 'open-private':
          if (item?.kind === 'bookmark') await call('windows', 'open', chosen === 'open-private' ? 'private' : 'normal', { url: item.url })
          break
        case 'copy':
          if (item?.kind === 'bookmark' && (await copyText(item.url))) toast.show({ message: t('address.pill.copied') })
          break
        case 'open-all':
        case 'open-all-group':
          if (item?.kind === 'folder') await openAllIn(item, chosen === 'open-all-group')
          break
        case 'open-all-window':
          if (item?.kind === 'folder') {
            const [first, ...rest] = linksIn(item)
            if (first) {
              await call('windows', 'open', 'normal', { url: first.url })
              for (const link of rest) void atelier.tabs.create(link.url, { background: true })
            }
          }
          break
        case 'rename':
          if (item) setRenaming(item.id)
          break
        case 'edit':
          if (item) {
            const el = bar.current?.querySelector<HTMLElement>(`[data-bookmark="${CSS.escape(item.id)}"]`)
            if (el) await openSurface('bookmark-editor', anchorFromElement(el), { id: item.id, created: false })
          }
          break
        case 'delete':
          if (item) await remove(item)
          break
        case 'add-page':
          // The pill adds the active page and opens its editor, as ⌘D does.
          bookmarkCurrentPage()
          break
        case 'add-folder': {
          const folder = await call('bookmarks', 'createFolder', 'bar', t('address.bookmarks.newFolderName'), index)
          setRenaming(folder.id)
          break
        }
        case 'manage':
          void call('pages', 'open', 'atelier://bookmarks')
          break
        case 'bar-always':
        case 'bar-newtab':
        case 'bar-never':
          void atelier.settings.set({ bookmarksBar: chosen === 'bar-always' ? 'always' : chosen === 'bar-newtab' ? 'newtab' : 'never' })
          break
      }
    } catch (err) {
      toast.show({ message: errorText(err), tone: 'error' })
    }
  }

  // ---- drag to reorder ----
  const onDragStart = (e: DragEvent, item: BookmarkItem): void => {
    dragging.current = item.id
    e.dataTransfer.setData(DRAG_TYPE, item.id)
    if (item.kind === 'bookmark') {
      e.dataTransfer.setData('text/uri-list', item.url)
      e.dataTransfer.setData('text/plain', item.url)
    }
    e.dataTransfer.effectAllowed = 'copyMove'
  }
  const onDragOver = (e: DragEvent, item: BookmarkItem): void => {
    if (!dragging.current || dragging.current === item.id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const box = e.currentTarget.getBoundingClientRect()
    const place = dropPlace(e.clientX - box.left, box.width, item.kind === 'folder')
    if (drop?.id !== item.id || drop.place !== place) setDrop({ id: item.id, place })
  }
  const onDrop = (e: DragEvent, item: BookmarkItem): void => {
    const id = dragging.current
    const place = drop?.id === item.id ? drop.place : null
    setDrop(null)
    dragging.current = null
    if (!id || !place || !tree) return
    e.preventDefault()
    const target = dropTarget(tree, item.id, place)
    if (target) void call('bookmarks', 'move', id, target.parentId, target.index).catch((err: unknown) => toast.show({ message: errorText(err), tone: 'error' }))
  }

  if (!tree || items.length === 0) {
    return <div ref={bar} className="bookmarks-bar bookmarks-bar--empty" role="toolbar" aria-label={t('address.bookmarks.bar')} onContextMenu={(e) => void contextMenu(e, null)} />
  }

  const shown = fit === null ? items : items.slice(0, fit)
  const hidden = fit === null ? [] : items.slice(fit)
  const chip = (item: BookmarkItem, measuring: boolean): ReactElement => {
    const folder = item.kind === 'folder'
    const label = item.title || (item.kind === 'bookmark' ? item.url : '')
    const content = (
      <>
        <span className="bookmark-chip__icon">{folder ? <FolderClosed size={16} strokeWidth={1.75} aria-hidden /> : <BookmarkIcon src={item.favicon} />}</span>
        {renaming === item.id && !measuring ? (
          <InlineRename
            value={item.title}
            label={t('address.bookmarks.renameLabel')}
            editing
            maxLength={1024}
            onEditingChange={(on) => !on && setRenaming(null)}
            onCommit={(title) => call('bookmarks', 'update', item.id, { title }).then(() => setRenaming(null))}
          />
        ) : (
          <span className="bookmark-chip__title">{label}</span>
        )}
      </>
    )
    if (measuring) return <span key={item.id} className="bookmark-chip">{content}</span>
    return (
      <button
        key={item.id}
        type="button"
        data-bookmark={item.id}
        className={cx('bookmark-chip', folder && 'bookmark-chip--folder', drop?.id === item.id && `bookmark-chip--drop-${drop.place}`)}
        style={cap === undefined ? undefined : { maxWidth: cap }}
        title={item.kind === 'bookmark' ? `${item.title}\n${item.url}` : item.title}
        aria-haspopup={folder ? 'menu' : undefined}
        draggable={renaming !== item.id}
        onClick={(e) => {
          if (renaming === item.id) return
          if (folder) void tabMenu(e.currentTarget, item.id)
          else openBookmark(item.url, dispositionFor(e), activeTabId)
        }}
        onAuxClick={(e) => {
          if (e.button !== 1 || folder || item.kind !== 'bookmark') return
          e.preventDefault()
          openBookmark(item.url, 'background', activeTabId)
        }}
        onContextMenu={(e) => void contextMenu(e, item)}
        onDragStart={(e) => onDragStart(e, item)}
        onDragOver={(e) => onDragOver(e, item)}
        onDragLeave={() => drop?.id === item.id && setDrop(null)}
        onDrop={(e) => onDrop(e, item)}
        onDragEnd={() => {
          dragging.current = null
          setDrop(null)
        }}
      >
        {content}
      </button>
    )
  }

  return (
    <div ref={bar} className="bookmarks-bar" role="toolbar" aria-label={t('address.bookmarks.bar')} onContextMenu={(e) => void contextMenu(e, null)}>
      <div ref={measure} className="bookmarks-bar__measure" aria-hidden>
        {items.map((item) => chip(item, true))}
      </div>
      {shown.map((item) => chip(item, false))}
      {hidden.length > 0 && (
        <button
          type="button"
          className="bookmark-chip bookmark-chip--overflow"
          aria-label={t('address.bookmarks.overflow')}
          title={t('address.bookmarks.overflow')}
          aria-haspopup="menu"
          onClick={(e) => void tabMenu(e.currentTarget, 'bar', hidden.map((h) => h.id))}
        >
          <ChevronsRight size={16} aria-hidden />
        </button>
      )}
    </div>
  )
}
