/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { describePackPermissions, emptyCounts, NO_PACK_PERMISSIONS, type PackSummary } from '@shared/packs'
import { cardOpens, cardStatus, countParts, filterPacks, formatBytes, isAdded, kindCounts, needsConfirm, packBadges, packKind, sortPacks, sourceKey } from '../src/renderer/src/packs/logic'

const summary = (over: Partial<PackSummary> = {}): PackSummary => ({
  id: 'p',
  name: 'P',
  version: '1.0.0',
  description: '',
  author: null,
  builtBy: null,
  homepage: null,
  enabled: true,
  source: { kind: 'file' },
  installedAt: 0,
  updatedAt: 0,
  hash: '',
  signature: 'signed',
  keyId: 'k',
  counts: emptyCounts(),
  permissions: [],
  problems: [],
  update: null,
  forkedFrom: null,
  panels: [],
  apps: [],
  waiting: [],
  folder: null,
  ownBytes: 0,
  assetSlots: [],
  secrets: [],
  signIns: [],
  connectorsUsed: [],
  withdrawn: null,
  managed: false,
  waitingFor: [],
  worlds: [],
  optional: [],
  granted: [],
  provides: [],
  uses: [],
  routines: [],
  companions: [],
  connectors: [],
  themes: [],
  cards: [],
  ...over,
})

describe('the Packs page helpers', () => {
  it('lists your packs by name before the ones that come with Apex', () => {
    const sorted = sortPacks([summary({ id: 'z', name: 'Zeta', source: { kind: 'first-party' } }), summary({ id: 'b', name: 'Beta' }), summary({ id: 'a', name: 'Alpha' })])
    expect(sorted.map((p) => p.id)).toEqual(['a', 'b', 'z'])
  })

  it('badges problems, off, updates and unsigned packs', () => {
    expect(packBadges(summary()).map((b) => b.key)).toEqual([])
    const added = describePackPermissions({ contributes: { tools: [{ name: 't', description: 'd', inputSchema: {}, module: 't.js' }] }, permissions: NO_PACK_PERMISSIONS })
    const keys = packBadges(summary({ problems: ['x'], enabled: false, signature: 'unsigned', update: { version: '2.0.0', url: 'https://x', added } })).map((b) => b.key)
    expect(keys).toEqual(['packs.badge.problems', 'packs.badge.off', 'packs.badge.updateApproval', 'packs.badge.unsigned'])
    expect(packBadges(summary({ source: { kind: 'first-party' }, signature: 'first-party' })).map((b) => b.key)).toEqual(['packs.badge.firstParty'])
  })

  it('counts what a pack adds, commands and menu items together', () => {
    expect(countParts({ ...emptyCounts(), skills: 2, commands: 1, menus: 2 })).toEqual([
      { key: 'packs.count.skills', count: 2 },
      { key: 'packs.count.commands', count: 3 },
    ])
  })

  it('asks for a tick only on serious lines, and marks what an update adds', () => {
    const serious = describePackPermissions({ contributes: { panels: [{ id: 'p', title: 'P', html: 'p.html' }] }, permissions: { ...NO_PACK_PERMISSIONS, sites: ['a.com'], network: ['b.com'] } })
    expect(needsConfirm(serious)).toBe(true)
    expect(needsConfirm(serious.filter((l) => l.level !== 'danger'))).toBe(false)
    expect(isAdded(serious[0]!, [serious[0]!])).toBe(true)
    expect(sourceKey({ kind: 'index', url: 'https://i' })).toBe('packs.source.index')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('names a pack by the main thing it brings', () => {
    const counts = (over: Partial<ReturnType<typeof emptyCounts>>) => ({ ...emptyCounts(), ...over })
    const app = { id: 'main', name: 'Main', kind: 'tool' as const, build: 'kit' as const, sidebar: false }
    // Worlds' viewer is an app, but the pack is a world.
    expect(packKind(summary({ worlds: [{ ref: 'w/town', name: 'Town' }], apps: [app], counts: counts({ worlds: 1, apps: 1 }) }))).toBe('world')
    expect(packKind(summary({ apps: [app, { ...app, id: 'g', kind: 'game' }], counts: counts({ apps: 2 }) }))).toBe('game')
    expect(packKind(summary({ panels: [{ id: 'p', title: 'P', sidebar: true }], counts: counts({ panels: 1, skills: 3 }) }))).toBe('app')
    expect(packKind(summary({ counts: counts({ companions: 1, themes: 1 }) }))).toBe('companion')
    expect(packKind(summary({ counts: counts({ themes: 2 }) }))).toBe('look')
    expect(packKind(summary({ counts: counts({ skills: 11 }) }))).toBe('skills')
    expect(packKind(summary({ counts: counts({ tweaks: 1, menus: 1 }) }))).toBe('tools')
    expect(packKind(summary())).toBe('pack')
  })

  it('filters by type and search, and counts only the types you have', () => {
    const packs = [summary({ id: 'a', name: 'Arcade', apps: [{ id: 'g', name: 'G', kind: 'game', build: 'kit', sidebar: false }] }), summary({ id: 's', name: 'Study', description: 'Flash cards', counts: { ...emptyCounts(), skills: 2 } }), summary({ id: 'n', name: 'Notes', counts: { ...emptyCounts(), skills: 1 } })]
    expect(kindCounts(packs)).toEqual([
      { kind: 'game', count: 1 },
      { kind: 'skills', count: 2 },
    ])
    expect(filterPacks(packs, 'skills', '').map((p) => p.id)).toEqual(['s', 'n'])
    expect(filterPacks(packs, 'all', 'flash').map((p) => p.id)).toEqual(['s'])
    expect(filterPacks(packs, 'game', 'flash')).toEqual([])
  })

  it('says one thing on a card, what needs you first', () => {
    expect(cardStatus(summary())).toBeNull()
    expect(cardStatus(summary({ enabled: false }))?.key).toBe('packs.badge.off')
    expect(cardStatus(summary({ enabled: false, problems: ['x'] }))?.key).toBe('packs.tile.attention')
    expect(cardStatus(summary({ enabled: false, update: { version: '2.0.0', url: 'https://x', added: [] } }))?.key).toBe('packs.tile.update')
    expect(cardStatus(summary({ waiting: ['Mail'] }))?.key).toBe('packs.badge.waiting')
  })

  it('opens a pack’s one world or one app from its card, and nothing when it has several', () => {
    const app = { id: 'main', name: 'Main', kind: 'tool' as const, build: 'kit' as const, sidebar: false }
    expect(cardOpens(summary({ apps: [app] }))).toEqual({ app: 'main' })
    expect(cardOpens(summary({ apps: [app], worlds: [{ ref: 'w/town', name: 'Town' }] }))).toEqual({ world: 'w/town' })
    expect(cardOpens(summary({ apps: [app, { ...app, id: 'b' }] }))).toBeNull()
    expect(cardOpens(summary())).toBeNull()
  })
})
