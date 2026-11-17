/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Windows and sessions: window kinds, the window list, recently
// closed entries and the versioned session.json that restores windows, tabs
// with history, split and groups. Private windows are never written.
import type { Bounds } from './ipc'
import type { GroupColor } from './tabs'

export type WindowKind = 'normal' | 'private' | 'popup' | 'chat'

export interface WindowSummary {
  id: number
  kind: WindowKind
  title: string
  tabCount: number
  focused: boolean
}

export type ClosedEntry =
  | { kind: 'tab'; title: string; url: string; closedAt: number }
  | { kind: 'window'; tabCount: number; title: string; closedAt: number }
  | { kind: 'chat'; chatId: string; title: string; closedAt: number }

/** How many closed entries recentlyClosed() returns (the History menu). */
export const RECENTLY_CLOSED_LIMIT = 10

export interface SavedTab {
  url: string
  title: string
  pinned: boolean
  groupId: string | null
  entries: { url: string; title: string }[]
  /** The current entry in `entries`. */
  index: number
}

export interface SavedGroup {
  id: string
  name: string
  color: GroupColor
  collapsed: boolean
}

export interface SavedWindow {
  bounds: Bounds
  displayMode: 'normal' | 'maximized' | 'fullscreen'
  sidebarOpen: boolean
  name: string | null
  tabs: SavedTab[]
  activeIndex: number
  split: { primary: number; secondary: number; ratio: number } | null
  groups: SavedGroup[]
  // SavedWindow.spaces
  /** Each project's tabs (indexes into `tabs`) and the one last used there. Absent in older files. */
  spaces?: { projectId: string | null; tabIndexes: number[]; activeIndex: number }[]
  /** SH-61: the profile the window was in. Absent in older files, which restore into the default profile. */
  profileId?: string
}

export const SESSION_VERSION = 1

/** session.json v1. A corrupt or newer file starts fresh, with a notice. */
export interface SessionFile {
  version: typeof SESSION_VERSION
  windows: SavedWindow[]
}
