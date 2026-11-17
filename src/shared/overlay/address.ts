/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The address overlay surfaces: the command bar, find, zoom, links, peek and bookmarks.
import type { FindState } from '../find'
import type { LinkPreview } from '../links'
import type { UniversalFilter } from '../omnibox'
import type { LoadStage } from '../tabs'

export const ADDRESS_SURFACES = [
  'command-bar',
  'universal-search',
  'find-bar',
  'zoom-popover',
  'link-bubble',
  'link-preview',
  'peek-frame',
  'page-progress',
  'bookmark-editor',
  'bookmark-folder',
  'bookmarks-overflow',
] as const

export type AddressSurfaceId = (typeof ADDRESS_SURFACES)[number]


export interface CommandBarProps {
  tabId: string
  /** What the field starts with: the full address, a kept draft, or dropped text. */
  text: string
  /** The page's address, for ⌘C and the restore on Esc. */
  url: string
  /** Select the whole field on entry (⌘L); false puts the caret at the end (a draft). */
  selectAll: boolean
  /** An empty new tab: Tab hands the text to the page's ask field, with a key-chip hint. */
  blank: boolean
  /** The companion's name for the ask row. */
  companion: string
  /** Run the text at once (a drop on the pill). */
  submit?: boolean
}

/** What the command bar resolves with; a dismissal means it closed without running anything. */
export type CommandBarResult =
  | { kind: 'done' }
  | { kind: 'ask'; text: string }
  /** Tab on an empty new tab: the text moves to the page's ask field. */
  | { kind: 'focus-ask'; text: string }

export interface UniversalSearchProps {
  filter: UniversalFilter
}

export interface FindBarProps {
  tabId: string
  /** Bumped by ⌘F while the bar is open, so the field takes focus and selects again. */
  focus: number
  /** Main's latest state for the tab (app events don't reach the overlay), pushed as it changes. */
  state?: FindState
}

export interface ZoomPopoverProps {
  tabId: string
  percent: number
}

export interface LinkBubbleProps {
  text: string
}

export interface LinkPreviewProps {
  url: string
  preview: LinkPreview | null
  failed: boolean
}

export interface PeekFrameProps {
  url: string
  title: string
  loading: boolean
}

export interface PageProgressProps {
  stage: LoadStage
  startedAt: number | null
}

export interface BookmarkEditorProps {
  /** The bookmark being edited (⌘D adds it first, then edits). */
  id: string
  /** True when ⌘D or the star just added it. */
  created: boolean
}

export interface BookmarkFolderProps {
  folderId: string
  /** The bar item's ids hidden behind the overflow button (bookmarks-overflow only). */
  ids?: string[]
}

/** What a bookmark folder or the overflow card resolves with. */
export type BookmarkFolderResult = { kind: 'open'; url: string; disposition: 'here' | 'background' | 'foreground' } | { kind: 'open-all'; folderId: string; group: boolean }


/** Each surface's props; the overlay validates them with the surface's own zod schema. */
export type AddressSurfaceProps = {
  'command-bar': CommandBarProps
  'universal-search': UniversalSearchProps
  'find-bar': FindBarProps
  'zoom-popover': ZoomPopoverProps
  'link-bubble': LinkBubbleProps
  'link-preview': LinkPreviewProps
  'peek-frame': PeekFrameProps
  'page-progress': PageProgressProps
  'bookmark-editor': BookmarkEditorProps
  'bookmark-folder': BookmarkFolderProps
  'bookmarks-overflow': BookmarkFolderProps
}
