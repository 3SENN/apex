/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tab services: selection, groups, moving between windows, thumbnails,
// recent order and split. Additions to the base `tabs` and `split`
// namespaces are intersected into them in services.ts.
import type { Bounds as Rect } from '../ipc'
import type { GroupColor, MediaAction, SplitSide, TabDragZone, TabGhost, TabGroup } from '../tabs'

export interface TabsServiceAdditions {
  setSelection(ids: string[]): void
  moveToNewWindow(tabIds: string[]): number
  moveToWindow(tabIds: string[], windowId: number, index: number): void
  /** A small JPEG data URL of the tab for hover cards and live previews; null when nothing can be captured. */
  thumbnail(tabId: string): Promise<string | null>
  /** Tab ids, most recently used first (the recent-tab switcher). */
  recent(): string[]
  /**
   * A chat's tab link (`tab:<id>`): shows that tab in whichever window holds it
   * and brings that window to the front ('shown'), reopens a closed one here
   * ('reopened'), or 'gone'. Never crosses between private and normal windows.
   */
  reveal(tabId: string): 'shown' | 'reopened' | 'gone'
  /** A chat's page link: shows an open tab with this page (this window first) and returns true; false when none has it. */
  revealUrl(url: string): boolean
  /** The switcher (in the overlay) picked a card by pointer or arrow key; main tells the chrome, which owns the selection. */
  switcherHover(index: number): void
}

export interface SplitServiceAdditions {
  openUrl(url: string): void
  /** The primary side's share of the width, 0.2 to 0.8. */
  setRatio(ratio: number): void
  /** Back to an even split. */
  reset(): void
  closeSide(side: SplitSide): void
  /** Ends the split, keeping both tabs. */
  separate(): void
  /** Picks the other side's tab from the split chooser. */
  choose(tabId: string): void
}

export interface TabGroupPatch {
  name?: string
  color?: GroupColor
  collapsed?: boolean
}

/** What a "Group tabs" run did: tabs moved, groups made or added to, and its undo id (null when nothing moved). */
export interface AutoGroupResult {
  tabs: number
  groups: number
  undo: string | null
}

export interface TabServices {
  /** `tabs.group.*`; flattened because services dispatch two levels deep. */
  tabGroups: {
    create(tabIds: string[], name?: string): TabGroup
    update(id: string, patch: TabGroupPatch): TabGroup
    ungroup(id: string): void
    close(id: string): void
    addTabs(id: string, tabIds: string[]): void
    /** Takes tabs out of whatever group holds them (the tab menu's Remove from Group). */
    removeTabs(tabIds: string[]): void
    /** ⌥⌘T and the group menu: a new tab at the end of the group. */
    newTab(id: string): void
    /**
     * "Group tabs" (DC-18): the window's ungrouped, unpinned web tabs (only
     * `tabIds` when given) grouped by site, or by topic with the decision
     * model. Main shows the outcome in a toast with Undo.
     */
    auto(tabIds?: string[]): Promise<AutoGroupResult>
    /** Undoes a "Group tabs" run by its result's `undo` id; the tabs stay where they are. */
    undoAuto(id: string): void
  }
  /** The media card's buttons (SH-17). */
  tabMedia: {
    control(tabId: string, action: MediaAction): void
  }
  /** Tear-off (SH-30): the chrome starts a drag that leaves the list; main follows the pointer and decides the drop. */
  tabDrag: {
    /** `list` is the dragged-from list's rect in the chrome's CSS px; the ghost grows with distance from it. */
    start(tabId: string, list?: Rect | null): void
    /** The pointer was released; `onList` when the chrome's list took the drop itself. */
    end(onList: boolean): void
    cancel(): void
    /** DS-16: the pointer entered (a zone) or left (null) the pinned grid, so the ghost morphs into a tile and back. */
    over(zone: TabDragZone | null): void
    /** The split zones over this window's page got the drag (`session` is in their props): from now on only their drop splits. */
    zonesSeen(session: number): void
    /** The drop landed on the split zones over this window's page, on `side` (null: the middle, or splitting is off). */
    dropOnZone(session: number, side: SplitSide | null): void
  }
}

export type TabEvent =
  /** Sent to the ghost window only: what to draw, or null to clear. */
  | { type: 'tab-ghost'; ghost: TabGhost | null }
  /** A tab drag is under way in any window: hover cards close and rows stop reacting. */
  | { type: 'tab-drag'; active: boolean }
  /** The switcher's pointer or arrow-key pick, relayed to the chrome. */
  | { type: 'recent-tabs-hover'; index: number }
