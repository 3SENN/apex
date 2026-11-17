/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, applySettingsPatch, migrateSettings, settingsPatchSchema } from '../src/main/settings'
import { builtAppRef, packAppRef, packPanelRef, parseAppRef, prunePins, showOf, sidebarLayout, webAppRef, withMove, withShow, type SidebarAppPin, type SidebarAppShow } from '../src/shared/sidebarApps'

const item = (ref: string, defaultShow: SidebarAppShow = 'hidden') => ({ ref, defaultShow })
const ITEMS = [item(webAppRef('mail')), item(webAppRef('figma')), item(packAppRef('acme.games', 'main'), 'row'), item(packPanelRef('acme.notes', 'side')), item(builtAppRef('tips'))]

describe('apps in the sidebar (AP-01)', () => {
  it('names every kind of app and reads the name back', () => {
    expect(parseAppRef(webAppRef('a'))).toEqual({ kind: 'web', id: 'a' })
    expect(parseAppRef(builtAppRef('b'))).toEqual({ kind: 'built', id: 'b' })
    expect(parseAppRef(packAppRef('com.acme.games', 'main'))).toEqual({ kind: 'pack-app', packId: 'com.acme.games', id: 'main' })
    expect(parseAppRef(packPanelRef('x.y', 'side'))).toEqual({ kind: 'pack-panel', packId: 'x.y', id: 'side' })
    expect(parseAppRef('tab:1')).toBeNull()
  })

  it('starts each app where it says, until the person chooses', () => {
    expect(sidebarLayout(ITEMS, [])).toEqual({ icons: [], rows: [ITEMS[2]] })
    const pins: SidebarAppPin[] = [{ ref: webAppRef('figma'), show: 'icon' }, { ref: packAppRef('acme.games', 'main'), show: 'hidden' }]
    expect(showOf(ITEMS[2]!, pins)).toBe('hidden')
    expect(sidebarLayout(ITEMS, pins)).toEqual({ icons: [ITEMS[1]], rows: [] })
  })

  it('keeps the person’s order, then apps that start in the sidebar', () => {
    let pins = withShow([], builtAppRef('tips'), 'row')
    pins = withShow(pins, webAppRef('mail'), 'icon')
    pins = withShow(pins, webAppRef('figma'), 'icon')
    const layout = sidebarLayout(ITEMS, pins)
    expect(layout.icons.map((i) => i.ref)).toEqual([webAppRef('mail'), webAppRef('figma')])
    expect(layout.rows.map((i) => i.ref)).toEqual([builtAppRef('tips'), packAppRef('acme.games', 'main')])
    // Choosing again moves it to the end of its group.
    expect(sidebarLayout(ITEMS, withShow(pins, webAppRef('mail'), 'icon')).icons.map((i) => i.ref)).toEqual([webAppRef('figma'), webAppRef('mail')])
  })

  it('reorders by dragging, and a drop on the strip makes an icon', () => {
    const pins: SidebarAppPin[] = [{ ref: webAppRef('mail'), show: 'icon' }, { ref: webAppRef('figma'), show: 'icon' }, { ref: builtAppRef('tips'), show: 'hidden' }]
    const shown = [...sidebarLayout(ITEMS, pins).icons.map((i) => ({ ref: i.ref, show: 'icon' as const })), ...sidebarLayout(ITEMS, pins).rows.map((i) => ({ ref: i.ref, show: 'row' as const }))]
    const swapped = withMove(pins, shown, webAppRef('figma'), webAppRef('mail'))
    expect(sidebarLayout(ITEMS, swapped).icons.map((i) => i.ref)).toEqual([webAppRef('figma'), webAppRef('mail')])
    // The pack's row, dragged to the end of the strip: now an icon with a pin of its own; the hidden choice stays.
    const iconised = withMove(pins, shown, packAppRef('acme.games', 'main'), null, 'icon')
    expect(sidebarLayout(ITEMS, iconised)).toEqual({ icons: [ITEMS[0], ITEMS[1], ITEMS[2]], rows: [] })
    expect(iconised.find((p) => p.ref === builtAppRef('tips'))?.show).toBe('hidden')
    expect(withMove(pins, shown, webAppRef('nope'), null)).toEqual(pins)
  })

  it('forgets apps that are gone', () => {
    const pins: SidebarAppPin[] = [{ ref: webAppRef('mail'), show: 'icon' }, { ref: webAppRef('gone'), show: 'row' }]
    expect(prunePins(pins, new Set(ITEMS.map((i) => i.ref)))).toEqual([pins[0]])
  })
})

describe('the sidebar.apps setting', () => {
  it('starts empty, takes the person’s choices and refuses anything else', () => {
    expect(DEFAULT_SETTINGS.sidebar.apps).toEqual([])
    const apps = [{ ref: webAppRef('mail'), show: 'icon' as const }]
    const patch = settingsPatchSchema.parse({ sidebar: { apps } })
    const next = applySettingsPatch(DEFAULT_SETTINGS, patch)
    expect(next.sidebar.apps).toEqual(apps)
    expect(next.sidebar.destinations).toEqual(DEFAULT_SETTINGS.sidebar.destinations)
    expect(settingsPatchSchema.safeParse({ sidebar: { apps: [{ ref: 'x', show: 'big' }] } }).success).toBe(false)
  })

  it('falls back to none when a saved value is broken, keeping the rest', () => {
    const migrated = migrateSettings({ ...DEFAULT_SETTINGS, sidebar: { ...DEFAULT_SETTINGS.sidebar, apps: 'nope', chatRows: 9 } })
    expect(migrated.sidebar.apps).toEqual([])
    expect(migrated.sidebar.chatRows).toBe(9)
  })
})
