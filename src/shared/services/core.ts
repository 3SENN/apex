/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The core services and events: windows and key state.
import type { Rect } from '../overlay'
import type { ClosedEntry, WindowKind, WindowSummary } from '../windows'

export interface CoreServices {
  windows: {
    list(): WindowSummary[]
    /** Opens a window 24 px offset from the focused one; resolves to its id. */
    open(kind: 'normal' | 'private', options?: { url?: string }): number
    focus(id: number): void
    /** Closes the window (the caller's own when omitted), asking first when the settings say so. */
    close(id?: number): void
    /** Pops a chat out into its own chat window (CH-03). */
    openChat(chatId: string): number
    /** The last RECENTLY_CLOSED_LIMIT closed tabs, windows and chats, newest first. */
    recentlyClosed(): ClosedEntry[]
    /** ⇧⌘T, or a History menu entry; false when nothing is left. */
    reopen(index?: number): boolean
    /** The calling window's own id and kind (the private label, a chat window's layout). */
    current(): { id: number; kind: WindowKind; focusMode: boolean }
    /** Focus mode: a chromeless page with the sidebar, toolbar, bars and panel hidden. */
    setFocusMode(on: boolean): void
  }
}

export type CoreEvent =
  /** ⌘ held for about 300 ms shows the 1–8 hints; another key, release or blur hides them. */
  | { type: 'number-hints'; show: boolean }
  /** Holding ⌃ over ⌃Tab for about 150 ms opens the switcher; a quick tap flips in main. */
  | { type: 'recent-tabs'; phase: 'open' | 'step' | 'commit' | 'cancel'; delta: 1 | -1 }
  /** The pointer reached the window edge while the sidebar is hidden. */
  | { type: 'edge-reveal'; active: boolean }
  /** Where interactive overlay surfaces draw (window CSS px): the chrome lifts its drag regions there. */
  | { type: 'overlay-region'; rects: Rect[] }
  /** A whole-window dialog is open; the chrome blurs and washes itself, drawing `stills` where the hidden pages were (window CSS px). */
  | { type: 'window-veil'; on: boolean; stills: { rect: Rect; src: string }[] }
  /** Focus mode turned on or off for this window. */
  | { type: 'focus-mode'; on: boolean }
  /** Session restore found a file it could not read and started fresh. */
  | { type: 'session-notice'; reason: 'corrupt' | 'newer' }
  /** The macOS window material: vibrant where the flat tint allows it, opaque under Reduce Transparency. */
  | { type: 'window-material'; material: 'vibrant' | 'opaque' }
