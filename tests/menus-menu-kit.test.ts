/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { NATIVE_TOP, mainMenuItems, menuBarTarget, type MenuData } from '@shared/menuBase'
import type { MenuState } from '@shared/menuModel'
import { CARD_PADDING, SUBMENU_GAP, cascadeKey, closeInnermost, inSafeTriangle, openPath, placeSubmenu, unionBox } from '../src/renderer/src/overlay/kit/logic'

// The overlay kit's cascade maths (DS-94, SH-54): submenu placement stays
// inside a 600 px-tall window, the forgiving pointer path, Escape closing the
// innermost level first, and the Windows and Linux Menu bar rows (SH-59).

const viewport = { width: 800, height: 600 }
const parent = { left: 20, top: 300, width: 236, height: 280 }
const row = { left: 25, top: 400, width: 226, height: 30 }

describe('submenu placement', () => {
  it('opens to the right of the parent card, lined up with its row', () => {
    const p = placeSubmenu(row, parent, { width: 240, height: 120 }, viewport)
    expect(p).toMatchObject({ side: 'right', left: parent.left + parent.width + SUBMENU_GAP, top: row.top - CARD_PADDING })
  })

  it('flips to the left when the right has no room', () => {
    const right = { ...parent, left: 520 }
    const p = placeSubmenu(row, right, { width: 240, height: 120 }, viewport)
    expect(p.side).toBe('left')
    expect(p.left).toBe(520 - SUBMENU_GAP - 240)
  })

  it('stays inside a 600 px-tall window and caps its height', () => {
    const low = { ...row, top: 560 }
    const p = placeSubmenu(low, parent, { width: 240, height: 400 }, viewport)
    expect(p.top + Math.min(400, p.maxHeight)).toBeLessThanOrEqual(600 - 8)
    expect(p.top).toBeGreaterThanOrEqual(8)
    const tall = placeSubmenu(row, parent, { width: 240, height: 2000 }, viewport)
    expect(tall.maxHeight).toBe(600 - 16)
    expect(tall.top).toBe(8)
  })

  it('clamps horizontally when neither side fits', () => {
    const p = placeSubmenu(row, { ...parent, left: 300 }, { width: 700, height: 100 }, viewport)
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.left + 700).toBeLessThanOrEqual(800)
  })
})

describe('the forgiving pointer path', () => {
  const submenu = { left: 260, top: 300, width: 240, height: 200 }
  const origin = { x: 200, y: 410 }

  it('keeps a submenu open while the pointer heads toward it across other rows', () => {
    expect(inSafeTriangle({ x: 230, y: 380 }, origin, submenu, 'right')).toBe(true)
    expect(inSafeTriangle({ x: 250, y: 470 }, origin, submenu, 'right')).toBe(true)
  })

  it('lets go when the pointer moves away from it', () => {
    expect(inSafeTriangle({ x: 150, y: 380 }, origin, submenu, 'right')).toBe(false)
    expect(inSafeTriangle({ x: 210, y: 300 }, origin, submenu, 'right')).toBe(false)
  })

  it('mirrors for a submenu on the left', () => {
    const left = { left: 0, top: 300, width: 180, height: 200 }
    expect(inSafeTriangle({ x: 190, y: 400 }, { x: 220, y: 410 }, left, 'left')).toBe(true)
    expect(inSafeTriangle({ x: 250, y: 400 }, { x: 220, y: 410 }, left, 'left')).toBe(false)
  })
})

describe('cascade keys', () => {
  it('closes the innermost level first, then the menu', () => {
    expect(cascadeKey('Escape', 2, false)).toBe('close-level')
    expect(cascadeKey('Escape', 1, true)).toBe('close-level')
    expect(cascadeKey('Escape', 0, true)).toBe('dismiss')
  })

  it('opens with the arrow toward the submenu and closes with the other', () => {
    expect(cascadeKey('ArrowRight', 0, true)).toBe('open')
    expect(cascadeKey('ArrowRight', 0, false)).toBeNull()
    expect(cascadeKey('ArrowLeft', 1, false)).toBe('close-level')
    expect(cascadeKey('ArrowLeft', 0, false)).toBeNull()
    expect(cascadeKey('ArrowLeft', 0, true, 'left')).toBe('open')
    expect(cascadeKey('ArrowRight', 1, false, 'left')).toBe('close-level')
    expect(cascadeKey('ArrowDown', 1, true)).toBeNull()
  })

  it('tracks the open path', () => {
    expect(openPath([2, 4], 1, 1)).toEqual([2, 1])
    expect(openPath([2, 4], 0, 5)).toEqual([5])
    expect(closeInnermost([2, 1])).toEqual([2])
    expect(closeInnermost([])).toEqual([])
  })

  it('unions the open cards for the host bounds', () => {
    expect(unionBox([])).toBeNull()
    expect(unionBox([parent, { left: 259, top: 395, width: 240, height: 300 }])).toEqual({ left: 20, top: 300, width: 479, height: 395 })
  })
})

describe('the Menu bar rows (Windows and Linux)', () => {
  const state: MenuState = {
    windows: [{ id: 1, kind: 'normal', title: 'Window', tabCount: 1, focused: true }],
    focusedWindow: { id: 1, kind: 'normal' },
    tabs: [],
    activeTabId: null,
    focusedSurface: 'page',
    commands: {},
    update: { state: 'idle', percent: null },
  }
  const data = (platform: string): MenuData => ({
    platform,
    appName: 'Apex',
    version: '1.0.0',
    theme: 'system',
    layout: 'sidebar',
    bookmarksBar: 'always',
    warnBeforeQuit: true,
    adblock: true,
    sidebarOpen: true,
    isDefaultBrowser: true,
    tabs: [],
    active: null,
    closed: [],
    visited: [],
    chats: [],
    bookmarks: { recent: [], bar: [], other: [] },
  })

  it('offers every non-empty top-level menu off macOS, and nothing on macOS', () => {
    const win = mainMenuItems(state, data('win32')).find((i) => i.id === 'menubar-menu')
    expect(win?.submenu?.map((i) => i.id)).toEqual(['menubar:file', 'menubar:edit', 'menubar:view', 'menubar:tabs', 'menubar:bookmarks', 'menubar:history', 'menubar:window', 'menubar:help'])
    expect(mainMenuItems(state, data('darwin')).some((i) => i.id === 'menubar-menu')).toBe(false)
  })

  it('maps a row back to its top-level menu and rejects anything else', () => {
    for (const target of NATIVE_TOP.filter((t) => t !== 'app')) expect(menuBarTarget(`menubar:${target}`)).toBe(target)
    expect(menuBarTarget('menubar:app')).toBeNull()
    expect(menuBarTarget('menubar:dock')).toBeNull()
    expect(menuBarTarget('tab:menubar:file')).toBeNull()
    expect(menuBarTarget('open-settings')).toBeNull()
  })
})
