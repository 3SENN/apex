/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DESTINATIONS } from '@shared/url'
import { NESTED_GROUP_SCOPES, SETTINGS, settingScope, settingsOfScope, topLevelKeysOfScope, type SettingDef } from '@shared/settingsRegistry'
import { APP_KEYS, NESTED_SETTINGS_REGISTRY, DEFAULT_SETTINGS, PROFILE_KEYS, REGISTERED_DESTINATIONS } from '../src/main/settings'

const defs = { ...SETTINGS, ...NESTED_SETTINGS_REGISTRY } as Record<string, SettingDef<unknown>>

/** The value a registered key names inside Settings (dotted keys walk into nested objects). */
function valueAt(path: string): unknown {
  return path.split('.').reduce<unknown>((at, part) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[part] : undefined), DEFAULT_SETTINGS)
}

describe('settings registry (ST-06)', () => {
  it('registers every Settings key exactly once', () => {
    const shared = Object.keys(SETTINGS)
    const b = Object.keys(NESTED_SETTINGS_REGISTRY)
    expect(shared.filter((k) => b.includes(k))).toEqual([])
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key === 'sidebar') continue
      expect(Object.hasOwn(defs, key), `${key} is not registered`).toBe(true)
    }
    // The sidebar is registered leaf by leaf, every destination included.
    for (const leaf of Object.keys(DEFAULT_SETTINGS.sidebar).filter((k) => k !== 'destinations')) expect(shared, leaf).toContain(`sidebar.${leaf}`)
    expect([...REGISTERED_DESTINATIONS].sort()).toEqual([...DESTINATIONS].sort())
    expect(Object.hasOwn(defs, 'sidebar')).toBe(false)
  })

  it('names only real settings, each with a default its schema accepts', () => {
    for (const [key, def] of Object.entries(defs)) {
      expect(def.key).toBe(key)
      expect(valueAt(key), `${key} is not a Settings path`).not.toBeUndefined()
      expect(def.schema.safeParse(def.default).success, `${key}'s default`).toBe(true)
      expect(valueAt(key)).toEqual(def.default)
    }
  })

  it('puts each key in the scope the plan gives it', () => {
    for (const key of ['model', 'effort', 'engine', 'webTools', 'memory', 'documents', 'onboarded', 'userName', 'uiZoom', 'density', 'fontSize', 'autoPictureInPicture', 'downloadDir', 'warnBeforeQuit', 'notifications', 'proxy', 'keepAwake', 'panelWidth', 'panelDock', 'voice', 'transcription', 'meetingCards']) {
      expect(settingScope(key), key).toBe('app')
    }
    for (const key of ['theme', 'accent', 'profileHue', 'layout', 'searchEngine', 'customSearchEngines', 'adblock', 'languages', 'blockThirdPartyCookies', 'globalPrivacyControl', 'clearOnExit', 'popupBlocking', 'bookmarksBar', 'sidebar', 'showFullUrls', 'sidebarWidth', 'autofill', 'sidebar.destinations.files']) {
      expect(settingScope(key), key).toBe('profile')
    }
    expect(settingScope('somethingNew')).toBe('app')
    expect(NESTED_GROUP_SCOPES.autofill).toBe('profile')
  })

  it('splits the top-level keys into two scopes with nothing left over', () => {
    const all = Object.keys(DEFAULT_SETTINGS).sort()
    expect([...APP_KEYS, ...PROFILE_KEYS].sort()).toEqual(all)
    expect(APP_KEYS.filter((k) => PROFILE_KEYS.includes(k))).toEqual([])
    expect(topLevelKeysOfScope('profile')).toContain('sidebar')
    expect(settingsOfScope('profile')).toContain('autofill')
    // A group's leaves all share one scope, so the group can move as a whole.
    expect(new Set(Object.keys(SETTINGS).filter((k) => k.startsWith('sidebar.')).map((k) => settingScope(k)))).toEqual(new Set(['profile']))
  })
})
