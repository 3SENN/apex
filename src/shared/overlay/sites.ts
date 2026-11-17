/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The sites overlay surfaces: site info, prompts and the sharing bar, and the popup notice.
import type { CaptureState, DeviceEntry, DeviceKind, PairingStep, SitePermission } from '../sites'

export const SITES_SURFACES = ['site-info', 'permission-prompt', 'screen-picker', 'device-chooser', 'sharing-bar', 'popup-blocked', 'permission-chip'] as const

export type SitesSurfaceId = (typeof SITES_SURFACES)[number]

/** The permission prompt (OV-11). It resolves with PermissionPromptAnswer, or PermissionPromptDismissal on Esc. */
export interface PermissionPromptProps {
  requestId: string
  tabId: string
  origin: string
  host: string
  perms: SitePermission[]
  /** For external-app links: the app that would open, and the link's scheme. */
  app: string | null
  scheme: string | null
  /**
   * Which answer may be remembered: both, only an allow (external apps), only a
   * deny (MIDI, screen, files), or none (a private window).
   */
  remember: 'both' | 'allow' | 'deny' | null
  /** macOS has turned Atelier off for the camera, microphone or Location Services; the prompt says how to turn it back on. */
  systemBlocked: ('camera' | 'microphone' | 'location')[]
  /** A cross-origin frame asks: its host, named under the site the answer is kept for. */
  embedded?: string | null
}

export interface PermissionPromptAnswer {
  allow: boolean
  remember: boolean
}

/**
 * Esc on the prompt: the person put it away without deciding. Distinct from a
 * Don't allow, so main can count dismissals (Chrome's embargo) rather than
 * store a refusal. It has no `allow`, so a reader that only knows answers sees
 * nothing decided.
 */
export interface PermissionPromptDismissal {
  dismissed: true
}

/** The screen-share picker (OV-14). It loads sources through `sites.screenSources(requestId)` and resolves with ScreenPickerAnswer. */
export interface ScreenPickerProps {
  requestId: string
  host: string
  /** The page asked for audio too, so the tab-audio toggle shows. */
  audio: boolean
}

export interface ScreenPickerAnswer {
  sourceId: string
  audio: boolean
}

/** The device chooser (OV-15). Main updates `devices` live; pairing steps reuse the same surface. */
export interface DeviceChooserProps {
  requestId: string
  kind: DeviceKind
  host: string
  devices: DeviceEntry[]
  /** Still looking for devices (Bluetooth scans keep reporting). */
  scanning: boolean
  /** Set when the surface asks for a Bluetooth pairing step instead of a choice. */
  pairing: PairingStep | null
  /** The device being paired. */
  pairingName: string | null
  /** Whether "Remember for this site" can show (never in a private window). */
  canRemember: boolean
}

export type DeviceChooserAnswer = { deviceId: string; remember: boolean } | { confirmed: boolean; pin?: string }

/** The sharing bar under a capturing tab: what is live, with stop and revoke. */
export interface SharingBarProps {
  tabId: string
  host: string
  origin: string
  capture: CaptureState
  /** The title of the tab being shared, when a tab is. */
  sharedTab: string | null
}

/** Each sites surface's props. */
export type SitesSurfaceProps = {
  'site-info': { tabId: string }
  'permission-prompt': PermissionPromptProps
  'screen-picker': ScreenPickerProps
  'device-chooser': DeviceChooserProps
  'sharing-bar': SharingBarProps
  /** Page notices (SS-07): blocked pop-ups, redirects and downloads, and an unresponsive page. Resolves with a PageNoticeAnswer. */
  'popup-blocked': import('../safety').PageNoticeProps
  // ── the permission chip ──
  'permission-chip': PermissionChipProps
}

// ── permissions pass: chip props ──
/**
 * The popover under an address bar permission chip: a held-back notification
 * request to answer, or a permission macOS has turned off for Atelier. It
 * resolves with PermissionChipAnswer; the chrome acts on it.
 */
export interface PermissionChipProps {
  tabId: string
  kind: 'quiet' | 'macos'
  origin: string
  perms: SitePermission[]
}

export type PermissionChipAnswer = { action: 'allow' | 'block' | 'open-settings' | 'reload' }
