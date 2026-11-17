/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Bookmark } from '@shared/services'
import {
  cleanTitle,
  findByUrl,
  flattenLinks,
  insertItem,
  isBookmarkableUrl,
  locate,
  migrateBookmarks,
  moveItem,
  removeItem,
  serializeTree,
  updateItem,
  BOOKMARKS_MAX,
  type BookmarkFolder,
  type BookmarkItem,
  type BookmarkLink,
  type BookmarkPatch,
  type BookmarkRemoval,
  type BookmarkTree,
} from '@shared/bookmarks'
import { writeAtomic } from './settings'
import { scopedInstance } from './profiles/scope'

// The bookmark store: the tree of the bar and Other bookmarks in
// bookmarks.json. The older flat list migrates onto the bar on first
// read. 'changed' keeps a flat list of links for the callers that only
// ask "is this page saved"; 'tree' carries the whole tree for the bar, the
// folder menus and the Bookmarks page.

let current: BookmarkStore | null = null

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

let profileStores: ((profileId: string) => BookmarkStore | null) | null = null

/** SH-64: each other profile's own store, answered inside that profile's scope. */
export function setProfileBookmarkStores(resolve: ((profileId: string) => BookmarkStore | null) | null): void {
  profileStores = resolve
}

/** The store the bootstrap built (or, inside a profile's scope, that profile's); the address feature reads it through here. */
export function bookmarkStore(): BookmarkStore | null {
  return scopedInstance(profileStores) ?? current
}

/** Only the page's own http(s) icon; anything else falls back to the glyph. */
function cleanFavicon(favicon: string | null | undefined): string | null {
  return favicon && /^https?:\/\//i.test(favicon) && favicon.length <= 2048 ? favicon : null
}

function toBookmark(link: BookmarkLink): Bookmark {
  return { id: link.id, url: link.url, title: link.title, createdAt: link.createdAt, ...(link.favicon ? { favicon: link.favicon } : {}) }
}

export class BookmarkStore extends EventEmitter<{ changed: [Bookmark[]]; tree: [BookmarkTree] }> {
  readonly #path: string
  #tree: BookmarkTree

  /** `profile`: another profile's store, reached through its scope rather than replacing the default one. */
  constructor(dataDir: string, options: { profile?: boolean } = {}) {
    super()
    this.#path = join(dataDir, 'bookmarks.json')
    const raw = readJson(this.#path)
    this.#tree = migrateBookmarks(raw, Date.now())
    // The older flat file is rewritten as the tree once, so the next read is the new shape.
    if (Array.isArray(raw)) this.#write()
    if (!options.profile) current = this
  }

  tree(): BookmarkTree {
    return this.#tree
  }

  /** Every link, bar first, as a flat list. */
  list(): Bookmark[] {
    return flattenLinks(this.#tree).map(toBookmark)
  }

  get(id: string): Bookmark | undefined {
    const item = locate(this.#tree, id)?.item
    return item?.kind === 'bookmark' ? toBookmark(item) : undefined
  }

  item(id: string): BookmarkItem | null {
    return locate(this.#tree, id)?.item ?? null
  }

  findByUrl(url: string): Bookmark | undefined {
    const link = findByUrl(this.#tree, url)
    return link ? toBookmark(link) : undefined
  }

  link(url: string): BookmarkLink | null {
    return findByUrl(this.#tree, url)
  }

  /** Adds or removes a bookmark; returns whether the URL is now bookmarked. */
  toggle(url: string, title: string, favicon: string | null = null): boolean {
    const existing = findByUrl(this.#tree, url)
    if (existing) {
      this.removeItem(existing.id)
      return false
    }
    this.add({ url, title, favicon })
    return true
  }

  /** ⌘D and the star: the existing bookmark for this page, or a new one on the bar. */
  add(input: { url: string; title: string; favicon?: string | null; parentId?: string; index?: number | null }): BookmarkLink {
    const existing = findByUrl(this.#tree, input.url)
    if (existing) return existing
    if (!isBookmarkableUrl(input.url)) throw new Error('Only web pages can be bookmarked.')
    this.#guardSize()
    const icon = cleanFavicon(input.favicon)
    const link: BookmarkLink = { kind: 'bookmark', id: randomUUID(), url: input.url, title: cleanTitle(input.title, input.url), createdAt: Date.now(), ...(icon ? { favicon: icon } : {}) }
    this.#commit(insertItem(this.#tree, input.parentId ?? 'bar', input.index ?? null, link))
    return link
  }

  createFolder(parentId: string, title: string, index: number | null = null): BookmarkFolder {
    this.#guardSize()
    const folder: BookmarkFolder = { kind: 'folder', id: randomUUID(), title: cleanTitle(title, 'New folder'), createdAt: Date.now(), children: [] }
    this.#commit(insertItem(this.#tree, parentId, index, folder))
    return folder
  }

  update(id: string, patch: BookmarkPatch & { parentId?: string }): BookmarkItem {
    const { parentId, ...rest } = patch
    let next = updateItem(this.#tree, id, rest)
    const found = locate(next, id)
    if (parentId !== undefined && found?.parent && found.parent.id !== parentId) {
      const target = locate(next, parentId)?.item
      next = moveItem(next, id, parentId, target?.kind === 'folder' ? target.children.length : 0)
    }
    // A URL now saved twice is allowed (folders may share a page); the star reads the first.
    this.#commit(next)
    return locate(this.#tree, id)?.item as BookmarkItem
  }

  move(id: string, parentId: string, index: number): void {
    this.#commit(moveItem(this.#tree, id, parentId, index))
  }

  /** Removes a bookmark or a folder with its contents; the result puts it back (Undo). */
  removeItem(id: string): BookmarkRemoval {
    const { tree, removal } = removeItem(this.#tree, id)
    this.#commit(tree)
    return removal
  }

  /** Removes a bookmark by id (the flat-list API). */
  remove(id: string): void {
    if (locate(this.#tree, id)) this.removeItem(id)
  }

  restore(removal: BookmarkRemoval): void {
    if (locate(this.#tree, removal.item.id)) return
    const parent = locate(this.#tree, removal.parentId)?.item.kind === 'folder' ? removal.parentId : 'bar'
    this.#commit(insertItem(this.#tree, parent, removal.index, removal.item))
  }

  /** Renames a bookmark (the flat-list API). */
  upsert(bookmark: Bookmark): Bookmark {
    if (locate(this.#tree, bookmark.id)) this.update(bookmark.id, { title: bookmark.title, url: bookmark.url })
    else this.add({ url: bookmark.url, title: bookmark.title, favicon: bookmark.favicon ?? null })
    return this.get(bookmark.id) ?? bookmark
  }

  /** Adds bookmarks whose URLs are not saved yet (browser import); returns how many were new. */
  addMany(items: Array<{ url: string; title: string }>): number {
    const known = new Set(flattenLinks(this.#tree).map((b) => b.url))
    const fresh = items.filter((i) => isBookmarkableUrl(i.url) && !known.has(i.url) && known.add(i.url))
    if (fresh.length === 0) return 0
    let tree = this.#tree
    for (const i of fresh) tree = insertItem(tree, 'bar', null, { kind: 'bookmark', id: randomUUID(), url: i.url, title: cleanTitle(i.title, i.url), createdAt: Date.now() })
    this.#commit(tree)
    return fresh.length
  }

  /** Imports parsed bookmark HTML: the bar's items onto the bar, the rest into Other bookmarks; pages already saved are skipped. */
  importItems(bar: BookmarkItem[], other: BookmarkItem[]): number {
    const known = new Set(flattenLinks(this.#tree).map((b) => b.url))
    let added = 0
    const keep = (items: BookmarkItem[]): BookmarkItem[] =>
      items.flatMap((item): BookmarkItem[] => {
        if (item.kind === 'bookmark') {
          if (known.has(item.url)) return []
          known.add(item.url)
          added++
          return [item]
        }
        const children = keep(item.children)
        return children.length > 0 ? [{ ...item, children }] : []
      })
    let tree = this.#tree
    for (const item of keep(bar)) tree = insertItem(tree, 'bar', null, item)
    for (const item of keep(other)) tree = insertItem(tree, 'other', null, item)
    if (added > 0) this.#commit(tree)
    return added
  }

  #guardSize(): void {
    if (flattenLinks(this.#tree).length >= BOOKMARKS_MAX) throw new Error('There are too many bookmarks to add another.')
  }

  #commit(tree: BookmarkTree): void {
    this.#tree = tree
    this.#write()
    this.emit('changed', this.list())
    this.emit('tree', this.#tree)
  }

  #write(): void {
    writeAtomic(this.#path, JSON.stringify(serializeTree(this.#tree), null, 2))
  }
}
