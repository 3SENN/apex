/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAIN_MENU_SPECIAL, NATIVE_TOP, baseNativeMenus, flattenMenu, mainMenuItems, menuAccelerator, nativeMenus, resolveStates, type MenuData } from '@shared/menuBase'
import { MENU_LIMITS, escapeMnemonic, findFolder, folderRows, menuLabel, pickTabList, recentClosed, recentVisits, type MenuBookmarkNode, type MenuTab } from '@shared/menuLists'
import { applyContributions, menus, registerMenuContribution, type MenuContribution, type MenuItemModel, type MenuState } from '@shared/menuModel'
import { HOLD_PREFIX, SHORTCUTS, isCommandId, shortcutById, type ShortcutId } from '@shared/shortcuts'
import type { ClosedEntry } from '@shared/windows'

// The menu model (SH-50 to SH-59, SH-54): native template parity with the
// main menu, accelerator coverage against SHORTCUTS, the recent-list limits
// and the contribution registry.

const state = (over: Partial<MenuState> = {}): MenuState => ({
  windows: [{ id: 1, kind: 'normal', title: 'Window', tabCount: 1, focused: true }],
  focusedWindow: { id: 1, kind: 'normal' },
  tabs: [],
  activeTabId: 't1',
  focusedSurface: 'page',
  commands: {},
  update: { state: 'idle', percent: null },
  ...over,
})

const tab = (n: number, over: Partial<MenuTab> = {}): MenuTab => ({ id: `t${n}`, title: `Tab ${n}`, url: `https://example.com/${n}`, pinned: false, muted: false, lastActiveAt: n, ...over })

const data = (over: Partial<MenuData> = {}): MenuData => ({
  platform: 'darwin',
  appName: 'Apex',
  version: '1.2.3',
  theme: 'system',
  layout: 'sidebar',
  bookmarksBar: 'always',
  warnBeforeQuit: true,
  adblock: true,
  sidebarOpen: true,
  isDefaultBrowser: false,
  tabs: [tab(1)],
  active: { web: true, muted: false },
  closed: [],
  visited: [],
  chats: [],
  bookmarks: { recent: [], bar: [], other: [] },
  ...over,
})

/** Shortcut rows native menus must carry (holds, website-only keys and the voice and problem-report rows stay with the router or their feature). */
const MENU_SHORTCUTS = SHORTCUTS.filter((s) => !s.accelerator.startsWith(HOLD_PREFIX) && s.when !== 'website' && !['report-problem', 'voice-hold-to-talk', 'voice-read-aloud'].includes(s.id))

function accelerators(menu: Record<string, MenuItemModel[]>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const target of NATIVE_TOP) {
    for (const item of flattenMenu(menu[target] ?? [])) {
      if (item.accelerator) out.set(item.accelerator, [...(out.get(item.accelerator) ?? []), item.commandId ?? item.id])
    }
  }
  return out
}

describe('native menus', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    it(`carries every shortcut row exactly once on ${platform}`, () => {
      const menu = baseNativeMenus(state(), data({ platform }))
      const keys = accelerators(menu)
      const missing: string[] = []
      for (const def of MENU_SHORTCUTS) {
        const accelerator = menuAccelerator(def, platform)
        if (!accelerator) continue
        const owners = keys.get(accelerator) ?? []
        if (!owners.includes(def.id)) missing.push(def.id)
      }
      expect(missing).toEqual([])
      const doubled = [...keys].filter(([, ids]) => ids.length > 1)
      expect(doubled).toEqual([])
    })
  }

  it('builds the menu bar in order, with the App menu only on macOS', () => {
    const mac = baseNativeMenus(state(), data())
    expect(mac.app.map((i) => i.id)).toContain('about')
    expect(mac.app.some((i) => i.id === 'warn-before-quit' && i.checked === true)).toBe(true)
    const win = baseNativeMenus(state(), data({ platform: 'win32' }))
    expect(win.app).toEqual([])
    // Settings, the quit warning and Quit move to File elsewhere.
    expect(win.file.map((i) => i.id)).toEqual(expect.arrayContaining(['open-settings', 'warn-before-quit', 'quit']))
  })

  it('offers make-default only when Apex is not the default browser', () => {
    expect(flattenMenu(baseNativeMenus(state(), data()).app).some((i) => i.id === 'default-browser')).toBe(true)
    expect(flattenMenu(baseNativeMenus(state(), data({ isDefaultBrowser: true })).app).some((i) => i.id === 'default-browser')).toBe(false)
  })

  it('has no account, sign-out or plan items anywhere', () => {
    const all = [...NATIVE_TOP.flatMap((t) => flattenMenu(baseNativeMenus(state(), data())[t])), ...flattenMenu(mainMenuItems(state(), data()))]
    const words = all.map((i) => i.label.toLowerCase()).join(' | ')
    for (const banned of ['sign out', 'log out', 'account', 'plan', 'upgrade', 'credit', 'billing']) expect(words).not.toContain(banned)
  })

  it('never registers Escape, holds or website-only keys as menu accelerators', () => {
    expect(menuAccelerator(shortcutById('stop')!, 'win32')).toBeUndefined()
    expect(menuAccelerator(shortcutById('stop')!, 'darwin')).toBe('Cmd+.')
    expect(menuAccelerator(shortcutById('back-arrow')!, 'darwin')).toBeUndefined()
    expect(menuAccelerator(shortcutById('number-hints')!, 'darwin')).toBeUndefined()
    expect(menuAccelerator(shortcutById('toggle-fullscreen')!, 'win32')).toBe('F11')
  })

  it('keeps ⌘1–9 and the alternates as hidden items', () => {
    const hidden = flattenMenu(baseNativeMenus(state(), data()).tabs).filter((i) => i.visible === false)
    const ids = hidden.map((i) => i.commandId)
    for (const id of ['select-1', 'select-8', 'select-last', 'next-tab', 'previous-tab', 'next-entry-bracket'] as ShortcutId[]) expect(ids).toContain(id)
  })

  it('checks the active tab and the focused window', () => {
    const menu = baseNativeMenus(state({ activeTabId: 't2' }), data({ tabs: [tab(1), tab(2)] }))
    expect(menu.tabs.filter((i) => i.type === 'checkbox' && i.checked).map((i) => i.id)).toEqual(['tab:t2'])
    expect(menu.window.filter((i) => i.id.startsWith('window:')).map((i) => i.checked)).toEqual([true])
  })

  it('labels private windows and closed windows by tab count', () => {
    const closed: ClosedEntry[] = [{ kind: 'window', tabCount: 3, title: '', closedAt: 2 }, { kind: 'tab', title: 'News', url: 'https://n.example', closedAt: 1 }]
    const menu = baseNativeMenus(state({ windows: [{ id: 2, kind: 'private', title: 'Secret', tabCount: 1, focused: false }] }), data({ closed }))
    expect(menu.window.find((i) => i.id === 'window:2')?.label).toBe('Secret (Private)')
    const recent = menu.history.find((i) => i.id === 'recently-closed')?.submenu ?? []
    expect(recent.map((i) => i.label)).toEqual(['Window (3 tabs)', 'News'])
  })

  it('shows the empty states', () => {
    const menu = baseNativeMenus(state(), data())
    expect(menu.history.find((i) => i.id === 'recently-closed')?.submenu?.[0]).toMatchObject({ enabled: false, variant: 'note' })
    expect(menu.history.some((i) => i.id === 'chats-none')).toBe(true)
    const bar = menu.bookmarks.find((i) => i.id === 'folder:bar')
    expect(bar?.submenu?.[0]?.label).toBe('No bookmarks')
  })
})

describe('the main menu', () => {
  it('shares commands and accelerators with the native menus', () => {
    const native = new Map<string, string | undefined>()
    for (const target of NATIVE_TOP) for (const item of flattenMenu(baseNativeMenus(state(), data())[target])) if (item.commandId && item.visible !== false) native.set(item.commandId, native.get(item.commandId) ?? item.accelerator)
    const main = flattenMenu(mainMenuItems(state(), data())).filter((i) => i.commandId)
    expect(main.length).toBeGreaterThan(10)
    for (const item of main) {
      expect(native.has(item.commandId!), `${item.commandId} is in the native menus too`).toBe(true)
      if (item.accelerator) expect(item.accelerator).toBe(native.get(item.commandId!))
    }
  })

  it('holds the SH-54 sections, with the special rows the popover draws', () => {
    const top = mainMenuItems(state(), data()).filter((i) => i.type !== 'separator').map((i) => i.id)
    expect(top).toEqual(['tabs-menu', 'bookmarks-menu', 'history-menu', 'open-downloads', 'appearance', 'save-share-menu', 'more-tools-menu', 'default-browser', 'help-menu', 'open-settings'])
    const tools = flattenMenu(mainMenuItems(state(), data()))
    expect(tools.find((i) => i.id === 'adblock')).toMatchObject({ variant: 'switch', checked: true })
    expect(tools.some((i) => i.id === MAIN_MENU_SPECIAL.zoom)).toBe(true)
  })

  it('lists the last eight pages, or an empty state', () => {
    const visited = Array.from({ length: 12 }, (_, i) => ({ url: `https://e.example/${i}`, title: `Page ${i}` }))
    const history = mainMenuItems(state(), data({ visited })).find((i) => i.id === 'history-menu')?.submenu ?? []
    expect(history.filter((i) => i.id.startsWith('open:'))).toHaveLength(MENU_LIMITS.mainHistory)
    const empty = mainMenuItems(state(), data()).find((i) => i.id === 'history-menu')?.submenu ?? []
    expect(empty[0]).toMatchObject({ id: 'history-empty', variant: 'note', enabled: false })
  })

  it('puts contributions in their sections', () => {
    const offs = [
      registerMenuContribution({ id: 'test-tools', target: 'main-menu:tools', build: () => [{ id: 'open-passwords', label: 'Passwords', commandId: 'open-passwords' }] }),
      registerMenuContribution({ id: 'test-profile', target: 'main-menu:profile', build: () => [{ id: 'profile:work', label: 'Work' }] }),
      registerMenuContribution({ id: 'test-help', target: 'main-menu:help', build: () => [{ id: 'help:feedback', label: 'Send Feedback…' }] }),
      registerMenuContribution({ id: 'test-banner', target: 'main-menu', build: () => [{ id: 'update:restart', label: 'Restart to update' }] }),
    ]
    try {
      const owners = new Map<string, MenuContribution>()
      const items = mainMenuItems(state(), data({ isDefaultBrowser: true }), owners)
      const ids = items.map((i) => i.id)
      expect(ids[0]).toBe('profile:work')
      expect(ids.indexOf('open-passwords')).toBe(ids.indexOf('open-downloads') + 1)
      expect(ids.indexOf('update:restart')).toBeLessThan(ids.indexOf('help-menu'))
      expect(items.find((i) => i.id === 'help-menu')?.submenu?.at(-1)?.id).toBe('help:feedback')
      expect(owners.get('update:restart')?.id).toBe('test-banner')
    } finally {
      for (const off of offs) off()
    }
  })
})

describe('command states', () => {
  it('disables items whose command is not registered and keeps explicit disables', () => {
    const items: MenuItemModel[] = [
      { id: 'a', label: 'A', commandId: 'new-tab' },
      { id: 'b', label: 'B', commandId: 'print', enabled: false },
      { id: 'c', label: 'C', commandId: 'quit' },
      { id: 'd', label: 'D', submenu: [{ id: 'e', label: 'E', commandId: 'find' }] },
    ]
    const resolved = resolveStates(items, (id) => (id === 'new-tab' || id === 'print' || id === 'find' ? { enabled: true, checked: id === 'find' } : null))
    expect(resolved.map((i) => i.enabled)).toEqual([true, false, false, undefined])
    expect(resolved[3]?.submenu?.[0]).toMatchObject({ enabled: true, checked: true })
  })

  it('every command id in the model is a real command', () => {
    const all = [...NATIVE_TOP.flatMap((t) => flattenMenu(baseNativeMenus(state(), data())[t])), ...flattenMenu(mainMenuItems(state(), data()))]
    for (const item of all) if (item.commandId) expect(isCommandId(item.commandId), item.commandId).toBe(true)
  })
})

describe('recent lists', () => {
  it('keeps the 48 most recently shown tabs in list order, always with the active one', () => {
    const tabs = Array.from({ length: 60 }, (_, i) => tab(i + 1))
    const { shown, omitted } = pickTabList(tabs, 't1')
    expect(shown).toHaveLength(MENU_LIMITS.tabs)
    expect(omitted).toBe(12)
    expect(shown[0]?.id).toBe('t1')
    // List order is kept: ids ascend.
    const order = shown.map((t) => Number(t.id.slice(1)))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(shown.some((t) => t.id === 't60')).toBe(true)
    expect(shown.some((t) => t.id === 't2')).toBe(false)
  })

  it('notes how many tabs were left out', () => {
    const tabs = Array.from({ length: 50 }, (_, i) => tab(i + 1))
    const menu = baseNativeMenus(state({ activeTabId: 't50' }), data({ tabs }))
    expect(menu.tabs.find((i) => i.id === 'tabs-more')?.label).toBe('2 more tabs not shown')
  })

  it('caps recently closed at 10, newest first', () => {
    const entries: ClosedEntry[] = Array.from({ length: 14 }, (_, i) => ({ kind: 'tab', title: `T${i}`, url: `https://x.example/${i}`, closedAt: i }))
    const out = recentClosed(entries)
    expect(out).toHaveLength(10)
    expect(out[0]?.closedAt).toBe(13)
  })

  it('caps visited at 15, web pages only, one per address', () => {
    const visits = [{ url: 'apex://history', title: 'H' }, ...Array.from({ length: 20 }, (_, i) => ({ url: `https://v.example/${i % 18}`, title: `V${i}` }))]
    const out = recentVisits(visits)
    expect(out).toHaveLength(15)
    expect(new Set(out.map((v) => v.url)).size).toBe(15)
    expect(out.every((v) => v.url.startsWith('https://'))).toBe(true)
  })

  it('caps recent chats at 10', () => {
    const chats = Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, title: `Chat ${i}` }))
    const menu = baseNativeMenus(state(), data({ chats }))
    expect(menu.history.filter((i) => i.id.startsWith('chat:'))).toHaveLength(MENU_LIMITS.chats)
  })

  it('builds folder submenus with Open All and a note when rows were left out', () => {
    const children: MenuBookmarkNode[] = [
      ...Array.from({ length: 45 }, (_, i): MenuBookmarkNode => ({ kind: 'bookmark', id: `b${i}`, title: `B${i}`, url: `https://b.example/${i}` })),
      { kind: 'folder', id: 'f1', title: 'Inner', children: [{ kind: 'bookmark', id: 'x', title: 'X', url: 'https://x.example' }] },
    ]
    expect(folderRows(children)).toMatchObject({ omitted: 6, bookmarks: 45 })
    const menu = baseNativeMenus(state(), data({ bookmarks: { recent: [], bar: children, other: [] } }))
    const bar = menu.bookmarks.find((i) => i.id === 'folder:bar')?.submenu ?? []
    expect(bar.find((i) => i.id === 'more:bar')?.label).toBe('6 more not shown')
    expect(bar.at(-1)).toMatchObject({ id: 'open-all:bar', label: 'Open All 45 Bookmarks' })
    expect(findFolder(children, 'f1')?.title).toBe('Inner')
  })

  it('shortens labels and escapes mnemonics off macOS', () => {
    expect(menuLabel('  ', 'Untitled')).toBe('Untitled')
    expect(menuLabel('x'.repeat(80), '', 20)).toHaveLength(20)
    expect(escapeMnemonic('Tom & Jerry', 'win32')).toBe('Tom && Jerry')
    expect(escapeMnemonic('Tom & Jerry', 'darwin')).toBe('Tom & Jerry')
  })
})

describe('the contribution registry', () => {
  afterEach(() => vi.useRealTimers())

  it('rejects a duplicate id and inserts after an item', () => {
    const off = registerMenuContribution({ id: 'dup', target: 'file', after: 'b', build: () => [{ id: 'x', label: 'X' }] })
    try {
      expect(() => registerMenuContribution({ id: 'dup', target: 'file', build: () => [] })).toThrow()
      const base: MenuItemModel[] = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]
      expect(applyContributions('file', base, state()).map((i) => i.id)).toEqual(['a', 'b', 'x', 'c'])
    } finally {
      off()
    }
  })

  it('skips a contribution whose builder throws', () => {
    const off = registerMenuContribution({ id: 'broken', target: 'edit', build: () => { throw new Error('boom') } })
    try {
      expect(applyContributions('edit', [{ id: 'a', label: 'A' }], state()).map((i) => i.id)).toEqual(['a'])
    } finally {
      off()
    }
  })

  it('applies contributions to every native target, and shows Extensions only with items', () => {
    expect(nativeMenus(state(), data()).extensions).toEqual([])
    const off = registerMenuContribution({ id: 'ext', target: 'extensions', build: () => [{ id: 'ext:a', label: 'An extension' }] })
    try {
      const owners = new Map<string, MenuContribution>()
      expect(nativeMenus(state(), data(), owners).extensions.map((i) => i.id)).toEqual(['ext:a'])
      expect(owners.get('ext:a')?.id).toBe('ext')
    } finally {
      off()
    }
  })

  it('debounces invalidation into one rebuild', async () => {
    // Let the registrations above settle their own debounce first.
    await new Promise((resolve) => setTimeout(resolve, 80))
    vi.useFakeTimers()
    const fn = vi.fn()
    const off = menus.onInvalidate(fn)
    menus.invalidate()
    menus.invalidate()
    menus.invalidate()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
    off()
  })
})
