/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The tab overlay surfaces: tab and group cards, the recent-tab switcher, split and the sidebar.
import type { SidebarOptions } from '../ipc'
import type { ChatPreview } from '../services/chat'
import type { GroupColor, SplitZonesBlock } from '../tabs'

export const TABS_SURFACES = ['tab-hover-card', 'recent-tabs', 'group-hover-card', 'split-menu', 'split-zones', 'sidebar-reveal', 'sidebar-options'] as const

export type TabsSurfaceId = (typeof TABS_SURFACES)[number]

/** One page on a hover card or a switcher card. */
export interface TabCardPage {
  tabId: string
  title: string
  /** The display host, or the Atelier page name. */
  host: string
  favicon: string | null
  thumbnail: string | null
}

/** Where the card sits: right of a sidebar row, or below a strip tab. */
export type CardSide = 'right' | 'below'

/**
 * Where a hover card sits and how it moves. A card that replaces the one on
 * the previous row slides in from there (`glideFrom`, in CSS px), and
 * `leaving` starts its short exit unless the pointer is on the card itself.
 */
export interface CardPlacement {
  side: CardSide
  leaving: boolean
  glideFrom?: { dx: number; dy: number } | null
}

export type TabHoverCardContent =
  | { kind: 'tab'; page: TabCardPage; live: boolean }
  | { kind: 'split'; pages: TabCardPage[] }
  | { kind: 'chat'; chatId: string; title: string; preview: ChatPreview | null }
  | { kind: 'routines'; runs: { id: string; name: string; at: number }[]; more: number }

export type TabHoverCardProps = TabHoverCardContent & CardPlacement

export interface GroupHoverCardProps extends CardPlacement {
  name: string
  color: GroupColor
  tabs: { tabId: string; title: string; host: string; favicon: string | null }[]
}

/** One switcher card: a tab, a split pair (two pages) or a chat. */
export interface RecentCard {
  /** The tab to activate on commit. */
  tabId: string
  kind: 'tab' | 'split' | 'chat'
  pages: TabCardPage[]
}

export interface RecentTabsProps {
  cards: RecentCard[]
  selected: number
}

export interface SplitMenuPage {
  tabId: string
  title: string
  favicon: string | null
}

export interface SplitMenuProps {
  left: SplitMenuPage
  right: SplitMenuPage
  /** Reset is disabled when already even. */
  even: boolean
  focused: 'left' | 'right'
}

/** What the split menu resolves with. */
export type SplitMenuChoice = 'swap' | 'reset' | 'close-left' | 'close-right' | 'separate'

export interface SplitZonesProps {
  /** The drag these zones belong to; their calls to main carry it. */
  session: number
  /** Main's read of the pointer, until the zones' own dragover takes over. */
  active: 'left' | 'right' | null
  block: SplitZonesBlock
  /** 0 to 1: how far toward a zone's outer edge the pointer is; the zone grows with it. */
  reach: number
}

export interface SidebarOptionsSurfaceProps {
  options: SidebarOptions
}

export type TabsSurfaceProps = {
  'tab-hover-card': TabHoverCardProps
  'group-hover-card': GroupHoverCardProps
  'recent-tabs': RecentTabsProps
  'split-menu': SplitMenuProps
  'split-zones': SplitZonesProps
  'sidebar-reveal': Record<string, never>
  'sidebar-options': SidebarOptionsSurfaceProps
}
