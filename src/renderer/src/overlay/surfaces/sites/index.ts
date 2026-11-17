/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SurfaceMap } from '../../types'
import { z } from 'zod'
import type { DeviceChooserProps, PermissionPromptProps, ScreenPickerProps, SharingBarProps, SitesSurfaceProps } from '@shared/overlay/sites'
import { SITE_PERMISSIONS } from '@shared/sites'
import { MENU_POLICY, type SurfaceModule } from '../../types'
import { DeviceChooser } from './DeviceChooser'
import { PermissionPrompt } from './PermissionPrompt'
import { ScreenPicker } from './ScreenPicker'
import { SharingBar } from './SharingBar'
import { SiteInfoPopover } from './SiteInfo'
import './sites.css'
import { popupBlockedSurface } from './popup-blocked'
import type { PermissionChipProps } from '@shared/overlay/sites'
import { PermissionChipPopover } from './PermissionChipPopover'

// Site surfaces (site info, prompts, pickers, sharing bar, popup notice).

// SH-37, OV-11, OV-14, OV-15
const id = z.string().min(1).max(128)
const host = z.string().max(253)
const origin = z.string().max(2048)
const perm = z.enum(SITE_PERMISSIONS as unknown as [string, ...string[]])
const captureState = z.object({ camera: z.boolean(), microphone: z.boolean(), screen: z.boolean() }).strict()
const device = z.object({ id: z.string().min(1).max(512), name: z.string().max(256), detail: z.string().max(256).nullable() }).strict()

const siteInfo: SurfaceModule<SitesSurfaceProps['site-info']> = {
  component: SiteInfoPopover,
  props: z.object({ tabId: id }).strict(),
  // Esc or a click outside closes it; another tab closes it too.
  policy: MENU_POLICY,
  placement: 'below',
  gap: 6,
}

const permissionPrompt: SurfaceModule<PermissionPromptProps> = {
  component: PermissionPrompt,
  props: z
    .object({
      requestId: id,
      tabId: id,
      origin,
      host,
      perms: z.array(perm).min(1).max(SITE_PERMISSIONS.length),
      app: z.string().max(256).nullable(),
      scheme: z.string().max(32).nullable(),
      remember: z.enum(['both', 'allow', 'deny']).nullable(),
      systemBlocked: z.array(z.enum(['camera', 'microphone', 'location'])).max(3),
      embedded: host.nullable().optional(),
    })
    .strict() as unknown as z.ZodType<PermissionPromptProps>,
  // Tied to its tab: hidden while another tab shows, back when it returns. A click on the page leaves it open.
  // It takes focus so Esc, Tab and screen readers reach it, but the focus lands on the card, never on an answer.
  policy: { tier: 'interactive', size: 'fixed', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'hide-until-return', layer: 'menu', focus: true, exitMs: 120 },
  placement: 'below',
  gap: 6,
}

// The pickers are modal over their tab's pane only: the rest of the window stays usable.
const TAB_MODAL = { tier: 'interactive', size: 'fill-tab', outsideClick: 'ignore', blocksPage: true, onTabSwitch: 'hide-until-return', layer: 'modal', focus: true, exitMs: 160 } as const

const screenPicker: SurfaceModule<ScreenPickerProps> = {
  component: ScreenPicker,
  props: z.object({ requestId: id, host, audio: z.boolean() }).strict(),
  policy: TAB_MODAL,
}

const deviceChooser: SurfaceModule<DeviceChooserProps> = {
  component: DeviceChooser,
  props: z
    .object({
      requestId: id,
      kind: z.enum(['hid', 'usb', 'serial', 'bluetooth']),
      host,
      devices: z.array(device).max(500),
      scanning: z.boolean(),
      pairing: z
        .discriminatedUnion('kind', [z.object({ kind: z.literal('confirm') }).strict(), z.object({ kind: z.literal('confirm-pin'), pin: z.string().min(1).max(16) }).strict(), z.object({ kind: z.literal('provide-pin') }).strict()])
        .nullable(),
      pairingName: z.string().max(256).nullable(),
      canRemember: z.boolean(),
    })
    .strict(),
  policy: TAB_MODAL,
}

const sharingBar: SurfaceModule<SharingBarProps> = {
  component: SharingBar,
  props: z.object({ tabId: id, host, origin, capture: captureState, sharedTab: z.string().max(512).nullable() }).strict(),
  // Over the top of the capturing tab's pane; the tab row's icons carry the state while another tab shows.
  policy: { tier: 'interactive', size: 'fixed', outsideClick: 'ignore', blocksPage: false, onTabSwitch: 'hide-until-return', layer: 'hint', focus: false, exitMs: 120 },
  placement: 'top-center',
  gap: 8,
}

// ── permissions pass surfaces ── (the address bar chip's popover: a quiet notification request, or macOS blocking)
const permissionChip: SurfaceModule<PermissionChipProps> = {
  component: PermissionChipPopover,
  props: z
    .object({ tabId: id, kind: z.enum(['quiet', 'macos']), origin, perms: z.array(perm).min(1).max(SITE_PERMISSIONS.length) })
    .strict() as unknown as z.ZodType<PermissionChipProps>,
  // Opened by a click on the chip: Esc, a click outside or another tab closes it.
  policy: MENU_POLICY,
  placement: 'below',
  gap: 6,
}

export const SITES_SURFACE_MAP: SurfaceMap = {
  'site-info': siteInfo as unknown as SurfaceModule<never>,
  'permission-prompt': permissionPrompt as unknown as SurfaceModule<never>,
  'screen-picker': screenPicker as unknown as SurfaceModule<never>,
  'device-chooser': deviceChooser as unknown as SurfaceModule<never>,
  'sharing-bar': sharingBar as unknown as SurfaceModule<never>,
  'popup-blocked': popupBlockedSurface as unknown as SurfaceModule<never>,
  // ── permissions pass map ──
  'permission-chip': permissionChip as unknown as SurfaceModule<never>,
}
