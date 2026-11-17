/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The navigation rail (SH-63): which pages get it, its width and the saved
// per-window conveniences. Pure, so it is tested.
import type { TabsSnapshot } from '@shared/ipc'
import { isInternalUrl } from '@shared/url'

export const RAIL_WIDTH = { min: 180, max: 320, default: 220 } as const
/** The collapsed rail: icons only. */
export const RAIL_COLLAPSED_WIDTH = 52
export const RAIL_STEP = 8
/** Recent chats listed under the destinations. */
export const RAIL_RECENT = 5

/** The rail shows in the horizontal layout on apex:// pages and on the destination surface. */
export function railShown(layout: 'sidebar' | 'horizontal' | string, snapshot: Pick<TabsSnapshot, 'tabs' | 'activeId' | 'rail'>): boolean {
  if (layout === 'sidebar') return false
  if (snapshot.rail) return true
  const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeId)
  return active !== undefined && isInternalUrl(active.url)
}

export function clampRailWidth(width: number): number {
  if (!Number.isFinite(width)) return RAIL_WIDTH.default
  return Math.round(Math.min(RAIL_WIDTH.max, Math.max(RAIL_WIDTH.min, width)))
}

export interface RailPrefs {
  collapsed: boolean
  width: number
  hintSeen: boolean
}

export const RAIL_PREFS_KEY = 'apex.rail'

/** Saved prefs, or the defaults for anything missing or broken. */
export function parseRailPrefs(raw: string | null): RailPrefs {
  const base: RailPrefs = { collapsed: false, width: RAIL_WIDTH.default, hintSeen: false }
  if (!raw) return base
  try {
    const v = JSON.parse(raw) as Partial<RailPrefs>
    return {
      collapsed: v.collapsed === true,
      width: typeof v.width === 'number' ? clampRailWidth(v.width) : base.width,
      hintSeen: v.hintSeen === true,
    }
  } catch {
    return base
  }
}

/** The most recently used chats, unarchived, newest first. */
export function recentChats<T extends { id: string; lastActiveAt: number; archived: boolean }>(chats: readonly T[] | null, max = RAIL_RECENT): T[] {
  return (chats ?? []).filter((c) => !c.archived).sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, max)
}
