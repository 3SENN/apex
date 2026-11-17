/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { BRAND_NAME } from '@shared/branding'
import type { BookmarkFolder, BookmarkItem, BookmarkTree } from '@shared/bookmarks'
import { cleanTitle, isBookmarkableUrl } from '@shared/bookmarks'

// Netscape bookmark HTML: the format every browser imports and
// exports. Export marks the bar the way Chrome does (PERSONAL_TOOLBAR_FOLDER)
// and Other bookmarks the way Firefox does (UNFILED_BOOKMARKS_FOLDER), so a
// file Apex wrote comes back into the same roots. Everything is escaped.

export const BOOKMARKS_HTML_MAX = 20 * 1024 * 1024

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const seconds = (ms: number): number => Math.max(0, Math.floor(ms / 1000))

export function exportBookmarksHtml(tree: BookmarkTree): string {
  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    `<!-- This file was written by ${BRAND_NAME}. It is read again on import. -->`,
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ]
  const item = (node: BookmarkItem, indent: string): void => {
    if (node.kind === 'bookmark') {
      lines.push(`${indent}<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${seconds(node.createdAt)}">${escapeHtml(node.title)}</A>`)
      return
    }
    folder(node, indent, '')
  }
  const folder = (node: BookmarkFolder, indent: string, marker: string): void => {
    lines.push(`${indent}<DT><H3 ADD_DATE="${seconds(node.createdAt)}"${marker}>${escapeHtml(node.title)}</H3>`)
    lines.push(`${indent}<DL><p>`)
    for (const child of node.children) item(child, `${indent}    `)
    lines.push(`${indent}</DL><p>`)
  }
  folder(tree.bar, '    ', ' PERSONAL_TOOLBAR_FOLDER="true"')
  folder(tree.other, '    ', ' UNFILED_BOOKMARKS_FOLDER="true"')
  lines.push('</DL><p>')
  return `${lines.join('\n')}\n`
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body.toLowerCase()] ?? whole
  })
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  if (!m) return null
  return decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
}

export interface ParsedBookmarks {
  /** Items of the bar folder in the file, if it marked one. */
  bar: BookmarkItem[]
  /** Everything else: the Other bookmarks folder's items, and loose top-level items and folders. */
  other: BookmarkItem[]
  /** Links skipped because they weren't web addresses (javascript:, place:, file:). */
  skipped: number
}

/**
 * Reads a Netscape bookmark file in one pass. `newId` gives each item a fresh
 * id. Tags are matched leniently (any case, optional <p>, unclosed <DT>), the
 * way other browsers write them.
 */
export function parseBookmarksHtml(html: string, newId: () => string, now = Date.now()): ParsedBookmarks {
  const bar: BookmarkItem[] = []
  const marked: BookmarkItem[] = []
  const loose: BookmarkItem[] = []
  let skipped = 0
  // Each <DL> level writes into one list; the top level collects loose items.
  const stack: BookmarkItem[][] = [loose]
  // The list the next <DL> opens: the folder named by the last <H3>.
  let pending: BookmarkItem[] | null = null
  const lower = html.toLowerCase()
  const tag = /<(\/?)(dl|h3|a)\b([^>]*)>/gi
  const created = (attrs: string): number => {
    const at = Number(attr(attrs, 'add_date')) * 1000
    return Number.isFinite(at) && at > 0 ? at : now
  }
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const closing = m[1] === '/'
    const name = (m[2] ?? '').toLowerCase()
    const attrs = m[3] ?? ''
    const level = stack[stack.length - 1] as BookmarkItem[]
    if (name === 'dl') {
      if (closing) {
        if (stack.length > 1) stack.pop()
      } else {
        stack.push(pending ?? level)
        pending = null
      }
      continue
    }
    if (closing) continue
    const end = lower.indexOf(`</${name}`, tag.lastIndex)
    const text = decodeEntities(html.slice(tag.lastIndex, end === -1 ? undefined : end).replace(/<[^>]*>/g, '')).trim()
    if (name === 'h3') {
      const top = stack.length <= 2 && level === loose
      if (top && attr(attrs, 'personal_toolbar_folder') === 'true') pending = bar
      else if (top && attr(attrs, 'unfiled_bookmarks_folder') === 'true') pending = marked
      else {
        const folder: BookmarkFolder = { kind: 'folder', id: newId(), title: cleanTitle(text, 'Untitled folder'), createdAt: created(attrs), children: [] }
        level.push(folder)
        pending = folder.children
      }
    } else {
      const href = attr(attrs, 'href') ?? ''
      if (!isBookmarkableUrl(href)) {
        skipped++
        continue
      }
      level.push({ kind: 'bookmark', id: newId(), url: href, title: cleanTitle(text, href), createdAt: created(attrs) })
    }
  }
  return { bar, other: [...marked, ...loose], skipped }
}
