/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../src/main/settings'

// The first launch with profiles moves profile keys out of an older settings.json
// into the default profile's file, field by field (ST-06).

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'atelier-profile-migration-'))
const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

const AB_SETTINGS = {
  model: 'claude-sonnet-5-5',
  theme: 'dark',
  accent: 'plaid', // invalid: falls back on its own
  layout: 'horizontal',
  searchEngine: 'duckduckgo',
  adblock: false,
  profileHue: 'moss',
  sidebar: { chatSort: 'progress', destinations: { routines: false } },
  bookmarksBar: 'newtab',
  uiZoom: 0.9,
  fontSize: 99, // invalid
  voice: { holdToTalk: true },
  autofill: { offerLogins: false, cards: 'yes' }, // cards invalid: only that field falls back
  onboarded: true,
}

describe('profile settings migration', () => {
  it('moves profile keys into the default profile file and keeps app keys', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(AB_SETTINGS))
    writeFileSync(join(dir, 'anthropic-key.bin'), 'secret')
    const store = new SettingsStore(dir)
    const app = read(join(dir, 'settings.json'))
    const profile = read(join(dir, 'profile-settings.json'))
    expect(profile).toMatchObject({ theme: 'dark', layout: 'horizontal', searchEngine: 'duckduckgo', adblock: false, profileHue: 'moss', bookmarksBar: 'newtab', accent: DEFAULT_SETTINGS.accent })
    expect((profile.sidebar as { chatSort: string }).chatSort).toBe('progress')
    expect(profile.autofill).toMatchObject({ offerLogins: false, cards: DEFAULT_SETTINGS.autofill.cards })
    for (const key of ['model', 'uiZoom', 'voice', 'onboarded', 'fontSize']) expect(profile).not.toHaveProperty(key)
    expect(app).toMatchObject({ model: 'claude-sonnet-5-5', uiZoom: 0.9, onboarded: true, fontSize: DEFAULT_SETTINGS.fontSize })
    expect((app.voice as { holdToTalk: boolean }).holdToTalk).toBe(true)
    // settings.json keeps a copy of the default profile's values for an older Atelier; this build never reads it back.
    expect(app).toMatchObject({ theme: 'dark', profileHue: 'moss' })
    // Nothing changes for the person: the same values, read through either file.
    expect(store.get()).toMatchObject({ theme: 'dark', model: 'claude-sonnet-5-5', layout: 'horizontal', profileHue: 'moss' })
    expect(store.get().sidebar.destinations.routines).toBe(false)
    // The key stays in its encrypted file.
    expect(readFileSync(join(dir, 'anthropic-key.bin'), 'utf8')).toBe('secret')
  })

  it('runs once: a later launch reads the profile file, not the old keys', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(AB_SETTINGS))
    new SettingsStore(dir).update({ theme: 'light' })
    // A stray profile key in settings.json (an older Atelier wrote it) no longer wins.
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...read(join(dir, 'settings.json')), theme: 'dark' }))
    expect(new SettingsStore(dir).get().theme).toBe('light')
  })

  it('falls back field by field in each scope when the profile file is damaged', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'gpt', effort: 'low' }))
    writeFileSync(join(dir, 'profile-settings.json'), JSON.stringify({ theme: 'neon', layout: 'horizontal', sidebar: { tabSort: 'recent', chatRows: -4 } }))
    const settings = new SettingsStore(dir).get()
    expect(settings).toMatchObject({ model: DEFAULT_SETTINGS.model, effort: 'low', theme: DEFAULT_SETTINGS.theme, layout: 'horizontal' })
    expect(settings.sidebar).toMatchObject({ tabSort: 'recent', chatRows: DEFAULT_SETTINGS.sidebar.chatRows })
  })

  it('starts fresh installs without writing anything', () => {
    const dir = tempDir()
    expect(new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(join(dir, 'profile-settings.json'))).toBe(false)
  })

  it('leaves a newer settings.json in place after copying it aside', () => {
    const dir = tempDir()
    const saved = JSON.stringify({ formatVersion: 99, theme: 'dark', model: 'claude-haiku-5-5' })
    writeFileSync(join(dir, 'settings.json'), saved)
    const store = new SettingsStore(dir)
    expect(store.get()).toMatchObject({ theme: 'dark', model: 'claude-haiku-5-5' })
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(saved)
    expect(read(join(dir, 'profile-settings.json')).theme).toBe('dark')
  })
})
