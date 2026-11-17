/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// chrome.privacy's browser settings, the part Apex has: password
// saving, and address and card autofill. A setting is a ChromeSetting
// (get/set/clear/onChange) with Chrome's levels of control. Extensions may
// control password saving: a password manager such as Apple's iCloud
// Passwords turns it off so the browser's own offers step aside. Address and
// card autofill stay Apex's to decide, so they are not controllable, and an
// extension's attempt to turn them off is refused the way Chrome refuses a
// setting held by policy.

import { BRAND_NAME } from '@shared/branding'
export const PRIVACY_SETTINGS = ['services.passwordSavingEnabled', 'services.autofillAddressEnabled', 'services.autofillCreditCardEnabled', 'services.autofillEnabled'] as const

export type PrivacyKey = (typeof PRIVACY_SETTINGS)[number]

export const CONTROLLABLE: ReadonlySet<PrivacyKey> = new Set<PrivacyKey>(['services.passwordSavingEnabled'])

export type LevelOfControl = 'not_controllable' | 'controlled_by_other_extensions' | 'controllable_by_this_extension' | 'controlled_by_this_extension'

/** One extension's hold on a setting. Only running (enabled and loaded) extensions count. */
export interface SettingHold {
  extensionId: string
  installedAt: number
  value: unknown
}

export interface SettingDetails {
  value: unknown
  levelOfControl: LevelOfControl
  incognitoSpecific?: boolean
}

export function isPrivacyKey(key: string): key is PrivacyKey {
  return (PRIVACY_SETTINGS as readonly string[]).includes(key)
}

/** Chrome's precedence: of the extensions holding a setting, the most recently installed one wins. */
export function winningHold(holds: readonly SettingHold[]): SettingHold | null {
  let best: SettingHold | null = null
  for (const h of holds) if (!best || h.installedAt > best.installedAt || (h.installedAt === best.installedAt && h.extensionId > best.extensionId)) best = h
  return best
}

/** What get() answers one extension: the effective value and how much say it has. */
export function settingDetails(key: PrivacyKey, apexValue: boolean, holds: readonly SettingHold[], self: { id: string; installedAt: number }): SettingDetails {
  if (!CONTROLLABLE.has(key)) return { value: apexValue, levelOfControl: 'not_controllable' }
  const win = winningHold(holds)
  if (!win) return { value: apexValue, levelOfControl: 'controllable_by_this_extension' }
  if (win.extensionId === self.id) return { value: win.value, levelOfControl: 'controlled_by_this_extension' }
  // A newer extension holds it: an older one can't take it over (Chrome's precedence).
  return { value: win.value, levelOfControl: self.installedAt > win.installedAt ? 'controllable_by_this_extension' : 'controlled_by_other_extensions' }
}

/** Checks a set() before it is stored; returns a Chrome-shaped error message, or null when it may be stored. */
export function checkSet(key: PrivacyKey, details: { value?: unknown; scope?: unknown }): string | null {
  if (details.scope !== undefined && details.scope !== 'regular') return `${BRAND_NAME} has no incognito windows, so only the regular scope can be set.`
  if (!CONTROLLABLE.has(key)) return `You cannot control the ${key.split('.').pop()} setting in ${BRAND_NAME}.`
  if (typeof details.value !== 'boolean') return `Invalid value for ${key.split('.').pop()}: expected a boolean.`
  return null
}
