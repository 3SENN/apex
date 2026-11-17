/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The two-tier overlay host's contract. Surfaces draw above the
// page views in one of two transparent layers per window: an interactive tier
// (menus, dialogs, cards) and a passive, click-through tier (tooltips, the
// link bubble, progress). Each domain lists its ids in overlay/<domain>.ts;
// SURFACE_IDS is their union and unknown ids are rejected.
import type { Bounds } from './ipc'
import { ADDRESS_SURFACES, type AddressSurfaceProps } from './overlay/address'
import { CHAT_SURFACES, type ChatSurfaceProps } from './overlay/chat'
import { CORE_SURFACES, type CoreSurfaceProps } from './overlay/core'
import { MENUS_SURFACES, type MenusSurfaceProps } from './overlay/menus'
import { SETTINGS_SURFACES, type SettingsSurfaceProps } from './overlay/settings'
import { SITES_SURFACES, type SitesSurfaceProps } from './overlay/sites'
import { TABS_SURFACES, type TabsSurfaceProps } from './overlay/tabs'
import { AUTOFILL_SURFACES, type AutofillSurfaceProps } from './overlay/autofill'
import { COMPOSER_SURFACES, type ComposerSurfaceProps } from './overlay/composer'
import { CONNECTORS_SURFACES, type ConnectorsSurfaceProps } from './overlay/connectors'
import { EXTENSIONS_SURFACES, type ExtensionsSurfaceProps } from './overlay/extensions'
import { FILES_SURFACES, type FilesSurfaceProps } from './overlay/files'
import { PROFILES_SURFACES, type ProfilesSurfaceProps } from './overlay/profiles'
import { ACTIVITY_SURFACES, type ActivitySurfaceProps } from './overlay/activity'
import { CHAT_POPOVER_SURFACES, type ChatPopoverSurfaceProps } from './overlay/chat-popover'
import { SITE_SUGGESTION_SURFACES, type SiteSuggestionSurfaceProps } from './overlay/site-suggestions'
import { WORKSPACE_SURFACES, type WorkspaceSurfaceProps } from './overlay/workspace'
import { DIAGNOSTICS_SURFACES, type DiagnosticsSurfaceProps } from './overlay/diagnostics'
import { SYSTEM_SURFACES, type SystemSurfaceProps } from './overlay/system'
import { UPDATES_SURFACES, type UpdatesSurfaceProps } from './overlay/updates'
// MD-01
import { MEDIA_SURFACES, type MediaSurfaceProps } from './overlay/media'
// TR-11
import { TRANSLATE_SURFACES, type TranslateSurfaceProps } from './overlay/translate'
// Atelier.server's bar
import { PACKS_SURFACES, type PacksSurfaceProps } from './overlay/packs'

export type Rect = Bounds

export type OverlayTier = 'interactive' | 'passive'

// Rects are in chrome CSS px; tab rects are relative to the tab's pane.
export type SurfaceAnchor =
  | { kind: 'window'; rect: Rect }
  | { kind: 'tab'; tabId: string; rect: Rect | null }
  | { kind: 'point'; x: number; y: number }

export interface SurfacePolicy {
  tier: OverlayTier
  size: 'fixed' | 'fill-window' | 'fill-tab'
  outsideClick: 'close' | 'ignore'
  blocksPage: boolean
  onTabSwitch: 'close' | 'follow' | 'stay' | 'hide-until-return'
  onScroll?: 'follow' | 'close'
  layer: 'modal' | 'menu' | 'hint'
  focus: boolean
  exitMs: number
  /**
   * A whole-window dialog layer. While it is open the chrome blurs
   * and washes itself (sidebar, toolbar, chat panel), and the showing pages
   * are swapped for stills the chrome draws under the same blur.
   */
  veil?: boolean
}

export type OverlayDismissReason = 'escape' | 'outside' | 'tab-switch' | 'closed' | 'replaced' | 'crashed' | 'timeout'

export type OverlayResult = { instanceId: string; value: unknown } | { instanceId: string; dismissed: OverlayDismissReason }

/** Which renderer a ui-preload webContents is; the preload reads it from the URL hash. */
export type UiRole = 'chrome' | 'overlay-interactive' | 'overlay-passive' | 'popup-strip' | 'ghost'

export const SURFACE_IDS = [
  ...CORE_SURFACES,
  ...ADDRESS_SURFACES,
  ...TABS_SURFACES,
  ...SITES_SURFACES,
  ...MENUS_SURFACES,
  ...CHAT_SURFACES,
  ...SETTINGS_SURFACES,
  ...AUTOFILL_SURFACES,
  ...COMPOSER_SURFACES,
  ...FILES_SURFACES,
  ...EXTENSIONS_SURFACES,
  ...CONNECTORS_SURFACES,
  ...PROFILES_SURFACES,
  ...CHAT_POPOVER_SURFACES,
  ...ACTIVITY_SURFACES,
  ...SITE_SUGGESTION_SURFACES,
  ...WORKSPACE_SURFACES,
  ...DIAGNOSTICS_SURFACES,
  ...UPDATES_SURFACES,
  ...SYSTEM_SURFACES,
  // ── media hub surface ids ──
  ...MEDIA_SURFACES,
  // ── translate surface ids ──
  ...TRANSLATE_SURFACES,
  // ── packs surface ids ──
  ...PACKS_SURFACES,
] as const

export type SurfaceId = (typeof SURFACE_IDS)[number]

/** Each surface's props, keyed by id. Domains add theirs to this intersection. */
export type SurfacePropsMap = CoreSurfaceProps &
  AddressSurfaceProps &
  TabsSurfaceProps &
  SitesSurfaceProps &
  MenusSurfaceProps &
  ChatSurfaceProps &
  SettingsSurfaceProps &
  AutofillSurfaceProps &
  ComposerSurfaceProps &
  FilesSurfaceProps &
  ExtensionsSurfaceProps &
  ConnectorsSurfaceProps &
  ProfilesSurfaceProps &
  ChatPopoverSurfaceProps &
  ActivitySurfaceProps &
  SiteSuggestionSurfaceProps &
  WorkspaceSurfaceProps &
  DiagnosticsSurfaceProps &
  UpdatesSurfaceProps &
  SystemSurfaceProps &
  // media hub surface props
  MediaSurfaceProps &
  // translate surface props
  TranslateSurfaceProps &
  // packs surface props
  PacksSurfaceProps
// Append `& AutofillSurfaceProps` above

export type SurfaceProps<S extends SurfaceId> = S extends keyof SurfacePropsMap ? SurfacePropsMap[S] : Record<string, unknown>

/** The passive tier: click-through, never focused. Every other surface is interactive. */
export const PASSIVE_SURFACES: readonly SurfaceId[] = ['tooltip', 'fullscreen-notice', 'link-bubble', 'link-preview', 'page-progress', 'download-flight']

const KNOWN = new Set<string>(SURFACE_IDS)

export function isSurfaceId(value: unknown): value is SurfaceId {
  return typeof value === 'string' && KNOWN.has(value)
}

export function surfaceTier(surface: SurfaceId): OverlayTier {
  return PASSIVE_SURFACES.includes(surface) ? 'passive' : 'interactive'
}

/** What main sends an overlay renderer when it should mount a surface. */
export interface OverlayOpenMessage {
  instanceId: string
  surface: SurfaceId
  anchor: SurfaceAnchor
  props: unknown
  windowId: number
  // Main resolves tab anchors so renderers place surfaces in window CSS px
  /** The anchor as a window CSS rect (tab anchors resolved against the tab's pane); null while the tab has no pane. */
  rect?: Rect | null
  /** The window's content area in CSS px. */
  viewport?: Rect
  /** The tab the surface belongs to, if any. */
  tabId?: string | null
  /** Hidden until its tab returns (hide-until-return); the surface stays mounted. */
  hidden?: boolean
  /** A repeated message for an instance already mounted carries new props, anchor or viewport. */
  update?: boolean
}

/** Serialized props are capped so a surface can never ship a page's worth of data through IPC. */
export const OVERLAY_PROPS_MAX_BYTES = 256 * 1024
