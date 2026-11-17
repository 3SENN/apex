/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Tab groups and tab state shared by main and the chrome. The
// colour names are Atelier's own; their tokens (--group-<color>-fill, -text and
// -ring) are defined for light and dark in styles.css.

export const GROUP_COLORS = ['graphite', 'berry', 'honey', 'fern', 'lagoon', 'iris', 'coral', 'sage'] as const

export type GroupColor = (typeof GROUP_COLORS)[number]

export interface TabGroup {
  id: string
  name: string
  color: GroupColor
  collapsed: boolean
}

export const GROUP_NAME_MAX = 80

/** How far a tab's page has got; drives the progress bar and favicon spinner (SS-01). */
export type LoadStage = 'idle' | 'started' | 'response' | 'dom-ready' | 'finished'

export type SplitSide = 'left' | 'right'

/** The extra TabInfo fields at rest, for fixtures and for tabs no decorator has filled. */
export const TAB_INFO_DEFAULTS = {
  windowId: 1,
  loadStage: 'idle',
  loadStartedAt: null,
  zoomPercent: 100,
  groupId: null,
  sleeping: false,
  restoring: false,
  security: 'none',
  capture: { camera: false, microphone: false, screen: false },
  pageError: null,
  crashed: false,
  unresponsive: false,
} as const satisfies Record<string, unknown>


/** Split widths: the left pane's share of the content width (SH-41). */
export const SPLIT_EVEN = 0.5
export const SPLIT_RATIO_MIN = 0.2
export const SPLIT_RATIO_MAX = 0.8

/** The media card (SH-17): a background tab playing sound or video, or one the card paused. */
export interface TabMedia {
  tabId: string
  title: string
  url: string
  favicon: string | null
  /** False once the card paused it; the card stays so it can resume. */
  playing: boolean
  muted: boolean
}

export type MediaAction = 'play' | 'pause' | 'mute' | 'unmute' | 'dismiss'

/** What the tear-off ghost window draws (SH-30): it grows from a chip into a thumbnail with distance. */
export interface TabGhost {
  title: string
  favicon: string | null
  thumbnail: string | null
  /** 0 at the list, 1 once the pointer is far enough away. */
  grow: number
  /** DS-16: 0 as a chip or card, 1 once it has morphed into a pinned tile over the pinned grid. */
  tile?: number
}

/** Drop zones main hears about during a tab drag: only the pinned grid changes the ghost (DS-16). */
export type TabDragZone = 'pinned'

/** The share of the page on each side where a dropped tab splits (main's zoneAt; the overlay draws the same: 2fr 1fr 2fr). */
export const SPLIT_ZONE_SHARE = 0.4

/** The split side at `t`, 0 to 1 across the content card; the middle splits nothing. Main and the zones both ask here. */
export function splitSideAt(t: number): SplitSide | null {
  return t < SPLIT_ZONE_SHARE ? 'left' : t > 1 - SPLIT_ZONE_SHARE ? 'right' : null
}

/** How close `t` is to either outer edge, 0 to 1: the zones grow as the pointer nears one. */
export function splitReachAt(t: number): number {
  return Math.max(0, Math.min(1, Math.abs(t - 0.5) * 2))
}

/** Why the split zones are off during a drag (SH-30), or null when they take drops. */
export type SplitZonesBlock = 'already-split' | 'agent' | 'replying' | null
