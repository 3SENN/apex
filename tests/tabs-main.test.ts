/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) } }))

import { GROUP_COLORS } from '@shared/tabs'
import { TabGroupStore, cleanGroupName, gatherGroup, moveOne, nextGroupColor, skipCollapsed } from '../src/main/tabGroups'
import { pickMediaCard, type MediaTabState } from '../src/main/mediaSessions'
import { pipEligible } from '../src/main/pip'
import { canSleep, type SleepCandidate } from '../src/main/tabSleep'
import { DETACH_MARGIN_PX, contains, ghostGrow, resolveDrop, zoneAt, zoneReach, type DropWindow } from '../src/main/tearOff'
import { LIVE_MS, STALE_MS, ThumbnailCache } from '../src/main/thumbnails'

// The tabs' main side: group operations and the order with collapsed
// groups, the thumbnail cache, sleep and picture-in-picture eligibility, the
// media card's pick and the tear-off's drop resolution.

describe('tab groups (SH-23, SH-24)', () => {
  it('picks the first unused colour, then cycles', () => {
    expect(nextGroupColor([])).toBe(GROUP_COLORS[0])
    expect(nextGroupColor([GROUP_COLORS[0], GROUP_COLORS[1]])).toBe(GROUP_COLORS[2])
    expect(GROUP_COLORS).toContain(nextGroupColor([...GROUP_COLORS]))
  })

  it('trims and caps names', () => {
    expect(cleanGroupName('  Trip  ')).toBe('Trip')
    expect(cleanGroupName(undefined)).toBe('')
    expect(cleanGroupName('x'.repeat(200)).length).toBeLessThanOrEqual(80)
  })

  it('keeps a group together where its first tab is', () => {
    expect(gatherGroup(['a', 'b', 'c', 'd'], new Set(['b', 'd']))).toEqual(['a', 'b', 'd', 'c'])
    expect(gatherGroup(['a', 'b'], new Set())).toEqual(['a', 'b'])
  })

  it('skips tabs of collapsed groups in the ⌘1–8 order', () => {
    const order = [
      { kind: 'tab' as const, id: 'a' },
      { kind: 'chat' as const, id: 'c1' },
      { kind: 'tab' as const, id: 'b' },
    ]
    expect(skipCollapsed(order, (id) => id === 'b')).toEqual(order.slice(0, 2))
  })

  it('moves a tab one place, hopping a whole group and leaving its own at the edge (SH-20)', () => {
    const groupOf = (id: string): string | null => (id === 'b' || id === 'c' ? 'g' : null)
    expect(moveOne(['a', 'b', 'c', 'd'], 'a', 1, groupOf).ids).toEqual(['b', 'c', 'a', 'd'])
    expect(moveOne(['a', 'b', 'c', 'd'], 'c', 1, groupOf)).toEqual({ ids: ['a', 'b', 'c', 'd'], leaveGroup: true })
    expect(moveOne(['a', 'b', 'c', 'd'], 'c', -1, groupOf).ids).toEqual(['a', 'c', 'b', 'd'])
  })

  it('creates, renames, collapses, ungroups and survives a save', () => {
    const store = new TabGroupStore()
    const g = store.create(['t1', 't2'], 'Work')
    expect(store.groupOf('t1')).toBe(g.id)
    expect(store.update(g.id, { collapsed: true }).collapsed).toBe(true)
    expect(store.isHidden('t2')).toBe(true)
    const copy = new TabGroupStore()
    copy.restore(store.serialize())
    expect(copy.all().map((x) => x.name)).toEqual(['Work'])
    // Members come back with their tabs.
    copy.assign('t2', g.id)
    expect(copy.groupOf('t2')).toBe(g.id)
    copy.prune()
    expect(copy.all()).toHaveLength(1)
    store.ungroup(g.id)
    expect(store.groupOf('t1')).toBeNull()
    expect(store.all()).toEqual([])
  })
})

describe('thumbnail cache (SH-28)', () => {
  it('captures once, reuses the frame, and refreshes when stale or live', async () => {
    let now = 1000
    let n = 0
    const capture = vi.fn(async () => `frame-${++n}`)
    const cache = new ThumbnailCache(capture, { now: () => now })
    expect(await cache.get('t')).toBe('frame-1')
    expect(await cache.get('t')).toBe('frame-1')
    now += LIVE_MS + 1
    expect(await cache.get('t', { live: true })).toBe('frame-2')
    now += STALE_MS + 1
    expect(await cache.get('t')).toBe('frame-3')
    cache.drop('t')
    expect(cache.peek('t')).toBeNull()
  })

  it('keeps the old frame when a capture fails', async () => {
    let fail = false
    const cache = new ThumbnailCache(async () => (fail ? null : 'ok'))
    await cache.refresh('t')
    fail = true
    await cache.refresh('t')
    expect(cache.peek('t')).toBe('ok')
  })
})

describe('sleeping tabs and picture-in-picture (SS-07, ST-29)', () => {
  const base: SleepCandidate = { visible: false, pinned: false, audible: false, capturing: false, agentControlled: false, asleep: false, chromeDrawn: false, lastActiveAt: 0 }
  const later = 31 * 60_000

  it('sleeps a background tab after the delay only', () => {
    expect(canSleep(base, later, 30)).toBe(true)
    expect(canSleep(base, 10 * 60_000, 30)).toBe(false)
    expect(canSleep(base, later, null)).toBe(false)
  })

  it('never sleeps pinned, audible, capturing, agent-controlled, visible or chrome-drawn tabs', () => {
    for (const key of ['visible', 'pinned', 'audible', 'capturing', 'agentControlled', 'asleep', 'chromeDrawn'] as const) {
      expect(canSleep({ ...base, [key]: true }, later, 30)).toBe(false)
    }
  })

  it('requests picture-in-picture only for an unmuted page that is not agent-controlled', () => {
    const tab = { audible: true, muted: false, agentControlled: false, chromeDrawn: false }
    expect(pipEligible(tab, true)).toBe(true)
    expect(pipEligible(tab, false)).toBe(false)
    expect(pipEligible({ ...tab, muted: true }, true)).toBe(false)
    expect(pipEligible({ ...tab, agentControlled: true }, true)).toBe(false)
  })
})

describe('the media card (SH-17)', () => {
  const tab = (id: string, patch: Partial<MediaTabState> = {}): MediaTabState => ({ id, title: id, url: `https://${id}.test/`, favicon: null, audible: true, muted: false, visible: false, ...patch })

  it('shows the newest background tab making sound, and hides while it shows', () => {
    const memory = { pausedId: null, dismissed: new Set<string>(), started: ['a', 'b'] }
    expect(pickMediaCard([tab('a'), tab('b')], memory, true)?.tabId).toBe('b')
    expect(pickMediaCard([tab('a'), tab('b', { visible: true })], memory, true)?.tabId).toBe('a')
    expect(pickMediaCard([tab('a')], memory, false)).toBeNull()
  })

  it('remembers the tab it paused and forgets dismissed ones', () => {
    const paused = pickMediaCard([tab('a', { audible: false })], { pausedId: 'a', dismissed: new Set(), started: ['a'] }, true)
    expect(paused).toMatchObject({ tabId: 'a', playing: false })
    expect(pickMediaCard([tab('a')], { pausedId: null, dismissed: new Set(['a']), started: ['a'] }, true)).toBeNull()
  })
})

describe('tear-off drops (SH-30)', () => {
  const content = { x: 100, y: 100, width: 1000, height: 600 }
  const source: DropWindow = { id: 1, bounds: { x: 0, y: 0, width: 1200, height: 800 }, content, sameSession: true }
  const other: DropWindow = { id: 2, bounds: { x: 1300, y: 0, width: 800, height: 800 }, content: { x: 1300, y: 60, width: 800, height: 700 }, sameSession: true }
  const opts = { onList: false, splitBlock: null, tabCount: 3 }

  it('finds the split zone and how far the pointer reaches into it', () => {
    expect(contains(content, { x: 100, y: 100 })).toBe(true)
    expect(zoneAt(content, { x: 150, y: 300 })).toBe('left')
    expect(zoneAt(content, { x: 600, y: 300 })).toBeNull()
    expect(zoneAt(content, { x: 1050, y: 300 })).toBe('right')
    expect(zoneReach(content, { x: 600, y: 300 })).toBe(0)
    expect(zoneReach(content, { x: 1099, y: 300 })).toBeGreaterThan(0.9)
  })

  it('draws the split zones exactly where a drop splits', async () => {
    const { readFileSync } = await import('node:fs')
    const { SPLIT_ZONE_SHARE } = await import('@shared/tabs')
    const css = readFileSync('src/renderer/src/overlay/surfaces/tabs/tabs.css', 'utf8')
    const columns = /\.split-zones \{[^}]*grid-template-columns:\s*([^;]+);/.exec(css)?.[1]?.trim().split(/\s+/).map((c) => Number.parseFloat(c))
    expect(columns).toHaveLength(3)
    const total = (columns ?? []).reduce((a, b) => a + b, 0)
    expect((columns?.[0] ?? 0) / total).toBeCloseTo(SPLIT_ZONE_SHARE)
    expect((columns?.[2] ?? 0) / total).toBeCloseTo(SPLIT_ZONE_SHARE)
    expect(zoneAt(content, { x: 100 + 1000 * SPLIT_ZONE_SHARE - 1, y: 300 })).toBe('left')
    expect(zoneAt(content, { x: 100 + 1000 * (1 - SPLIT_ZONE_SHARE) + 1, y: 300 })).toBe('right')
  })

  it('grows the ghost with distance from the list', () => {
    const list = { x: 0, y: 0, width: 200, height: 600 }
    expect(ghostGrow(list, { x: 100, y: 100 })).toBe(0)
    expect(ghostGrow(list, { x: 320, y: 100 })).toBeCloseTo(0.5)
    expect(ghostGrow(list, { x: 900, y: 100 })).toBe(1)
  })

  it('resolves list, split, move, new-window and nowhere', () => {
    expect(resolveDrop({ x: 50, y: 50 }, 1, [source], { ...opts, onList: true })).toEqual({ kind: 'list' })
    expect(resolveDrop({ x: 150, y: 300 }, 1, [source], opts)).toEqual({ kind: 'split', windowId: 1, side: 'left' })
    expect(resolveDrop({ x: 150, y: 300 }, 1, [source], { ...opts, splitBlock: 'already-split' })).toEqual({ kind: 'none' })
    expect(resolveDrop({ x: 1700, y: 400 }, 1, [source, other], opts)).toEqual({ kind: 'move', windowId: 2 })
    expect(resolveDrop({ x: 1700, y: 400 }, 1, [source, { ...other, sameSession: false }], opts)).toEqual({ kind: 'none' })
    expect(resolveDrop({ x: 3000, y: 400 }, 1, [source], opts)).toEqual({ kind: 'new-window', point: { x: 3000, y: 400 } })
    expect(resolveDrop({ x: 3000, y: 400 }, 1, [source], { ...opts, tabCount: 1 })).toEqual({ kind: 'none' })
  })

  it('keeps a tab let go just past a window’s edge, where the floating sidebar opens from', () => {
    const window15 = { ...source, bounds: { x: 15, y: 0, width: 1200, height: 800 } }
    expect(resolveDrop({ x: 0, y: 400 }, 1, [window15], opts)).toEqual({ kind: 'none' })
    expect(resolveDrop({ x: 15 - DETACH_MARGIN_PX + 1, y: 400 }, 1, [window15], opts)).toEqual({ kind: 'none' })
    expect(resolveDrop({ x: 1215 + DETACH_MARGIN_PX + 1, y: 400 }, 1, [window15], opts)).toEqual({ kind: 'new-window', point: { x: 1215 + DETACH_MARGIN_PX + 1, y: 400 } })
  })
})
