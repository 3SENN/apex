/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Recommended shelf on Settings › Extensions and in the welcome flow
// (ST-40 R, ON-03 R): a short, curated list of widely trusted Chrome Web
// Store extensions, each with one line. "Add" installs
// from the store through Apex's verified path; Apple's password extension
// on macOS points to the Passwords page's built-in switch instead.
import type { MessageKey } from './i18n/core'
import { EXTENSION_ID } from './extensions'
// Apple's iCloud Passwords extension: the Passwords page's switch sets it up.
import { APPLE_PASSWORDS_EXTENSION_ID } from './applePasswords'

export type RecommendedCategory = 'passwords' | 'writing' | 'language' | 'reading' | 'privacy' | 'offline'

export interface RecommendedExtension {
  /** The Chrome Web Store id. */
  id: string
  /** The product's own name (a proper noun, the same in every language). */
  name: string
  /** One line on why. */
  reason: MessageKey
  category: RecommendedCategory
  /** 'store' adds from the Web Store; 'passwords-switch' opens Settings › Passwords, where Apex sets it up. */
  action: 'store' | 'passwords-switch'
  /** Only shown on these platforms; every platform when absent. */
  platforms?: readonly string[]
}

export const PASSWORDS_SETTINGS_URL = 'apex://settings/passwords'

export const RECOMMENDED_EXTENSIONS: readonly RecommendedExtension[] = [
  { id: APPLE_PASSWORDS_EXTENSION_ID, name: 'iCloud Passwords', reason: 'extImport.rec.reason.apple', category: 'passwords', action: 'passwords-switch', platforms: ['darwin'] },
  { id: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa', name: '1Password', reason: 'extImport.rec.reason.onePassword', category: 'passwords', action: 'store' },
  { id: 'nngceckbapebfimnlniiiahkandclblb', name: 'Bitwarden', reason: 'extImport.rec.reason.bitwarden', category: 'passwords', action: 'store' },
  { id: 'kbfnbcaeplbcioakkpcpgfkobkghlhen', name: 'Grammarly', reason: 'extImport.rec.reason.grammarly', category: 'writing', action: 'store' },
  { id: 'aapbdbdomjkkjkaonfhkkikfgjllcleb', name: 'Google Translate', reason: 'extImport.rec.reason.translate', category: 'language', action: 'store' },
  { id: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', name: 'Dark Reader', reason: 'extImport.rec.reason.darkReader', category: 'reading', action: 'store' },
  { id: 'ddkjiahejlhfcafbddmgiahcphecmpfh', name: 'uBlock Origin Lite', reason: 'extImport.rec.reason.ublock', category: 'privacy', action: 'store' },
  { id: 'pkehgijcmpdhfbdbbnkijodmdjhbjlgp', name: 'Privacy Badger', reason: 'extImport.rec.reason.privacyBadger', category: 'privacy', action: 'store' },
  { id: 'ghbmnnjooekpmoecnnnilnnbdlolhkhi', name: 'Google Docs Offline', reason: 'extImport.rec.reason.docsOffline', category: 'offline', action: 'store' },
]

export const RECOMMENDED_CATEGORY_LABELS: Readonly<Record<RecommendedCategory, MessageKey>> = {
  passwords: 'extImport.rec.category.passwords',
  writing: 'extImport.rec.category.writing',
  language: 'extImport.rec.category.language',
  reading: 'extImport.rec.category.reading',
  privacy: 'extImport.rec.category.privacy',
  offline: 'extImport.rec.category.offline',
}

/** The shelf for this platform, in the curated order. */
export function recommendedFor(platform: string): RecommendedExtension[] {
  return RECOMMENDED_EXTENSIONS.filter((r) => !r.platforms || r.platforms.includes(platform))
}

export type RecommendedState = 'add' | 'installed' | 'adding' | 'setup'

/** What a shelf row's button shows: Installed once it is here, Set up for the built-in switch, else Add (or Adding… while it runs). */
export function recommendedState(rec: Pick<RecommendedExtension, 'id' | 'action'>, installed: ReadonlySet<string>, adding: ReadonlySet<string>): RecommendedState {
  if (installed.has(rec.id)) return 'installed'
  if (rec.action === 'passwords-switch') return 'setup'
  return adding.has(rec.id) ? 'adding' : 'add'
}

/** True when every id on the shelf is a well-formed Web Store id (a test guards the list). */
export function recommendedIdsValid(list: readonly Pick<RecommendedExtension, 'id'>[] = RECOMMENDED_EXTENSIONS): boolean {
  return list.every((r) => EXTENSION_ID.test(r.id)) && new Set(list.map((r) => r.id)).size === list.length
}
