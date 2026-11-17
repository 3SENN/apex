/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { TAB_INFO_DEFAULTS, type TabGroup } from '@shared/tabs'
import type { TabInfo } from '../src/shared/ipc'
import { droppedText, dropUrl, firstUri, hasDroppable, pointInside, ENTRY_MIME } from '../src/renderer/src/components/sidebar/logic/drops'
import { groupedItems, groupMembers, visibleTabIds } from '../src/renderer/src/components/sidebar/logic/groups'
import { tabRows } from '../src/renderer/src/components/sidebar/logic/order'
import { isSelected, menuTargets, rangeSelection, toggleSelection } from '../src/renderer/src/components/sidebar/logic/selection'
import { FAR_VIEWS, STRIP_TAB_MAX, STRIP_TAB_MIN, stripDensity, stripOverflows, stripScroll, stripTabWidth } from '../src/renderer/src/components/sidebar/logic/strip'
import { initialSelection, recentCards, stepSelection } from '../src/renderer/src/components/sidebar/logic/switcher'
import { chooserTabs, clampRatio, isEven, leftWidth, ratioFromWidth, seamRange, sideOf, splitVars } from '../src/renderer/src/components/sidebar/logic/split'
import { RAIL_WIDTH, clampRailWidth, parseRailPrefs, railShown, recentChats } from '../src/renderer/src/components/sidebar/logic/rail'
import { ghostLayout } from '../src/renderer/src/components/sidebar/logic/ghost'

// The tabs chrome side: visible order with collapsed groups, selection
// maths, the switcher's MRU cards, drop targets, split ratios, the strip's
// widths and scrolling, the rail and the tear-off ghost.

function tab(id: string, patch: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    title: id.toUpperCase(),
    url: `https://${id}.test/`,
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    agentControlled: false,
    agentChatId: null,
    needsInput: false,
    pinned: false,
    audible: false,
    muted: false,
    lastActiveAt: 0,
    crumbs: null,
    ...TAB_INFO_DEFAULTS,
    capture: { ...TAB_INFO_DEFAULTS.capture },
    ...patch,
  } as TabInfo
}

const group = (id: string, collapsed = false): TabGroup => ({ id, name: id, color: 'fern', collapsed })

describe('groups in the list (SH-23)', () => {
  const tabs = [tab('a'), tab('b', { groupId: 'g' }), tab('c'), tab('d', { groupId: 'g' })]
  const groupOf = (id: string): string | null => tabs.find((t) => t.id === id)?.groupId ?? null

  it('puts a header in front of the block, where its first tab is', () => {
    const items = groupedItems(tabRows(tabs, null), [group('g')], groupOf)
    expect(items.map((i) => (i.kind === 'group' ? `[${i.group.id}]` : i.kind === 'tab' ? i.tab.id : 'split'))).toEqual(['a', '[g]', 'b', 'd', 'c'])
    expect(visibleTabIds(items)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('leaves out tabs of a collapsed group but still counts them', () => {
    const items = groupedItems(tabRows(tabs, null), [group('g', true)], groupOf)
    const header = items.find((i) => i.kind === 'group')
    expect(header && header.kind === 'group' ? header.tabIds : []).toEqual(['b', 'd'])
    expect(visibleTabIds(items)).toEqual(['a', 'c'])
  })

  it('moves the group as one block in recent order', () => {
    const recent = [tab('d', { groupId: 'g' }), tab('a'), tab('b', { groupId: 'g' }), tab('c')]
    const items = groupedItems(tabRows(recent, null), [group('g')], (id) => recent.find((t) => t.id === id)?.groupId ?? null)
    expect(visibleTabIds(items)).toEqual(['d', 'b', 'a', 'c'])
  })

  it('ignores unknown groups and lists a collapsed group’s tabs for its card', () => {
    const items = groupedItems(tabRows([tab('x', { groupId: 'gone' })], null), [], () => 'gone')
    expect(items).toHaveLength(1)
    expect(groupMembers(tabs, ['d', 'b']).map((t) => t.id)).toEqual(['d', 'b'])
  })
})

describe('multi-select (SH-18, SH-25)', () => {
  const order = ['a', 'b', 'c', 'd', 'e']

  it('takes a range from the active tab, either way', () => {
    expect(rangeSelection(order, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeSelection(order, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(rangeSelection(order, null, 'c')).toEqual(['c'])
    expect(rangeSelection(order, 'b', 'zz')).toEqual([])
  })

  it('toggles one tab, bringing in the active tab first', () => {
    expect(toggleSelection([], 'a', 'c')).toEqual(['a', 'c'])
    expect(toggleSelection(['a', 'c'], 'a', 'c')).toEqual(['a'])
    expect(toggleSelection([], 'c', 'c')).toEqual(['c'])
  })

  it('acts on the selection only from one of its rows, and draws it only with two or more', () => {
    expect(menuTargets(['a', 'b'], 'b')).toEqual(['a', 'b'])
    expect(menuTargets(['a', 'b'], 'c')).toEqual(['c'])
    expect(isSelected(['a'], 'a')).toBe(false)
    expect(isSelected(['a', 'b'], 'a')).toBe(true)
  })
})

describe('the recent-tab switcher (SH-29)', () => {
  const host = (url: string): string => new URL(url).hostname

  it('lists up to eight cards in MRU order, a split pair as one card and chats with their kind', () => {
    const tabs = [tab('a'), tab('b'), tab('c', { url: 'atelier://chat/123' }), tab('d')]
    const cards = recentCards(['d', 'b', 'c', 'a'], { tabs, split: { primaryId: 'a', secondaryId: 'b' } }, (u) => (u.startsWith('atelier:') ? 'Atelier' : host(u)))
    expect(cards.map((c) => [c.tabId, c.kind, c.pages.map((p) => p.tabId).join('+')])).toEqual([
      ['d', 'tab', 'd'],
      ['b', 'split', 'a+b'],
      ['c', 'chat', 'c'],
    ])
  })

  it('adds tabs main has not ranked yet and caps the count', () => {
    const tabs = Array.from({ length: 12 }, (_, i) => tab(`t${i}`))
    const cards = recentCards(['t5'], { tabs, split: null }, host)
    expect(cards).toHaveLength(8)
    expect(cards[0]?.tabId).toBe('t5')
  })

  it('opens on the previous tab and wraps both ways', () => {
    expect(initialSelection(5, 1)).toBe(1)
    expect(initialSelection(5, -1)).toBe(4)
    expect(initialSelection(1, 1)).toBe(0)
    expect(stepSelection(4, 1, 5)).toBe(0)
    expect(stepSelection(0, -1, 5)).toBe(4)
    expect(stepSelection(0, 1, 0)).toBe(0)
  })
})

describe('drops onto tabs and the list', () => {
  it('takes text and links, never our own row drags', () => {
    expect(hasDroppable(['text/plain'])).toBe(true)
    expect(hasDroppable(['text/uri-list'])).toBe(true)
    expect(hasDroppable([ENTRY_MIME, 'text/plain'])).toBe(false)
    expect(hasDroppable(['Files'])).toBe(false)
  })

  it('reads the first address of a uri list, else the text', () => {
    expect(firstUri('# comment\nhttps://a.test/\nhttps://b.test/')).toBe('https://a.test/')
    const data: Record<string, string> = { 'text/plain': '  hello world  ' }
    expect(droppedText((type) => data[type] ?? '')).toBe('hello world')
    expect(droppedText(() => '')).toBeNull()
  })

  it('opens addresses and searches anything else, including unsafe schemes', () => {
    expect(dropUrl('https://example.com/x', 'duckduckgo')).toBe('https://example.com/x')
    const searched = dropUrl('javascript:alert(1)', 'duckduckgo') ?? ''
    expect(searched.startsWith('javascript:')).toBe(false)
    expect(dropUrl('   ', 'duckduckgo')).toBeNull()
  })
})

describe('split view (SH-39 to SH-42)', () => {
  it('keeps the ratio between 0.2 and 0.8, even when broken', () => {
    expect(clampRatio(0.1)).toBe(0.2)
    expect(clampRatio(0.95)).toBe(0.8)
    expect(clampRatio(Number.NaN)).toBe(0.5)
    expect(isEven(0.502)).toBe(true)
    expect(isEven(0.55)).toBe(false)
  })

  it('maps the seam between px and ratio', () => {
    expect(leftWidth(1008, 8, 0.5)).toBe(500)
    expect(ratioFromWidth(250, 1008, 8)).toBe(0.25)
    expect(ratioFromWidth(10, 8, 8)).toBe(0.5)
    expect(seamRange(1008, 8)).toEqual({ min: 200, max: 800 })
    expect(splitVars(0.3)).toEqual({ '--split-left': '0.3', '--split-right': '0.7' })
  })

  it('offers the tabs not already showing, most recent first, and names the sides', () => {
    const tabs = [tab('a', { lastActiveAt: 3 }), tab('b', { lastActiveAt: 9 }), tab('c', { lastActiveAt: 5 }), tab('d', { lastActiveAt: 7 })]
    const split = { primaryId: 'a', secondaryId: 'b' }
    expect(chooserTabs({ tabs, split }).map((t) => t.id)).toEqual(['d', 'c'])
    expect(chooserTabs({ tabs: tabs.slice(0, 2), split })).toEqual([])
    expect(sideOf(split, 'b')).toBe('right')
    expect(sideOf(split, 'c')).toBeNull()
    expect(sideOf(null, 'a')).toBeNull()
  })
})

describe('the horizontal strip (SH-21)', () => {
  it('shares the room between tabs from about 200 down to about 20 px', () => {
    expect(stripTabWidth({ available: 1200, tabs: 5, pinned: 0 })).toBe(STRIP_TAB_MAX)
    const thirty = stripTabWidth({ available: 1200, tabs: 30, pinned: 2 })
    expect(thirty).toBeGreaterThan(STRIP_TAB_MIN)
    expect(thirty).toBeLessThan(STRIP_TAB_MAX)
    expect(stripTabWidth({ available: 1200, tabs: 80, pinned: 0 })).toBe(STRIP_TAB_MIN)
    expect(stripTabWidth({ available: 1200, tabs: 0, pinned: 3 })).toBe(STRIP_TAB_MAX)
  })

  it('scrolls only once the floor is reached', () => {
    expect(stripOverflows({ available: 1200, tabs: 30, pinned: 0 })).toBe(false)
    expect(stripOverflows({ available: 1200, tabs: 80, pinned: 0 })).toBe(true)
  })

  it('drops the title and then the close as tabs narrow', () => {
    expect(stripDensity(200)).toBe('full')
    expect(stripDensity(60)).toBe('compact')
    expect(stripDensity(20)).toBe('icon')
  })

  it('keeps the active tab in view: nothing when visible, a glide when near, a jump when far', () => {
    const view = { scrollLeft: 0, width: 1000 }
    expect(stripScroll({ left: 100, width: 50 }, view)).toBeNull()
    expect(stripScroll({ left: 1100, width: 50 }, view)).toEqual({ left: 150, behavior: 'smooth' })
    expect(stripScroll({ left: 1000 * (FAR_VIEWS + 2), width: 50 }, view)?.behavior).toBe('auto')
    expect(stripScroll({ left: 1100, width: 50 }, view, true)?.behavior).toBe('auto')
    expect(stripScroll({ left: 0, width: 50 }, { scrollLeft: 400, width: 1000 })).toEqual({ left: 0, behavior: 'smooth' })
  })
})

describe('the rail (SH-63) and the ghost (SH-30)', () => {
  it('shows on atelier:// pages and the destination surface in the horizontal layout only', () => {
    const web = { tabs: [tab('a')], activeId: 'a', rail: null }
    const atelier = { tabs: [tab('a', { url: 'atelier://settings' })], activeId: 'a', rail: null }
    expect(railShown('horizontal', web)).toBe(false)
    expect(railShown('horizontal', atelier)).toBe(true)
    expect(railShown('sidebar', atelier)).toBe(false)
    expect(railShown('horizontal', { ...web, rail: { url: 'atelier://chats', title: 'All chats', crumbs: [] } })).toBe(true)
  })

  it('reads saved prefs defensively and clamps the width', () => {
    expect(parseRailPrefs(null)).toEqual({ collapsed: false, width: RAIL_WIDTH.default, hintSeen: false })
    expect(parseRailPrefs('{oops')).toEqual(parseRailPrefs(null))
    expect(parseRailPrefs('{"collapsed":true,"width":999,"hintSeen":true}')).toEqual({ collapsed: true, width: RAIL_WIDTH.max, hintSeen: true })
    expect(clampRailWidth(10)).toBe(RAIL_WIDTH.min)
  })

  it('lists recent unarchived chats, newest first', () => {
    const chats = [
      { id: 'a', lastActiveAt: 1, archived: false },
      { id: 'b', lastActiveAt: 3, archived: true },
      { id: 'c', lastActiveAt: 2, archived: false },
    ]
    expect(recentChats(chats).map((c) => c.id)).toEqual(['c', 'a'])
    expect(recentChats(null)).toEqual([])
  })

  it('fades the thumbnail in as the ghost grows', () => {
    expect(ghostLayout(0)).toMatchObject({ thumbOpacity: 0, radius: 10 })
    expect(ghostLayout(1)).toMatchObject({ thumbOpacity: 1, radius: 14 })
    expect(ghostLayout(Number.NaN).thumbOpacity).toBe(0)
  })
})

describe('drag-leave between a zone\'s own rows', () => {
  const zone = { left: 10, top: 100, right: 250, bottom: 400 }
  it('counts the pointer still inside the zone as not leaving it', () => {
    expect(pointInside(zone, 120, 200)).toBe(true)
    expect(pointInside(zone, 260, 200)).toBe(false)
    expect(pointInside(zone, 120, 99)).toBe(false)
    // Chromium reports a pointer that left the window at 0, 0.
    expect(pointInside({ left: -5, top: -5, right: 50, bottom: 50 }, 0, 0)).toBe(false)
  })
})
