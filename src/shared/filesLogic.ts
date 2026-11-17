/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure rules for the chat holdings and Library › Files: filtering and
// sorting the library, the pages-in-this-chat menu's keyboard, its
// favicon stack, and folder paths in the chat files modal.
import type { ChatContextPage } from './chatContext'
import type { LibraryFileKind, LibraryFileRef } from './files'

// ── Library › Files ──

export const LIBRARY_SORTS = ['newest', 'oldest', 'name', 'size'] as const
export type LibrarySort = (typeof LIBRARY_SORTS)[number]

export interface LibraryView {
  kind: LibraryFileKind | 'all'
  /** A companion id, or 'all'. */
  companionId: string
  /** A chat id, or 'all'. */
  chatId: string
  query: string
  sort: LibrarySort
}

export const LIBRARY_VIEW_DEFAULT: LibraryView = { kind: 'all', companionId: 'all', chatId: 'all', query: '', sort: 'newest' }

/** Every word of the query must appear in the name (case and accents ignored). */
export function matchesName(name: string, query: string): boolean {
  const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  const hay = fold(name)
  return fold(query).split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
}

export function filterLibrary(items: readonly LibraryFileRef[], view: LibraryView): LibraryFileRef[] {
  const shown = items.filter(
    (f) =>
      (view.kind === 'all' || f.kind === view.kind) &&
      (view.companionId === 'all' || f.companionId === view.companionId) &&
      (view.chatId === 'all' || f.chatId === view.chatId) &&
      matchesName(f.name, view.query),
  )
  const byName = (a: LibraryFileRef, b: LibraryFileRef): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  switch (view.sort) {
    case 'oldest':
      return shown.sort((a, b) => a.createdAt - b.createdAt || byName(a, b))
    case 'name':
      return shown.sort(byName)
    case 'size':
      return shown.sort((a, b) => b.size - a.size || byName(a, b))
    default:
      return shown.sort((a, b) => b.createdAt - a.createdAt || byName(a, b))
  }
}

/** The groups the Files page shows when no kind is picked: Generated, Reports, then Artifacts; empty groups are left out. */
export function groupLibrary(items: readonly LibraryFileRef[]): { kind: LibraryFileKind; items: LibraryFileRef[] }[] {
  const order: LibraryFileKind[] = ['generated', 'report', 'artifact']
  return order.map((kind) => ({ kind, items: items.filter((f) => f.kind === kind) })).filter((g) => g.items.length > 0)
}

/** The chats that produced files, newest file first, for the chat filter. */
export function chatsWithFiles(items: readonly LibraryFileRef[]): string[] {
  const seen = new Map<string, number>()
  for (const f of items) if (f.chatId) seen.set(f.chatId, Math.max(seen.get(f.chatId) ?? 0, f.createdAt))
  return [...seen].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}


export interface PagesMenuState {
  /** The selected row; -1 when the list is empty. */
  selected: number
}

export type PagesMenuKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'Delete' | 'Backspace' | 'Enter' | 'Escape'

export type PagesMenuEffect =
  | { kind: 'none' }
  | { kind: 'focus'; page: ChatContextPage }
  | { kind: 'remove'; page: ChatContextPage }
  /** Delete on a page the agent controls: refused, with the reason shown. */
  | { kind: 'refused'; page: ChatContextPage }
  | { kind: 'close' }

/** Keeps the selection on a row that still exists after the list changed. */
export function clampSelection(state: PagesMenuState, count: number): PagesMenuState {
  if (count === 0) return { selected: -1 }
  return { selected: Math.min(Math.max(state.selected, 0), count - 1) }
}

/**
 * One key in the pages menu: ↑ ↓ move (wrapping), Home and End jump, Enter
 * focuses the page, Delete (or Backspace) removes it from the chat's context
 * unless the agent controls it, and Esc closes the menu.
 */
export function pagesMenuKey(state: PagesMenuState, pages: readonly ChatContextPage[], key: PagesMenuKey): { state: PagesMenuState; effect: PagesMenuEffect } {
  const count = pages.length
  const current = clampSelection(state, count)
  const page = current.selected >= 0 ? pages[current.selected] : undefined
  switch (key) {
    case 'ArrowDown':
      return { state: { selected: count === 0 ? -1 : (current.selected + 1) % count }, effect: { kind: 'none' } }
    case 'ArrowUp':
      return { state: { selected: count === 0 ? -1 : (current.selected - 1 + count) % count }, effect: { kind: 'none' } }
    case 'Home':
      return { state: { selected: count === 0 ? -1 : 0 }, effect: { kind: 'none' } }
    case 'End':
      return { state: { selected: count - 1 }, effect: { kind: 'none' } }
    case 'Enter':
      return { state: current, effect: page ? { kind: 'focus', page } : { kind: 'none' } }
    case 'Delete':
    case 'Backspace':
      if (!page) return { state: current, effect: { kind: 'none' } }
      return { state: current, effect: page.controlled ? { kind: 'refused', page } : { kind: 'remove', page } }
    case 'Escape':
      return { state: current, effect: { kind: 'close' } }
  }
}

/** The pages the toolbar control and its menu list: open tabs first (newest first), then pages kept as context only. */
export function orderChatPages(pages: readonly ChatContextPage[]): ChatContextPage[] {
  return [...pages].sort((a, b) => Number(b.tabId !== null) - Number(a.tabId !== null) || b.addedAt - a.addedAt)
}

/** Up to three favicons for the toolbar's stack, and the count beside it. */
export function faviconStack(pages: readonly ChatContextPage[]): { icons: { key: string; favicon: string | null; title: string; url: string }[]; count: number } {
  const ordered = orderChatPages(pages)
  return {
    icons: ordered.slice(0, 3).map((p, i) => ({ key: `${p.tabId ?? 'ctx'}:${p.url}:${i}`, favicon: p.favicon, title: p.title, url: p.url })),
    count: ordered.length,
  }
}

// ── Chat files modal (CH-28) ──

/** '' for the folder list; 'attachments' → ''; 'attachments/a/b' → 'attachments/a'. */
export function parentFolder(folder: string): string {
  const i = folder.lastIndexOf('/')
  return i === -1 ? '' : folder.slice(0, i)
}

/** The breadcrumb parts of a folder path, each with the path it opens. */
export function folderCrumbs(folder: string): { name: string; path: string }[] {
  if (!folder) return []
  const parts = folder.split('/').filter(Boolean)
  return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }))
}

/** "1.2k characters" style counts for text files. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n)
  // Below 999,500 it reads in thousands; rounding up from there reads as 1M, never "1000k".
  if (n < 999_500) return `${(n / 1000).toFixed(n < 9_950 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// ── Sandboxed HTML previews (OV-32, CH-28) ──

/** The preview frame's own policy: no script, no fetch; images, fonts and media only from data: URLs. */
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'"

/** The document an HTML preview frame shows: the policy first, so it holds before any of the file's own markup. */
export function sandboxedDocument(html: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="referrer" content="no-referrer">${html}`
}
