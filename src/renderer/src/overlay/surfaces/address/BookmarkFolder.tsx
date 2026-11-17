/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactElement } from 'react'
import type { BookmarkFolderProps, BookmarkFolderResult } from '@shared/overlay/address'
import { dropPlace, dropTarget, linksIn, locate, type BookmarkFolder as Folder, type BookmarkItem, type BookmarkTree, type DropPlace } from '@shared/bookmarks'
import { FolderClosed, Globe, Layers } from 'lucide-react'
import { call } from '../../../api'
import { useT, type T } from '../../../i18n/useT'
import { CascadeMenu, MenuScrim, Popover, inChromeHost, unionBox, type Box, type KitItem } from '../../kit'
import type { SurfaceComponentProps } from '../../types'

// Bookmark folders (SH-48) and the bar's overflow card: cascading panels on
// the kit's CascadeMenu, about 400 px wide and clipped to the window, with
// subfolders opening to the side. A click opens a bookmark here, ⌘-click
// or a middle click in the background. Rows drag to reorder or into
// another folder (the middle third of a folder row), with a visible drop
// line. Outside clicks, a tab switch or deleting the folder close it.

export const FOLDER_WIDTH = 400
const DRAG_TYPE = 'application/x-atelier-bookmark'
const OPEN_ALL = 'open-all'
const OPEN_ALL_GROUP = 'open-all-group'

export function folderItems(children: readonly BookmarkItem[], t: T, folderId: string | null): KitItem[] {
  if (children.length === 0) return [{ id: `empty:${folderId ?? 'overflow'}`, label: t('address.bookmarks.empty'), kind: 'note' }]
  const rows: KitItem[] = children.map((c) =>
    c.kind === 'folder'
      ? { id: c.id, label: c.title, icon: <FolderClosed size={15} aria-hidden />, submenu: folderItems(c.children, t, c.id) }
      : c.favicon
        ? { id: c.id, label: c.title || c.url, image: c.favicon }
        : { id: c.id, label: c.title || c.url, icon: <Globe size={15} aria-hidden /> },
  )
  const count = children.reduce((n, c) => n + (c.kind === 'bookmark' ? 1 : linksIn(c).length), 0)
  if (folderId && count > 0) {
    rows.push(
      { id: `sep:${folderId}`, label: '', kind: 'separator' },
      { id: `${OPEN_ALL}:${folderId}`, label: t('address.bookmarks.openAll', { count }), icon: <Layers size={15} aria-hidden /> },
      { id: `${OPEN_ALL_GROUP}:${folderId}`, label: t('address.bookmarks.openAllGroup') },
    )
  }
  return rows
}

function anchorBox(anchor: SurfaceComponentProps<unknown>['anchor'], rect: SurfaceComponentProps<unknown>['anchorRect']): Box {
  if (rect) return { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
  if (anchor.kind === 'window') return { left: anchor.rect.x, top: anchor.rect.y, width: anchor.rect.width, height: anchor.rect.height }
  if (anchor.kind === 'point') return { left: anchor.x, top: anchor.y, width: 0, height: 0 }
  return { left: 0, top: 0, width: 0, height: 0 }
}

export function BookmarkFolderMenu({ instanceId, props, anchor, anchorRect, resolve, close, reportBounds }: SurfaceComponentProps<BookmarkFolderProps>): ReactElement {
  const t = useT()
  const [tree, setTree] = useState<BookmarkTree | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const dragging = useRef<string | null>(null)
  const marked = useRef<HTMLElement | null>(null)

  const load = useCallback(() => {
    void call('bookmarks', 'tree').then(setTree, () => undefined)
  }, [])
  useEffect(load, [load])

  const children = useMemo<BookmarkItem[]>(() => {
    if (!tree) return []
    if (props.ids) {
      const set = new Set(props.ids)
      return tree.bar.children.filter((c) => set.has(c.id))
    }
    const found = locate(tree, props.folderId)
    return found?.item.kind === 'folder' ? found.item.children : []
  }, [tree, props.folderId, props.ids])

  // The folder went away (deleted elsewhere): nothing to show.
  useEffect(() => {
    if (tree && !props.ids && !locate(tree, props.folderId)) close()
  }, [tree, props.folderId, props.ids, close])

  const items = useMemo(() => (tree ? folderItems(children, t, props.ids ? null : props.folderId) : []), [tree, children, t, props.ids, props.folderId])

  const finish = (value: BookmarkFolderResult): void => resolve(value)
  const urlOf = (id: string): string | null => {
    if (!tree) return null
    const found = locate(tree, id)
    return found?.item.kind === 'bookmark' ? found.item.url : null
  }

  const choose = (item: KitItem, background: boolean): void => {
    const [kind, folderId] = item.id.split(':')
    if ((kind === OPEN_ALL || kind === OPEN_ALL_GROUP) && folderId) {
      finish({ kind: 'open-all', folderId, group: kind === OPEN_ALL_GROUP })
      return
    }
    const url = urlOf(item.id)
    if (url) finish({ kind: 'open', url, disposition: background ? 'background' : 'here' })
  }

  // Rows from the kit carry data-item; they become draggable here.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const mark = (): void => {
      for (const row of el.querySelectorAll<HTMLElement>('[data-item]')) {
        const id = row.dataset.item ?? ''
        if (tree && locate(tree, id)) row.draggable = true
      }
    }
    mark()
    const observer = new MutationObserver(mark)
    observer.observe(el, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [tree])

  const rowOf = (e: { target: EventTarget | null }): HTMLElement | null => (e.target instanceof Element ? e.target.closest<HTMLElement>('[data-item]') : null)
  const clearMark = (): void => {
    marked.current?.removeAttribute('data-drop')
    marked.current = null
  }
  const placeOf = (e: DragEvent, row: HTMLElement): DropPlace | null => {
    if (!tree) return null
    const id = row.dataset.item ?? ''
    const found = locate(tree, id)
    if (!found || id === dragging.current) return null
    const box = row.getBoundingClientRect()
    return dropPlace(e.clientY - box.top, box.height, found.item.kind === 'folder')
  }

  const onAuxClick = (e: MouseEvent): void => {
    if (e.button !== 1) return
    const row = rowOf(e)
    const url = row ? urlOf(row.dataset.item ?? '') : null
    if (!url) return
    e.preventDefault()
    finish({ kind: 'open', url, disposition: 'background' })
  }
  const onClickCapture = (e: MouseEvent): void => {
    if (!(e.metaKey || e.ctrlKey)) return
    const row = rowOf(e)
    const url = row ? urlOf(row.dataset.item ?? '') : null
    if (!url) return
    e.preventDefault()
    e.stopPropagation()
    finish({ kind: 'open', url, disposition: e.shiftKey ? 'foreground' : 'background' })
  }

  const rootBox = useRef<Box | null>(null)
  const subBox = useRef<Box | null>(null)
  const chrome = inChromeHost(instanceId)
  const report = (): void => {
    if (!chrome) return
    const box = unionBox([rootBox.current, subBox.current].filter((b): b is Box => !!b))
    if (box) reportBounds({ x: box.left, y: box.top, width: box.width, height: box.height })
  }

  const label = props.ids ? t('address.bookmarks.overflow') : tree ? folderTitle(tree, props.folderId, t) : t('address.bookmarks.bar')
  return (
    <>
      {!chrome && <MenuScrim onDismiss={close} />}
      <div
        ref={wrap}
        className="bf"
        onAuxClick={onAuxClick}
        onClickCapture={onClickCapture}
        onDragStart={(e) => {
          const row = rowOf(e)
          if (!row) return
          dragging.current = row.dataset.item ?? null
          e.dataTransfer.setData(DRAG_TYPE, dragging.current ?? '')
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          const row = rowOf(e)
          if (!row || !dragging.current) return
          const place = placeOf(e, row)
          if (!place) return
          e.preventDefault()
          if (marked.current !== row) clearMark()
          marked.current = row
          row.dataset.drop = place
        }}
        onDragLeave={(e) => {
          if (rowOf(e) === marked.current && !(e.relatedTarget instanceof Node && marked.current?.contains(e.relatedTarget))) clearMark()
        }}
        onDrop={(e) => {
          const row = rowOf(e)
          const id = dragging.current
          const place = row ? placeOf(e, row) : null
          clearMark()
          dragging.current = null
          if (!row || !id || !place || !tree) return
          e.preventDefault()
          const target = dropTarget(tree, row.dataset.item ?? '', place)
          if (target) void call('bookmarks', 'move', id, target.parentId, target.index).then(load, load)
        }}
        onDragEnd={() => {
          clearMark()
          dragging.current = null
        }}
      >
        <Popover
          anchor={anchorBox(anchor, anchorRect)}
          side="below"
          align="start"
          gap={4}
          width={Math.min(FOLDER_WIDTH, Math.max(220, (anchorRect?.width ?? 0) + 160))}
          label={label}
          className="bf__card"
          onBounds={(box) => {
            rootBox.current = box
            report()
          }}
        >
          {tree && (
            <CascadeMenu
              items={items}
              label={label}
              submenuWidth={FOLDER_WIDTH - 80}
              autoFocus
              handlers={{
                onChoose: (item) => choose(item, false),
                onDismiss: () => close(),
              }}
              onSubmenusBounds={(box) => {
                subBox.current = box
                report()
              }}
            />
          )}
        </Popover>
      </div>
    </>
  )
}

function folderTitle(tree: BookmarkTree, id: string, t: T): string {
  if (id === 'bar') return t('address.bookmarks.bar')
  if (id === 'other') return t('address.bookmarks.other')
  const found = locate(tree, id)
  return found?.item.kind === 'folder' ? (found.item as Folder).title : t('address.bookmarks.bar')
}
