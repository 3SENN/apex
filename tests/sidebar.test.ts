/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS } from '@shared/chats'
import { TAB_INFO_DEFAULTS } from '@shared/tabs'
import { describe, expect, it } from 'vitest'
import type { ChatSummary } from '../src/shared/chats'
import type { TabInfo } from '../src/shared/ipc'
import { fullAddress, middleEllipsis, pillParts } from '../src/renderer/src/components/address'
import { addressMenu, backgroundMenu, chatCounts, chatMenu, mainMenu, tabMenu } from '../src/renderer/src/components/sidebar/logic/menus'
import { closeChat, initialOpenChats, openChat, parseOpenChats, reopenChats, reorderChat, SEED_RECENT, syncOpenChats } from '../src/renderer/src/components/sidebar/logic/openChats'
import {
  chatIdOfUrl,
  dropIndex,
  manualMoveIndex,
  matchesFilter,
  moveId,
  nextRoutineRun,
  pinnedColumns,
  sidebarFits,
  sortChats,
  sortTabs,
  stableOrder,
  tabRows,
  visibleOrder,
} from '../src/renderer/src/components/sidebar/logic/order'

function tab(id: string, patch: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    title: id,
    url: `https://${id}.example/`,
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
    ...patch,
  }
}

function chat(id: string, patch: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0,
    routineId: null,
    companionId: 'companion-1',
    model: '',
    status: 'idle',
    unread: false,
    pinned: false,
    archived: false,
    needsInput: false,
    draft: false,
    ...CHAT_SUMMARY_FLAG_DEFAULTS, ...CHAT_SUMMARY_LINK_DEFAULTS,
    ...patch,
  }
}

describe('pinned grid', () => {
  it('uses one or two columns for one or two tiles, then balances three against four', () => {
    expect([1, 2].map(pinnedColumns)).toEqual([1, 2])
    expect(pinnedColumns(3)).toBe(3)
    expect(pinnedColumns(4)).toBe(4)
    expect(pinnedColumns(5)).toBe(3) // 3 + 2 beats 4 + 1
    expect(pinnedColumns(6)).toBe(3)
    expect(pinnedColumns(7)).toBe(4) // 4 + 3 beats 3 + 3 + 1
    expect(pinnedColumns(9)).toBe(3)
    expect(pinnedColumns(10)).toBe(4) // a tie goes to fewer rows
  })
})

describe('stable order under the pointer', () => {
  it('keeps shown rows in place and slots new ones where the live order puts them', () => {
    expect(stableOrder(['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual(['a', 'b', 'c'])
    expect(stableOrder(['a', 'b', 'c'], ['n', 'c', 'b', 'a'])).toEqual(['n', 'a', 'b', 'c'])
    expect(stableOrder(['a', 'b'], ['b', 'a', 'z'])).toEqual(['a', 'z', 'b'])
    expect(stableOrder(['a', 'b'], ['x', 'y', 'b', 'a'])).toEqual(['x', 'y', 'a', 'b'])
    expect(stableOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c'])
  })
})

describe('tab sorting', () => {
  const tabs = [tab('a', { lastActiveAt: 1 }), tab('b', { lastActiveAt: 3 }), tab('c', { lastActiveAt: 2 })]

  it('keeps main order in manual mode and sorts by use in recent mode', () => {
    expect(sortTabs(tabs, 'manual').map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(sortTabs(tabs, 'recent').map((t) => t.id)).toEqual(['b', 'c', 'a'])
  })

  it('honours a drop in recent mode until the tab is used again', () => {
    const placed = { a: { after: 'b', at: 5 } }
    expect(sortTabs(tabs, 'recent', placed).map((t) => t.id)).toEqual(['b', 'a', 'c'])
    const top = { c: { after: null, at: 5 } }
    expect(sortTabs(tabs, 'recent', top).map((t) => t.id)).toEqual(['c', 'b', 'a'])
    // Used after the drop: back to activity order.
    const used = [tab('a', { lastActiveAt: 9 }), tabs[1] as TabInfo, tabs[2] as TabInfo]
    expect(sortTabs(used, 'recent', placed).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('merges a split pair into one row at its first tab', () => {
    const rows = tabRows([tab('a'), tab('b'), tab('c')], { primaryId: 'c', secondaryId: 'a' })
    expect(rows.map((r) => (r.kind === 'tab' ? r.tab.id : `${r.primary.id}+${r.secondary.id}`))).toEqual(['c+a', 'b'])
    expect(tabRows([tab('a')], { primaryId: 'a', secondaryId: 'gone' })).toHaveLength(1)
  })
})

describe('chat sorting', () => {
  const chats = [
    chat('idle', { lastActiveAt: 5 }),
    chat('working', { status: 'running', lastActiveAt: 1 }),
    chat('asks', { needsInput: true, lastActiveAt: 2 }),
    chat('pinned', { pinned: true, lastActiveAt: 0 }),
    chat('fresh', { unread: true, status: 'finished', lastActiveAt: 3 }),
  ]

  it('puts pinned chats first in every mode', () => {
    for (const sort of ['recent', 'manual', 'progress'] as const) expect(sortChats(chats, sort, 'tabs-and-chats')[0]?.id).toBe('pinned')
  })

  it('sorts by progress only while both sections show', () => {
    expect(sortChats(chats, 'progress', 'tabs-and-chats').map((c) => c.id)).toEqual(['pinned', 'asks', 'working', 'fresh', 'idle'])
    expect(sortChats(chats, 'progress', 'tabs-only').map((c) => c.id)).toEqual(['pinned', 'idle', 'fresh', 'asks', 'working'])
  })

  it('follows the manual list, with chats missing from it on top', () => {
    expect(sortChats(chats, 'manual', 'tabs-and-chats', ['idle', 'working', 'asks']).map((c) => c.id)).toEqual(['pinned', 'fresh', 'idle', 'working', 'asks'])
  })
})

describe('visible order for ⌘1–8', () => {
  it('lists pinned tiles, then chat rows, then tabs, and skips chat tabs whose row is listed', () => {
    const chatTab = tab('t-chat', { url: 'apex://chat/c1' })
    const order = visibleOrder([tab('p', { pinned: true })], ['c1', 'c2'], [tab('a'), chatTab, tab('b')])
    expect(order).toEqual([
      { kind: 'tab', id: 'p' },
      { kind: 'chat', id: 'c1' },
      { kind: 'chat', id: 'c2' },
      { kind: 'tab', id: 'a' },
      { kind: 'tab', id: 'b' },
    ])
    expect(chatIdOfUrl('apex://chat/c1')).toBe('c1')
    expect(chatIdOfUrl('apex://chats')).toBeNull()
  })
})

describe('drag and drop maths', () => {
  it('finds the slot before the first row whose middle is below the pointer', () => {
    expect(dropIndex([10, 30, 50], 5)).toBe(0)
    expect(dropIndex([10, 30, 50], 31)).toBe(2)
    expect(dropIndex([10, 30, 50], 99)).toBe(3)
  })

  it('maps a list drop to main’s order, around rows the list hides', () => {
    const order = ['p1', 'a', 'chat-tab', 'b', 'c']
    // Rows shown: a, b, c. Drag c before b.
    expect(manualMoveIndex(order, 'c', ['a', 'b', 'c'], 1)).toBe(3)
    // Drag a to the end.
    expect(manualMoveIndex(order, 'a', ['a', 'b', 'c'], 2)).toBe(4)
    // Into the pinned block's start.
    expect(manualMoveIndex(order, 'b', ['p1'], 0)).toBe(0)
    expect(moveId(['x', 'y', 'z'], 'z', 0)).toEqual(['z', 'x', 'y'])
  })
})

describe('sidebar fit and helpers', () => {
  it('hides the sidebar when the content card would get too narrow', () => {
    expect(sidebarFits(1440, 260, 390)).toBe(true)
    expect(sidebarFits(1100, 260, 390)).toBe(false) // 450 px of content with the panel
    expect(sidebarFits(820, 260, null)).toBe(true) // 560 px alone
    expect(sidebarFits(820, 360, null)).toBe(false)
  })

  it('matches every word of a filter', () => {
    expect(matchesFilter('', 'anything')).toBe(true)
    expect(matchesFilter('mail inbox', 'Inbox', 'https://mail.example')).toBe(true)
    expect(matchesFilter('mail drafts', 'Inbox', 'https://mail.example')).toBe(false)
  })

  it('finds the next enabled routine run', () => {
    expect(nextRoutineRun([{ enabled: true, nextRunAt: 50 }, { enabled: false, nextRunAt: 10 }, { enabled: true, nextRunAt: 20 }])).toBe(20)
    expect(nextRoutineRun([{ enabled: true, nextRunAt: null }])).toBeNull()
  })
})

describe('open chats', () => {
  const now = 1_000

  it('seeds once from pinned and recent chats, and never from an archived one', () => {
    const list = [chat('pin', { pinned: true }), ...Array.from({ length: 8 }, (_, i) => chat(`c${i}`)), chat('old', { archived: true })]
    const state = syncOpenChats(initialOpenChats(now), list)
    expect(state.seeded).toBe(true)
    expect(state.order).toEqual(['pin', ...list.slice(1, 1 + SEED_RECENT).map((c) => c.id)])
    // A second sync leaves the same state alone.
    expect(syncOpenChats(state, list)).toBe(state)
  })

  it('opens chats created since, and reopens a closed chat when it has new activity', () => {
    let state = syncOpenChats(initialOpenChats(now), [])
    state = syncOpenChats(state, [chat('routine-run', { createdAt: now + 5 }), chat('older', { createdAt: now - 5 })])
    expect(state.order).toEqual(['routine-run'])
    state = closeChat(state, 'routine-run', now + 5, now + 10)
    expect(state.order).toEqual([])
    state = syncOpenChats(state, [chat('routine-run', { createdAt: now + 5, lastActiveAt: now + 8 })])
    expect(state.order).toEqual([])
    state = syncOpenChats(state, [chat('routine-run', { createdAt: now + 5, lastActiveAt: now + 30 })])
    expect(state.order).toEqual(['routine-run'])
  })

  it('drops deleted and archived chats, opens on demand and reorders', () => {
    let state = { ...initialOpenChats(now), seeded: true, order: ['a', 'b', 'c'] }
    state = syncOpenChats(state, [chat('a'), chat('c', { archived: true })])
    expect(state.order).toEqual(['a'])
    state = openChat(state, 'z')
    expect(state.order).toEqual(['z', 'a'])
    expect(reorderChat(state, 'z', 1).order).toEqual(['a', 'z'])
  })

  it('Clear and its Undo: the chats come back on top in their order, and stay open', () => {
    let state = { ...initialOpenChats(now), seeded: true, order: ['a', 'b', 'c', 'pin'] }
    for (const id of ['a', 'b', 'c']) state = closeChat(state, id, now, now + 10)
    expect(state.order).toEqual(['pin'])
    state = openChat(state, 'new')
    state = reopenChats(state, ['a', 'b', 'c'])
    expect(state.order).toEqual(['a', 'b', 'c', 'new', 'pin'])
    expect(state.closed).toEqual({})
    // No longer closed: a later sync keeps them, activity or not.
    const list = ['a', 'b', 'c', 'new', 'pin'].map((id) => chat(id))
    expect(syncOpenChats(state, list).order).toEqual(['a', 'b', 'c', 'new', 'pin'])
  })

  it('reads stored state defensively', () => {
    expect(parseOpenChats('nonsense', now)).toEqual(initialOpenChats(now))
    const parsed = parseOpenChats({ order: ['a', 'a', 3, 'b'], closed: { x: 5, y: 'no' }, since: 7, seeded: true }, now)
    expect(parsed).toEqual({ order: ['a', 'b'], closed: { x: 5 }, since: 7, seeded: true })
  })
})

describe('menus', () => {
  it('builds the tab menu with counts and never offers bulk close of pinned tabs', () => {
    const tabs = [tab('p', { pinned: true }), tab('a'), tab('b'), tab('c')]
    const items = tabMenu({ tab: tabs[1] as TabInfo, tabs, split: null, closedCount: 0, bookmarked: false, splitCandidates: tabs })
    const byId = Object.fromEntries(items.map((i) => [i.id, i]))
    expect(byId['reopen']?.enabled).toBe(false)
    expect(byId['close-others']?.label).toBe('Close 2 Other Tabs')
    expect(byId['close-below']?.label).toBe('Close 2 Tabs Below')
    expect(byId['close-unpinned']?.label).toBe('Close All 3 Unpinned Tabs')
    expect(byId['split']?.submenu?.map((s) => s.id)).toEqual(['split-with:p', 'split-with:b', 'split-with:c'])
    const inSplit = tabMenu({ tab: tabs[1] as TabInfo, tabs, split: { primaryId: 'a', secondaryId: 'b' }, closedCount: 2, bookmarked: true, splitCandidates: tabs })
    expect(inSplit.some((i) => i.id === 'split-separate')).toBe(true)
    expect(inSplit.some((i) => i.id === 'unbookmark')).toBe(true)
  })

  it('switches the chat menu to its bulk version for several chats', () => {
    const one = chatMenu([chat('a', { unread: true })], { inSidebar: true }).map((i) => i.id)
    expect(one).toEqual(expect.arrayContaining(['open', 'open-new-tab', 'pin', 'mark-read', 'rename', 'duplicate', 'archive', 'export', 'close', 'delete']))
    const many = chatMenu([chat('a', { pinned: true }), chat('b', { pinned: true })], { inSidebar: false })
    expect(many.map((i) => i.id)).not.toContain('rename')
    expect(many.find((i) => i.id === 'unpin')?.label).toBe('Unpin 2 Chats')
    expect(many.find((i) => i.id === 'delete')?.label).toBe('Delete 2 Chats…')
    expect(many.map((i) => i.id)).not.toContain('close')
  })

  it('reflects layout, theme and state in the background and main menus', () => {
    const ctx = { layout: 'sidebar' as const, sidebarOpen: true, theme: 'dark' as const, closedCount: 0, unpinnedCount: 0, bookmarkable: 3 }
    const bg = backgroundMenu(ctx)
    expect(bg.find((i) => i.id === 'reopen')?.enabled).toBe(false)
    expect(bg.find((i) => i.id === 'bookmark-all')?.label).toBe('Bookmark 3 Tabs')
    const appearance = bg.find((i) => i.id === 'appearance')?.submenu ?? []
    expect(appearance.find((i) => i.id === 'theme-dark')?.checked).toBe(true)
    const layout = bg.find((i) => i.id === 'layout')?.submenu ?? []
    expect(layout.find((i) => i.id === 'toggle-sidebar')?.checked).toBe(true)
    const horizontal = backgroundMenu({ ...ctx, layout: 'horizontal' }).find((i) => i.id === 'layout')?.submenu ?? []
    expect(horizontal.some((i) => i.id === 'toggle-sidebar')).toBe(false)

    const main = mainMenu({ ...ctx, hasApiKey: false, bookmarksBar: 'newtab', canBookmark: false })
    expect(main.some((i) => i.id === 'api-key')).toBe(true)
    expect(main.find((i) => i.id === 'bookmark')?.enabled).toBe(false)
    expect(main.find((i) => i.id === 'bookmarks-bar')?.submenu?.find((i) => i.id === 'bar-newtab')?.checked).toBe(true)
    expect(main.some((i) => i.id === 'first-week')).toBe(true)
    expect(mainMenu({ ...ctx, hasApiKey: true, bookmarksBar: 'newtab', canBookmark: false }).some((i) => i.id === 'api-key')).toBe(false)
    // No account or plan items.
    expect(main.some((i) => /account|plan|sign/i.test(i.label))).toBe(false)
  })

  it('offers copy only for web addresses in the pill menu', () => {
    expect(addressMenu({ url: 'apex://chats', showFullUrls: false, canPaste: true }).find((i) => i.id === 'copy')?.enabled).toBe(false)
    expect(addressMenu({ url: 'https://a.example/', showFullUrls: true, canPaste: true }).find((i) => i.id === 'full-urls')?.checked).toBe(true)
  })

  it('counts unread and waiting chats, skipping archived ones', () => {
    expect(chatCounts([chat('a', { unread: true }), chat('b', { status: 'needs-approval' }), chat('c', { needsInput: true, unread: true }), chat('d', { unread: true, archived: true })])).toEqual({ unread: 2, needsInput: 2 })
  })
})

describe('address pill', () => {
  it('shows the host without www, plus the title when there is a path', () => {
    expect(pillParts('https://www.example.com/', 'Example', null)).toMatchObject({ kind: 'web', host: 'example.com', detail: null, insecure: false })
    expect(pillParts('https://example.com/docs?q=1', 'Docs', null)).toMatchObject({ host: 'example.com', detail: 'Docs' })
    // A title that only repeats the address adds nothing.
    expect(pillParts('https://example.com/a', 'https://example.com/a', null).detail).toBeNull()
  })

  it('marks plain http as not secure, except on this machine', () => {
    expect(pillParts('http://example.com/', '', null).insecure).toBe(true)
    expect(pillParts('http://localhost:3000/', '', null).insecure).toBe(false)
  })

  it('uses breadcrumbs for Apex pages and a placeholder for the new tab', () => {
    expect(pillParts('apex://settings/you', 'Settings', ['Settings', 'You'])).toMatchObject({ kind: 'apex', crumbs: ['Settings', 'You'] })
    expect(pillParts('about:blank', '', null).kind).toBe('blank')
    expect(pillParts('file:///tmp/a.txt', '', null).kind).toBe('other')
  })

  it('shortens long hosts in the middle', () => {
    expect(middleEllipsis('abcdefghij', 7)).toBe('abc…hij')
    expect(middleEllipsis('short', 10)).toBe('short')
    const host = pillParts('https://a-very-long-subdomain-name-for-testing.example.com/', '', null).host
    expect(host.length).toBe(32)
    expect(host).toContain('…')
  })

  it('decodes readable addresses but keeps disguising characters encoded', () => {
    expect(fullAddress('https://example.com/caf%C3%A9')).toBe('https://example.com/café')
    expect(fullAddress('https://example.com/a%20b')).toBe('https://example.com/a%20b')
    expect(fullAddress('https://example.com/%E2%80%AEevil')).toBe('https://example.com/%E2%80%AEevil')
    expect(fullAddress('about:blank')).toBe('')
  })
})
