/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  dropPlace,
  dropTarget,
  emptyTree,
  findByUrl,
  flattenLinks,
  folderList,
  insertItem,
  isBookmarkableUrl,
  linksIn,
  locate,
  migrateBookmarks,
  moveItem,
  removeItem,
  serializeTree,
  updateItem,
  type BookmarkFolder,
  type BookmarkLink,
  type BookmarkTree,
} from '@shared/bookmarks'
import { decodeEntities, escapeHtml, exportBookmarksHtml, parseBookmarksHtml } from '../src/main/bookmarksHtml'

const link = (id: string, url: string, title = id): BookmarkLink => ({ kind: 'bookmark', id, url, title, createdAt: 1 })
const folder = (id: string, title: string, children: BookmarkFolder['children'] = []): BookmarkFolder => ({ kind: 'folder', id, title, createdAt: 1, children })

function sample(): BookmarkTree {
  let tree = emptyTree(1)
  tree = insertItem(tree, 'bar', null, link('a', 'https://a.test/'))
  tree = insertItem(tree, 'bar', null, folder('f', 'Work', [link('b', 'https://b.test/'), folder('g', 'Deep', [link('c', 'https://c.test/')])]))
  tree = insertItem(tree, 'bar', null, link('d', 'https://d.test/'))
  tree = insertItem(tree, 'other', null, link('e', 'https://e.test/'))
  return tree
}

const ids = (f: BookmarkFolder): string[] => f.children.map((c) => c.id)

describe('bookmark tree (SH-47, SH-48)', () => {
  it('inserts, finds and lists folders', () => {
    const tree = sample()
    expect(ids(tree.bar)).toEqual(['a', 'f', 'd'])
    expect(locate(tree, 'c')?.parent?.id).toBe('g')
    expect(findByUrl(tree, 'https://e.test/')?.id).toBe('e')
    expect(flattenLinks(tree).map((l) => l.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(folderList(tree).map((f) => [f.id, f.depth])).toEqual([
      ['bar', 0],
      ['f', 1],
      ['g', 2],
      ['other', 0],
    ])
    expect(linksIn(locate(tree, 'f')?.item as BookmarkFolder).map((l) => l.id)).toEqual(['b', 'c'])
    expect(() => insertItem(tree, 'nope', null, link('z', 'https://z.test/'))).toThrow()
  })

  it('removes with a removal that restores it in place, and never removes a root', () => {
    const tree = sample()
    const { tree: without, removal } = removeItem(tree, 'f')
    expect(ids(without.bar)).toEqual(['a', 'd'])
    expect(removal).toMatchObject({ parentId: 'bar', index: 1 })
    const restored = insertItem(without, removal.parentId, removal.index, removal.item)
    expect(restored).toEqual(tree)
    expect(() => removeItem(tree, 'bar')).toThrow()
  })

  it('moves within a folder, between folders and refuses a folder into itself', () => {
    const tree = sample()
    // Down within the same folder: index is before the move.
    expect(ids(moveItem(tree, 'a', 'bar', 3).bar)).toEqual(['f', 'd', 'a'])
    expect(ids(moveItem(tree, 'd', 'bar', 0).bar)).toEqual(['d', 'a', 'f'])
    const moved = moveItem(tree, 'e', 'g', 0)
    expect(locate(moved, 'e')?.parent?.id).toBe('g')
    expect(() => moveItem(tree, 'f', 'g', 0)).toThrow()
    expect(() => moveItem(tree, 'f', 'f', 0)).toThrow()
  })

  it('updates titles and addresses, validating them', () => {
    const tree = sample()
    const renamed = updateItem(tree, 'a', { title: '  New   name ' })
    expect((locate(renamed, 'a')?.item as BookmarkLink).title).toBe('New name')
    expect((locate(updateItem(tree, 'a', { title: '' }), 'a')?.item as BookmarkLink).title).toBe('https://a.test/')
    expect(() => updateItem(tree, 'a', { url: 'javascript:alert(1)' })).toThrow()
    expect(updateItem(tree, 'bar', { title: 'x' })).toBe(tree)
    expect(isBookmarkableUrl('ftp://x')).toBe(false)
  })

  it('places drops before, inside (middle third of a folder) or after', () => {
    expect(dropPlace(5, 30, true)).toBe('before')
    expect(dropPlace(15, 30, true)).toBe('inside')
    expect(dropPlace(25, 30, true)).toBe('after')
    expect(dropPlace(14, 30, false)).toBe('before')
    expect(dropPlace(16, 30, false)).toBe('after')
    const tree = sample()
    expect(dropTarget(tree, 'f', 'inside')).toEqual({ parentId: 'f', index: 2 })
    expect(dropTarget(tree, 'd', 'after')).toEqual({ parentId: 'bar', index: 3 })
    expect(dropTarget(tree, 'a', 'inside')).toBeNull()
  })
})

describe('migration (the older flat list to the tree)', () => {
  it('keeps order and ids, and drops broken or repeated entries', () => {
    const tree = migrateBookmarks(
      [
        { id: '1', url: 'https://one.test/', title: 'One', createdAt: 5 },
        { id: '2', url: 'javascript:void(0)', title: 'Bad' },
        { id: '1', url: 'https://dup.test/', title: 'Dup' },
        { id: '3', url: 'https://three.test/', title: '' },
        'junk',
      ],
      9,
    )
    expect(ids(tree.bar)).toEqual(['1', '3'])
    expect((tree.bar.children[1] as BookmarkLink).title).toBe('https://three.test/')
    expect(tree.other.children).toEqual([])
  })

  it('reads the tree form back and round-trips through serializeTree', () => {
    const tree = sample()
    const back = migrateBookmarks(JSON.parse(JSON.stringify(serializeTree(tree))), 1)
    expect(flattenLinks(back).map((l) => l.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ids(back.bar)).toEqual(['a', 'f', 'd'])
    expect(migrateBookmarks(null).bar.children).toEqual([])
  })
})

describe('Netscape HTML', () => {
  it('escapes what it writes', () => {
    expect(escapeHtml('<a href="x">&\'')).not.toMatch(/[<>"]/)
    expect(decodeEntities(escapeHtml('Tom & Jerry <3 "quotes"'))).toBe('Tom & Jerry <3 "quotes"')
  })

  it('round-trips folders, order and titles', () => {
    let tree = sample()
    tree = updateItem(tree, 'a', { title: 'A & <B>' })
    const html = exportBookmarksHtml(tree)
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>')
    let n = 0
    const parsed = parseBookmarksHtml(html, () => `id${++n}`, 1)
    expect(parsed.skipped).toBe(0)
    const titles = parsed.bar.map((i) => i.title)
    expect(titles[0]).toBe('A & <B>')
    const work = parsed.bar.find((i) => i.kind === 'folder' && i.title === 'Work') as BookmarkFolder | undefined
    expect(work?.children.map((c) => c.title)).toEqual(['b', 'Deep'])
    expect(parsed.other.some((i) => i.kind === 'bookmark' && i.url === 'https://e.test/')).toBe(true)
  })

  it('reads other browsers’ loose markup and skips non-web links', () => {
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<TITLE>Bookmarks</TITLE><H1>Bookmarks</H1>
<DL><p>
  <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
  <DL><p>
    <DT><A HREF="https://x.test/" ADD_DATE="1700000000">X &amp; Y</A>
    <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
  </DL><p>
  <DT><A HREF="https://loose.test/">Loose</A>
</DL>`
    const parsed = parseBookmarksHtml(html, () => Math.random().toString(36).slice(2), 1)
    expect(parsed.bar.map((i) => i.title)).toEqual(['X & Y'])
    expect(parsed.other.map((i) => i.title)).toEqual(['Loose'])
    expect(parsed.skipped).toBe(1)
  })
})
