/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The address feature's services and events: zoom, the command bar and
// universal search, find, bookmarks and the link menu's hand-offs.
import type { BookmarkFolder, BookmarkItem, BookmarkLink, BookmarkPatch, BookmarkRemoval, BookmarkTree } from '../bookmarks'
import type { FindState } from '../find'
import type { LinkPreview } from '../links'
import type { Rect } from '../overlay'
import type { OmniboxAction, OmniboxCommitResult, OmniboxCompletion, OmniboxGroup, UniversalFilter } from '../omnibox'

export interface AddressServices {
  /** Per-site page zoom, saved in zoom.json (never in settings). Returns the tab's new percentage. */
  zoom: {
    step(tabId: string, delta: 1 | -1): number
    reset(tabId: string): number
    get(tabId: string): number
  }
  /** The command bar's rows from every registered provider, grouped and ordered. */
  omnibox: {
    query(text: string): Promise<OmniboxGroup[]>
    /** The inline completion for what was typed, when a strong candidate exists (SH-35). */
    complete(text: string): OmniboxCompletion | null
    /** Unfinished text kept per tab; null when there is none. */
    draft(tabId: string): string | null
    setDraft(tabId: string, text: string | null): void
    /**
     * Runs a row (or the typed text, as a navigate action) for a tab and
     * remembers the pick. `ask` comes back to the chrome, which owns the
     * composer; anything that can't run comes back as an inline error.
     * `background` (⌘Enter) opens a new tab behind; `newTab` (⌥Enter) one in front.
     */
    commit(tabId: string, input: string, action: OmniboxAction, options?: { background?: boolean; newTab?: boolean }): OmniboxCommitResult
    /** A history row's ✕. */
    removeHistory(url: string): void
    /** Universal search: every window's tabs, chats, Atelier pages and commands. */
    universal(text: string, filter: UniversalFilter): Promise<OmniboxGroup[]>
  }
}

/** Methods added to the base find namespace (SH-44): per-tab state in main. */
export interface FindServiceAdditions {
  /** ⌘F: opens the tab's bar, seeded from the page selection when there is one. */
  open(tabId: string): FindState
  query(tabId: string, text: string): FindState
  /** Enter, ⇧Enter, ⌘G and ⇧⌘G. */
  step(tabId: string, forward: boolean): FindState
  /** Esc: closes and keeps the active match selected. */
  close(tabId: string): void
  state(tabId: string): FindState
}

/** Methods added to the base bookmarks namespace (SH-47 to SH-49). */
export interface BookmarksServiceAdditions {
  tree(): BookmarkTree
  /** ⌘D and the star: the page's existing bookmark, or a new one on the bar. */
  add(input: { url: string; title: string; parentId?: string; index?: number }): BookmarkLink
  createFolder(parentId: string, title: string, index?: number): BookmarkFolder
  update(id: string, patch: BookmarkPatch & { parentId?: string }): BookmarkItem
  move(id: string, parentId: string, index: number): void
  /** Removes a bookmark or folder; pass the result to restore for Undo. */
  removeItem(id: string): BookmarkRemoval
  restore(removal: BookmarkRemoval): void
  /** Opens a folder's links as tabs after the active one; returns their ids (the chrome may group them). */
  openAll(folderId: string, options?: { background?: boolean }): string[]
  /** Netscape HTML through a save dialog; the path, or null when cancelled. */
  exportHtml(): Promise<string | null>
  /** Netscape HTML through an open dialog; null when cancelled. */
  importHtml(): Promise<{ added: number; skipped: number } | null>
  /** The bookmark for a page, if it is saved. */
  forUrl(url: string): BookmarkLink | null
}

/** Methods added to the base peek namespace (SH-43). */
export interface PeekServiceAdditions {
  /** Shows a page a chat keeps in the peek card; closing hides it again instead of closing it. */
  showTab(tabId: string): void
}

export type AddressEvent =
  /** A tab's find state changed (its bar, query or matches). */
  | { type: 'find-state'; tabId: string; state: FindState }
  /** The bookmark tree changed. */
  | { type: 'bookmark-tree'; tree: BookmarkTree }
  /** The link menu's "Ask about this link": the chrome opens the panel through chats.askAbout. */
  | { type: 'address-ask'; url: string }
  /** The link under the pointer in a tab (update-target-url), for the link bubble; null when none. */
  | { type: 'link-hover'; tabId: string; url: string | null }
  /**
   * ⌥-hover or a long press on a link: the preview card's data, anchored to the
   * link (tab-relative chrome CSS px). `preview` null with a rect means loading;
   * rect null closes the card.
   */
  | { type: 'link-preview'; tabId: string; url: string; rect: Rect | null; preview: LinkPreview | null; failed?: boolean }
