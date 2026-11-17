/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { MenuItemSpec } from '@shared/menu'
import { ACCENT_HUES, CHROME_BACKGROUND, resolveAccent } from '@shared/theme'
import { menuTemplate } from '../src/main/menu'
import { agentOverlayLook } from '../src/main/shell'
import { CrashBudget, defaultButtonPosition, recoveryPageUrl } from '../src/main/window'

describe('native popup menus', () => {
  const items: MenuItemSpec[] = [
    { id: 'open', label: 'Open', accelerator: 'CmdOrCtrl+O' },
    { id: 'sep', label: '', type: 'separator' },
    { id: 'pin', label: 'Pin', type: 'checkbox', checked: true },
    { id: 'more', label: 'More', submenu: [{ id: 'light', label: 'Light', type: 'radio', checked: false, enabled: false }] },
    { id: 'delete', label: 'Delete…', danger: true },
  ]

  it('maps specs to Electron templates that report the picked id', () => {
    const picked: string[] = []
    const template = menuTemplate(items, (id) => picked.push(id))
    expect(template[0]).toMatchObject({ id: 'open', label: 'Open', type: 'normal', accelerator: 'CmdOrCtrl+O', registerAccelerator: false, enabled: true })
    expect(template[1]).toEqual({ type: 'separator' })
    expect(template[2]).toMatchObject({ type: 'checkbox', checked: true })
    const sub = template[3]?.submenu as Electron.MenuItemConstructorOptions[]
    expect(sub[0]).toMatchObject({ id: 'light', type: 'radio', enabled: false })
    template[4]?.click?.({} as never, undefined, {} as never)
    ;(sub[0]?.click as () => void)()
    expect(picked).toEqual(['delete', 'light'])
  })

  it('refuses menus nested too deeply', () => {
    let deep: MenuItemSpec = { id: 'leaf', label: 'Leaf' }
    for (let i = 0; i < 6; i++) deep = { id: `level-${i}`, label: 'Level', submenu: [deep] }
    expect(() => menuTemplate([deep], () => undefined)).toThrow(/nested/)
  })
})

describe('chrome crash recovery', () => {
  it('allows a few restarts per minute, then gives up', () => {
    const budget = new CrashBudget(3, 60_000)
    expect([budget.record(0), budget.record(1000), budget.record(2000)]).toEqual([true, true, true])
    expect(budget.record(3000)).toBe(false)
    expect(budget.exhausted).toBe(true)
    budget.reset()
    expect(budget.count).toBe(0)
    // Failures older than the window are forgotten.
    const spaced = new CrashBudget(3, 60_000)
    for (const t of [0, 70_000, 140_000, 210_000]) expect(spaced.record(t)).toBe(true)
  })

  it('shows a static page whose only action leads back to the UI', () => {
    const html = decodeURIComponent(recoveryPageUrl('app://apex/index.html?a=1&b="2"').replace(/^data:text\/html;charset=utf-8,/, ''))
    expect(html).toContain('href="app://apex/index.html?a=1&amp;b=&quot;2&quot;"')
    expect(html).not.toMatch(/<script/i)
    expect(html).toContain('color-scheme: light dark')
  })

  it('starts the traffic lights in the header of each layout', () => {
    expect(defaultButtonPosition('sidebar').x).toBeGreaterThan(0)
    expect(defaultButtonPosition('horizontal')).not.toEqual(defaultButtonPosition('sidebar'))
  })
})

describe('theme', () => {
  it('resolves the accent from the companion or a named hue', () => {
    expect(resolveAccent('companion', '#c9bbff')).toBe('#c9bbff')
    expect(resolveAccent('ocean', '#c9bbff')).toBe(ACCENT_HUES.find((h) => h.id === 'ocean')?.color)
    expect(new Set(ACCENT_HUES.map((h) => h.id)).size).toBe(ACCENT_HUES.length)
    for (const hue of ACCENT_HUES) expect(hue.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(CHROME_BACKGROUND.light).not.toBe(CHROME_BACKGROUND.dark)
  })

  it('gives the in-page overlay a readable accent and the companion name', () => {
    const light = agentOverlayLook({ name: 'Juniper', accent: '#c9bbff' }, 'light')
    const dark = agentOverlayLook({ name: 'Juniper', accent: '#c9bbff' }, 'dark')
    expect(light.label).toContain('Juniper')
    expect(light.accent).toMatch(/^#[0-9a-f]{6}$/)
    expect(light.accent).not.toBe(dark.accent)
    expect(light.onAccent).toMatch(/^#[0-9a-f]{6}$/)
  })
})
