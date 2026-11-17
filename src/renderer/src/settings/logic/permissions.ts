/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Privacy › Permissions: the line under each Mac row, each
// website permission's default (Ask first or Block, from the
// sitePermissionDefaults setting) and the websites with their own answer for
// it. Pure, so it is unit-tested (tests/systemPermissions.test.ts).
import type { MessageKey } from '@shared/i18n/core'
import { DEVICE_PERMISSIONS } from '@shared/permissions'
import type { GrantedDevice, SitePermission, SiteSettingsEntry } from '@shared/sites'
import type { SystemRow } from '@shared/systemPermissions'
import { hostOf } from '../../overlay/surfaces/sites/logic'

/** Privacy's permissions view (SETTINGS_ALIAS_PARENTS.access). */
export const PERMISSIONS_URL = 'apex://settings/access'

/** The address, landing on a row's anchor (mac-microphone, site-notifications, …) when given. */
export function permissionsUrl(highlight?: string): string {
  return highlight ? `${PERMISSIONS_URL}?highlight=${encodeURIComponent(highlight)}` : PERMISSIONS_URL
}

/** What a Mac row's state means and what happens next; `opened` once you went to System Settings from it. */
export function systemRowNote(row: SystemRow, opened: boolean): MessageKey | null {
  if (opened && row.action === 'open-settings') return 'permissionsHub.note.waiting'
  switch (row.state) {
    case 'granted':
      return row.kind === 'full-disk' ? 'permissionsHub.note.fullDiskGranted' : null
    case 'denied':
      return 'permissionsHub.note.denied'
    case 'not-determined':
      return row.kind === 'location' ? 'permissionsHub.note.locationAsk' : 'permissionsHub.note.notDetermined'
    case 'relaunch':
      return 'permissionsHub.note.relaunch'
    case 'restricted':
      return 'permissionsHub.note.restricted'
    case 'unknown':
      return row.kind === 'notifications' ? 'permissionsHub.note.notificationsUnknown' : 'permissionsHub.note.unknown'
    case 'managed':
      return 'permissionsHub.note.managed'
    case 'unavailable':
      return 'permissionsHub.note.unavailable'
  }
}

export type SiteDefault = 'ask' | 'block'
export type SiteDefaults = Partial<Record<SitePermission, SiteDefault>>

/** A permission missing from the setting asks. */
export function defaultFor(defaults: SiteDefaults | undefined, perm: SitePermission): SiteDefault {
  return defaults?.[perm] === 'block' ? 'block' : 'ask'
}

/** The setting with one default changed; asking is the absence of a value, so 'ask' removes it. */
export function withDefault(defaults: SiteDefaults | undefined, perm: SitePermission, value: SiteDefault): SiteDefaults {
  const next: SiteDefaults = { ...defaults }
  if (value === 'ask') delete next[perm]
  else next[perm] = value
  return next
}

export interface PermissionSite {
  origin: string
  host: string
  decision: 'allow' | 'block'
}

export interface PermissionDevice {
  origin: string
  host: string
  device: GrantedDevice
}

export interface PermissionSites {
  /** Websites with a stored allow or block, by host. */
  sites: PermissionSite[]
  /** For device kinds (HID, USB, serial, Bluetooth): the devices each website may use. */
  devices: PermissionDevice[]
  allowed: number
  blocked: number
}

/** Every website with its own answer for `perm`. */
export function sitesFor(entries: readonly SiteSettingsEntry[], perm: SitePermission): PermissionSites {
  const sites: PermissionSite[] = []
  const devices: PermissionDevice[] = []
  for (const { origin, settings } of entries) {
    const host = hostOf(origin)
    const decision = settings.permissions[perm]
    if (decision === 'allow' || decision === 'block') sites.push({ origin, host, decision })
    if (DEVICE_PERMISSIONS.has(perm)) for (const device of settings.devices) if (device.kind === perm) devices.push({ origin, host, device })
  }
  sites.sort((a, b) => a.host.localeCompare(b.host))
  devices.sort((a, b) => a.host.localeCompare(b.host) || a.device.name.localeCompare(b.device.name))
  return { sites, devices, allowed: sites.filter((s) => s.decision === 'allow').length, blocked: sites.filter((s) => s.decision === 'block').length }
}
