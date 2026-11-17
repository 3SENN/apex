/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PANEL_WIDTH, SIDEBAR_WIDTH } from '@shared/ipc'
import { DEFAULT_SETTINGS, SettingsStore, WindowStateStore, applySettingsPatch, migrateSettings, settingsPatchSchema } from '../src/main/settings'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'apex-settings-'))

describe('settings migration', () => {
  it('starts from the defaults: sidebar layout, system theme, companion accent', () => {
    const settings = migrateSettings(undefined)
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(settings.layout).toBe('sidebar')
    expect(settings.theme).toBe('system')
    expect(settings.accent).toBe('companion')
    expect(settings.showFullUrls).toBe(false)
    expect(settings.sidebarWidth).toBe(SIDEBAR_WIDTH.default)
  })

  it('turns the old bookmarks bar boolean into a mode', () => {
    expect(migrateSettings({ showBookmarksBar: true }).bookmarksBar).toBe('always')
    expect(migrateSettings({ showBookmarksBar: false }).bookmarksBar).toBe('never')
    // A saved mode wins over a leftover boolean.
    expect(migrateSettings({ showBookmarksBar: false, bookmarksBar: 'newtab' }).bookmarksBar).toBe('newtab')
    expect(migrateSettings({ showBookmarksBar: false })).not.toHaveProperty('showBookmarksBar')
  })

  it('moves meetings from before Record audio only to one language once, keeping a saved Keep audio choice', () => {
    expect(DEFAULT_SETTINGS.transcription).toMatchObject({ recordAudio: true, recordOnly: false, secondaryLocale: 'none' })
    const before = migrateSettings({ transcription: { recordAudio: false, secondaryLocale: null } }).transcription
    expect(before).toMatchObject({ recordAudio: false, recordOnly: false, secondaryLocale: 'none' })
    // A second language picked by hand stays.
    expect(migrateSettings({ transcription: { recordAudio: false, secondaryLocale: 'en-GB' } }).transcription.secondaryLocale).toBe('en-GB')
    // Saved since: what's there is what was chosen.
    const after = migrateSettings({ transcription: { recordAudio: false, recordOnly: false, secondaryLocale: null } }).transcription
    expect(after).toMatchObject({ recordAudio: false, secondaryLocale: null })
  })

  it('falls back field by field, with unknown layouts going to the sidebar', () => {
    const settings = migrateSettings({ layout: 'floating', theme: 'dark', searchEngine: 'altavista', model: 'claude-sonnet-5-5', accent: 'plaid' })
    expect(settings.layout).toBe('sidebar')
    expect(settings.theme).toBe('dark')
    expect(settings.searchEngine).toBe(DEFAULT_SETTINGS.searchEngine)
    expect(settings.model).toBe('claude-sonnet-5-5')
    expect(settings.accent).toBe('companion')
    expect(migrateSettings({ layout: 'horizontal' }).layout).toBe('horizontal')
  })

  it('clamps out-of-range widths instead of dropping them', () => {
    expect(migrateSettings({ sidebarWidth: 900, panelWidth: 10 })).toMatchObject({ sidebarWidth: SIDEBAR_WIDTH.max, panelWidth: PANEL_WIDTH.min })
    expect(migrateSettings({ sidebarWidth: 301.6 }).sidebarWidth).toBe(302)
    expect(migrateSettings({ sidebarWidth: 'wide' }).sidebarWidth).toBe(SIDEBAR_WIDTH.default)
  })

  it('keeps valid sidebar options one by one', () => {
    const settings = migrateSettings({ sidebar: { tabSort: 'recent', chatSort: 'sideways', destinations: { skills: false, meetings: true }, chatRows: null } })
    expect(settings.sidebar.tabSort).toBe('recent')
    expect(settings.sidebar.chatSort).toBe('recent')
    expect(settings.sidebar.chatRows).toBeNull()
    // Meetings became a destination, so a saved meetings flag now counts; later destinations add theirs.
    expect(settings.sidebar.destinations).toMatchObject({ chats: true, routines: true, skills: false, connectors: false, meetings: true })
    // Defaults are never shared between results.
    expect(migrateSettings({}).sidebar.destinations.skills).toBe(true)
  })

  it('accepts only small image data URLs as an avatar', () => {
    expect(migrateSettings({ userAvatar: 'data:image/png;base64,iVBORw0KGgo=' }).userAvatar).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(migrateSettings({ userAvatar: 'https://example.com/me.png' }).userAvatar).toBeNull()
    expect(migrateSettings({ userAvatar: `data:image/png;base64,${'A'.repeat(400_000)}` }).userAvatar).toBeNull()
  })
})

describe('settings patches', () => {
  it('merges sidebar options and destinations field by field', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, settingsPatchSchema.parse({ sidebar: { showLastUsed: true, destinations: { routines: false } } }))
    expect(next.sidebar).toEqual({ ...DEFAULT_SETTINGS.sidebar, showLastUsed: true, destinations: { ...DEFAULT_SETTINGS.sidebar.destinations, routines: false } })
    expect(DEFAULT_SETTINGS.sidebar.destinations.routines).toBe(true)
  })

  it('rejects unknown and invalid fields', () => {
    expect(settingsPatchSchema.safeParse({ showBookmarksBar: true }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ layout: 'floating' }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ sidebar: { width: 300 } }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ sidebarWidth: 100 }).success).toBe(false)
    expect(settingsPatchSchema.safeParse({ theme: 'light', accent: 'ocean', bookmarksBar: 'newtab', panelDock: 'right' }).success).toBe(true)
  })

  it('persists updates and reports the previous value', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ showBookmarksBar: false, theme: 'dark' }))
    const store = new SettingsStore(dir)
    expect(store.get().bookmarksBar).toBe('never')
    const seen: string[] = []
    store.on('changed', (next, previous) => seen.push(`${previous.theme}->${next.theme}`))
    store.update({ theme: 'light' })
    expect(seen).toEqual(['dark->light'])
    // Theme is a profile key now, saved in the default profile's file rather than settings.json.
    const saved = JSON.parse(readFileSync(join(dir, 'profile-settings.json'), 'utf8')) as Record<string, unknown>
    expect(saved.theme).toBe('light')
    expect(saved).not.toHaveProperty('showBookmarksBar')
    // settings.json mirrors the default profile's values for an older Apex.
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).theme).toBe('light')
    expect(new SettingsStore(dir).get().theme).toBe('light')
  })
})

describe('window state', () => {
  it('remembers the sidebar and name per window', () => {
    const dir = tempDir()
    const store = new WindowStateStore(dir)
    expect(store.get('main')).toEqual({ sidebarOpen: true, name: null })
    store.update('main', { sidebarOpen: false })
    store.update('second', { name: '  Research  ' })
    const reloaded = new WindowStateStore(dir)
    expect(reloaded.get('main')).toEqual({ sidebarOpen: false, name: null })
    expect(reloaded.get('second')).toEqual({ sidebarOpen: true, name: 'Research' })
  })

  it('ignores broken entries', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'window-state.json'), JSON.stringify({ windows: { main: { sidebarOpen: 'yes' }, other: { sidebarOpen: false, name: null } } }))
    const store = new WindowStateStore(dir)
    expect(store.get('main')).toEqual({ sidebarOpen: true, name: null })
    expect(store.get('other').sidebarOpen).toBe(false)
  })
})

describe('settings scopes', () => {
  const read = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

  it('routes each key of a patch to its scope', () => {
    const dir = tempDir()
    const store = new SettingsStore(dir)
    store.createProfile('work1234', { profileHue: 'moss' })
    store.updateFor('work1234', { theme: 'dark', model: 'claude-sonnet-5-5', sidebar: { chatSort: 'manual' } })
    expect(store.getFor('work1234')).toMatchObject({ theme: 'dark', model: 'claude-sonnet-5-5', profileHue: 'moss' })
    expect(store.getFor('work1234').sidebar.chatSort).toBe('manual')
    // The app key reached the default profile; the profile keys did not.
    expect(store.get()).toMatchObject({ theme: 'system', model: 'claude-sonnet-5-5', profileHue: 'stone' })
    expect(store.get().sidebar.chatSort).toBe('recent')
    const app = read(join(dir, 'settings.json'))
    const work = read(join(dir, 'profiles', 'work1234', 'profile-settings.json'))
    expect(app.model).toBe('claude-sonnet-5-5')
    // The mirror in settings.json is the default profile's, never another profile's.
    expect(app.theme).toBe('system')
    expect(work.theme).toBe('dark')
    expect(work).not.toHaveProperty('model')
    // A fresh store reads both files back.
    expect(new SettingsStore(dir).getFor('work1234')).toMatchObject({ theme: 'dark', model: 'claude-sonnet-5-5' })
  })

  it('tells every profile about app changes and only the owner about profile changes', () => {
    const store = new SettingsStore(tempDir())
    store.createProfile('home1234')
    const seen: string[] = []
    store.on('profileChanged', (id, next, previous) => seen.push(`${id}:${previous.model === next.model ? 'same' : 'model'}:${previous.theme}->${next.theme}`))
    let defaultEvents = 0
    store.on('changed', () => defaultEvents++)
    store.updateFor('home1234', { theme: 'dark' })
    expect(seen).toEqual(['home1234:same:system->dark'])
    expect(defaultEvents).toBe(0)
    seen.length = 0
    store.updateFor('home1234', { model: 'claude-haiku-5-5' })
    expect(seen.sort()).toEqual(['default:model:system->system', 'home1234:model:dark->dark'])
    expect(defaultEvents).toBe(1)
  })

  it('gives each window a view with its profile', () => {
    const store = new SettingsStore(tempDir())
    expect(store.view().profile).toMatchObject({ id: 'default', isDefault: true, partition: 'persist:apex-web' })
    store.setProfileResolver((id) => ({ id, name: 'Work', hue: 'tide', createdAt: 1, partition: `persist:apex-profile-${id}`, isDefault: false }))
    expect(store.viewFor('work1234').profile).toMatchObject({ name: 'Work', partition: 'persist:apex-profile-work1234' })
    expect(store.viewFor('work1234')).toHaveProperty('hasApiKey')
  })

  it('forgets a deleted profile and never the default one', () => {
    const store = new SettingsStore(tempDir())
    store.createProfile('gone1234', { theme: 'dark' })
    store.forgetProfile('gone1234')
    expect(store.getFor('gone1234').theme).toBe('system')
    store.update({ theme: 'light' })
    store.forgetProfile('default')
    expect(store.get().theme).toBe('light')
  })
})
