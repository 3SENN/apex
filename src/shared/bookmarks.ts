/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The bookmark tree (SH-47 to SH-49): two roots, the
// bookmarks bar and Other bookmarks, holding links and folders in order.
// bookmarks.json was once a flat list; migrateBookmarks moves it
// onto the bar root, keeping order and ids. Every operation here is pure and
// returns a new tree, so main's store and the tests share them.

export type BookmarkRootId = 'bar' | 'other'
export const BOOKMARK_ROOTS: readonly BookmarkRootId[] = ['bar', 'other']

export interface BookmarkLink {
  kind: 'bookmark'
  id: string
  title: string
  url: string
  createdAt: number
  /** The page's own favicon address, kept from its tab when saved (no favicon service is asked). */
  favicon?: string | null
}

export interface BookmarkFolder {
  kind: 'folder'
  id: string
  title: string
  createdAt: number
  children: BookmarkItem[]
}

export type BookmarkItem = BookmarkLink | BookmarkFolder

export interface BookmarkTree {
  bar: BookmarkFolder
  other: BookmarkFolder
}

/** Where an item was, so Undo can put it back. */
export interface BookmarkRemoval {
  item: BookmarkItem
  parentId: string
  index: number
}

export const BOOKMARK_TITLE_MAX = 1024
export const BOOKMARK_URL_MAX = 8192
export const BOOKMARK_DEPTH_MAX = 16
export const BOOKMARKS_MAX = 50_000

export function emptyTree(now = 0): BookmarkTree {
  return {
    bar: { kind: 'folder', id: 'bar', title: 'Bookmarks bar', createdAt: now, children: [] },
    other: { kind: 'folder', id: 'other', title: 'Other bookmarks', createdAt: now, children: [] },
  }
}

export function isRootId(id: string): id is BookmarkRootId {
  return id === 'bar' || id === 'other'
}

/** Web addresses only: the bar never opens anything else. */
export function isBookmarkableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.length <= BOOKMARK_URL_MAX
}

// ---- reading ----

export interface Located {
  item: BookmarkItem
  parent: BookmarkFolder | null
  index: number
}

export function locate(tree: BookmarkTree, id: string): Located | null {
  if (id === 'bar') return { item: tree.bar, parent: null, index: 0 }
  if (id === 'other') return { item: tree.other, parent: null, index: 1 }
  const walk = (folder: BookmarkFolder): Located | null => {
    for (let i = 0; i < folder.children.length; i++) {
      const child = folder.children[i] as BookmarkItem
      if (child.id === id) return { item: child, parent: folder, index: i }
      if (child.kind === 'folder') {
        const found = walk(child)
        if (found) return found
      }
    }
    return null
  }
  return walk(tree.bar) ?? walk(tree.other)
}

/** Every link, bar first, in tree order. */
export function flattenLinks(tree: BookmarkTree): BookmarkLink[] {
  const out: BookmarkLink[] = []
  const walk = (items: BookmarkItem[]): void => {
    for (const item of items) {
      if (item.kind === 'bookmark') out.push(item)
      else walk(item.children)
    }
  }
  walk(tree.bar.children)
  walk(tree.other.children)
  return out
}

export function findByUrl(tree: BookmarkTree, url: string): BookmarkLink | null {
  return flattenLinks(tree).find((b) => b.url === url) ?? null
}

/** Every folder with its depth and path, for the editor's folder picker. */
export function folderList(tree: BookmarkTree): Array<{ id: string; title: string; depth: number; path: string[] }> {
  const out: Array<{ id: string; title: string; depth: number; path: string[] }> = []
  const walk = (folder: BookmarkFolder, depth: number, path: string[]): void => {
    const here = [...path, folder.title]
    out.push({ id: folder.id, title: folder.title, depth, path: here })
    for (const child of folder.children) if (child.kind === 'folder') walk(child, depth + 1, here)
  }
  walk(tree.bar, 0, [])
  walk(tree.other, 0, [])
  return out
}

/** The links directly and deeply inside a folder, in order ("Open all"). */
export function linksIn(folder: BookmarkFolder): BookmarkLink[] {
  return folder.children.flatMap((c) => (c.kind === 'bookmark' ? [c] : linksIn(c)))
}

function isInside(tree: BookmarkTree, folderId: string, ancestorId: string): boolean {
  if (folderId === ancestorId) return true
  const ancestor = locate(tree, ancestorId)?.item
  if (!ancestor || ancestor.kind !== 'folder') return false
  return linksAndFolders(ancestor).some((i) => i.id === folderId)
}

function linksAndFolders(folder: BookmarkFolder): BookmarkItem[] {
  return folder.children.flatMap((c) => (c.kind === 'folder' ? [c, ...linksAndFolders(c)] : [c]))
}

function depthOf(tree: BookmarkTree, id: string): number {
  let depth = 0
  let current = locate(tree, id)
  while (current?.parent) {
    depth++
    current = locate(tree, current.parent.id)
  }
  return depth
}

// ---- changing (each returns a new tree) ----

/** Rebuilds the path from a root to the folder `id`, applying `fn` to its children. */
function editFolder(tree: BookmarkTree, id: string, fn: (children: BookmarkItem[]) => BookmarkItem[]): BookmarkTree {
  const edit = (folder: BookmarkFolder): BookmarkFolder | null => {
    if (folder.id === id) return { ...folder, children: fn([...folder.children]) }
    for (let i = 0; i < folder.children.length; i++) {
      const child = folder.children[i] as BookmarkItem
      if (child.kind !== 'folder') continue
      const next = edit(child)
      if (next) {
        const children = [...folder.children]
        children[i] = next
        return { ...folder, children }
      }
    }
    return null
  }
  const bar = edit(tree.bar)
  if (bar) return { ...tree, bar }
  const other = edit(tree.other)
  if (other) return { ...tree, other }
  throw new Error('That folder no longer exists.')
}

export function insertItem(tree: BookmarkTree, parentId: string, index: number | null, item: BookmarkItem): BookmarkTree {
  const parent = locate(tree, parentId)?.item
  if (!parent || parent.kind !== 'folder') throw new Error('That folder no longer exists.')
  if (item.kind === 'folder' && depthOf(tree, parentId) + 1 > BOOKMARK_DEPTH_MAX) throw new Error('Folders can’t be nested that deeply.')
  return editFolder(tree, parentId, (children) => {
    const at = index === null ? children.length : Math.max(0, Math.min(children.length, Math.round(index)))
    children.splice(at, 0, item)
    return children
  })
}

export function removeItem(tree: BookmarkTree, id: string): { tree: BookmarkTree; removal: BookmarkRemoval } {
  if (isRootId(id)) throw new Error('The bookmarks bar and Other bookmarks can’t be removed.')
  const found = locate(tree, id)
  if (!found?.parent) throw new Error('That bookmark no longer exists.')
  const { parent, index, item } = found
  return { tree: editFolder(tree, parent.id, (children) => children.filter((c) => c.id !== id)), removal: { item, parentId: parent.id, index } }
}

/** Moves an item into `parentId` at `index` (an index in the parent as it is before the move). */
export function moveItem(tree: BookmarkTree, id: string, parentId: string, index: number): BookmarkTree {
  if (isRootId(id)) throw new Error('The bookmarks bar and Other bookmarks can’t be moved.')
  const found = locate(tree, id)
  if (!found?.parent) throw new Error('That bookmark no longer exists.')
  if (found.item.kind === 'folder' && isInside(tree, parentId, id)) throw new Error('A folder can’t go inside itself.')
  // Moving down within the same folder: the item's own slot disappears first.
  const adjusted = found.parent.id === parentId && found.index < index ? index - 1 : index
  const { tree: without } = removeItem(tree, id)
  return insertItem(without, parentId, adjusted, found.item)
}

export interface BookmarkPatch {
  title?: string
  url?: string
  favicon?: string | null
}

export function updateItem(tree: BookmarkTree, id: string, patch: BookmarkPatch): BookmarkTree {
  const found = locate(tree, id)
  if (!found) throw new Error('That bookmark no longer exists.')
  if (!found.parent) {
    // The roots keep their names; nothing else about them changes.
    return tree
  }
  const item = found.item
  let next: BookmarkItem
  if (item.kind === 'folder') {
    next = { ...item, title: cleanTitle(patch.title ?? item.title, 'Untitled folder') }
  } else {
    const url = patch.url === undefined ? item.url : patch.url.trim()
    if (!isBookmarkableUrl(url)) throw new Error('Enter a web address that starts with http:// or https://.')
    next = { ...item, url, title: cleanTitle(patch.title ?? item.title, url), ...(patch.favicon !== undefined ? { favicon: patch.favicon } : {}) }
  }
  return editFolder(tree, found.parent.id, (children) => children.map((c) => (c.id === id ? next : c)))
}

export function cleanTitle(title: string, fallback: string): string {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, BOOKMARK_TITLE_MAX)
  return clean || fallback
}

// ---- migration and validation ----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readItem(raw: unknown, seen: Set<string>, depth: number): BookmarkItem | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id) || isRootId(raw.id)) return null
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0
  if (raw.kind === 'folder' || (raw.kind === undefined && Array.isArray(raw.children))) {
    if (depth > BOOKMARK_DEPTH_MAX) return null
    seen.add(raw.id)
    const children = Array.isArray(raw.children) ? raw.children.map((c) => readItem(c, seen, depth + 1)).filter((c): c is BookmarkItem => c !== null) : []
    return { kind: 'folder', id: raw.id, title: cleanTitle(typeof raw.title === 'string' ? raw.title : '', 'Untitled folder'), createdAt, children }
  }
  if (typeof raw.url !== 'string' || !isBookmarkableUrl(raw.url)) return null
  seen.add(raw.id)
  const favicon = typeof raw.favicon === 'string' && /^https?:\/\//i.test(raw.favicon) && raw.favicon.length <= 2048 ? raw.favicon : null
  return { kind: 'bookmark', id: raw.id, url: raw.url, title: cleanTitle(typeof raw.title === 'string' ? raw.title : '', raw.url), createdAt, ...(favicon ? { favicon } : {}) }
}

/**
 * Reads bookmarks.json in either shape: the old flat list (every bookmark lands
 * on the bar, in order, with its id) or the tree ({ version: 2, bar, other }).
 * Broken entries and repeated ids drop out.
 */
export function migrateBookmarks(raw: unknown, now = 0): BookmarkTree {
  const tree = emptyTree(now)
  const seen = new Set<string>()
  if (Array.isArray(raw)) {
    tree.bar.children = raw.map((r) => readItem(isRecord(r) ? { ...r, kind: r.kind ?? 'bookmark' } : r, seen, 1)).filter((c): c is BookmarkItem => c !== null)
    return tree
  }
  if (!isRecord(raw)) return tree
  for (const root of BOOKMARK_ROOTS) {
    const list = Array.isArray(raw[root]) ? raw[root] : isRecord(raw[root]) && Array.isArray((raw[root] as { children?: unknown }).children) ? (raw[root] as { children: unknown[] }).children : []
    tree[root].children = (list as unknown[]).map((r) => readItem(r, seen, 1)).filter((c): c is BookmarkItem => c !== null)
  }
  return tree
}

/** The on-disk form. */
export function serializeTree(tree: BookmarkTree): { version: 2; bar: BookmarkItem[]; other: BookmarkItem[] } {
  return { version: 2, bar: tree.bar.children, other: tree.other.children }
}

// ---- drag and drop ----

export type DropPlace = 'before' | 'inside' | 'after'

/**
 * Where a drag over an item lands: over a folder's middle third it
 * goes inside; otherwise before or after, by the half (or third) it is over.
 * `pos` and `size` are along the list's axis.
 */
export function dropPlace(pos: number, size: number, isFolder: boolean): DropPlace {
  if (size <= 0) return 'after'
  const f = pos / size
  if (isFolder) return f < 1 / 3 ? 'before' : f > 2 / 3 ? 'after' : 'inside'
  return f < 0.5 ? 'before' : 'after'
}

/** The parent and index a drop lands on, for moveItem. */
export function dropTarget(tree: BookmarkTree, overId: string, place: DropPlace): { parentId: string; index: number } | null {
  const found = locate(tree, overId)
  if (!found) return null
  if (place === 'inside' || !found.parent) return found.item.kind === 'folder' ? { parentId: found.item.id, index: found.item.children.length } : null
  return { parentId: found.parent.id, index: found.index + (place === 'after' ? 1 : 0) }
}
