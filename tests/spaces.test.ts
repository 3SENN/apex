/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { TabsSnapshot } from '@shared/ipc'
import { activeSpace, spaceMoveSpec, spaceMoveTarget, spacesShown, spaceView, type SpaceInfo } from '@shared/workspace'
import { SpaceModel, spaceCommandRows, spaceSwitchUrl } from '../src/main/workspace/spaces'

const projects = [{ id: 'p1', name: 'Garden', color: 'fern' }, { id: 'p2', name: 'Trip', color: 'lagoon' }]

describe('spaces', () => {
  it('puts new tabs in the current space and lists every project', () => {
    const m = new SpaceModel()
    m.add('t1')
    m.add('t2')
    expect(m.switchTo('p1', ['t1', 't2'])).toBeNull()
    m.add('t3')
    m.activated('t3')
    const list = m.list(projects, ['t1', 't2', 't3'], 'No project')
    expect(list.map((s) => [s.projectId, s.tabIds, s.active])).toEqual([
      [null, ['t1', 't2'], false],
      ['p1', ['t3'], true],
      ['p2', [], false],
    ])
    expect(list[1]).toMatchObject({ name: 'Garden', color: 'fern', tabCount: 1 })
  })

  it('switching shows the tab last used in that space, or its first tab', () => {
    const m = new SpaceModel()
    m.add('a1')
    m.add('a2')
    m.activated('a2')
    m.switchTo('p1', ['a1', 'a2'])
    m.add('b1')
    m.activated('b1')
    expect(m.switchTo(null, ['a1', 'a2', 'b1'])).toBe('a2')
    expect(m.switchTo('p1', ['a1', 'a2', 'b1'])).toBe('b1')
    m.remove('b1')
    expect(m.switchTo('p1', ['a1', 'a2'])).toBeNull()
  })

  it('choosing a hidden tab switches to its space; pinned tabs never do', () => {
    const m = new SpaceModel()
    m.add('a1')
    m.switchTo('p1', ['a1'])
    m.add('b1')
    expect(m.activated('a1')).toBe(true)
    expect(m.active()).toBeNull()
    expect(m.activated('pinned', true)).toBe(false)
    expect(m.active()).toBeNull()
  })

  it('moves tabs between spaces and sends a deleted project’s tabs to no project', () => {
    const m = new SpaceModel()
    m.add('a1')
    m.add('a2')
    m.move(['a2'], 'p2')
    expect(m.tabsOf('p2', ['a1', 'a2'])).toEqual(['a2'])
    m.switchTo('p2', ['a1', 'a2'])
    m.dropProject('p2')
    expect(m.active()).toBeNull()
    expect(m.tabsOf(null, ['a1', 'a2'])).toEqual(['a1', 'a2'])
    // A project that no longer exists lists its tabs under "no project".
    m.move(['a1'], 'gone')
    expect(m.list(projects, ['a1', 'a2'], 'No project')[0]?.tabIds).toEqual(['a1', 'a2'])
  })

  it('survives a session round trip', () => {
    const m = new SpaceModel()
    for (const id of ['a1', 'a2']) m.add(id)
    m.activated('a2')
    m.switchTo('p1', ['a1', 'a2'])
    for (const id of ['b1', 'b2']) m.add(id)
    m.activated('b1')
    const saved = m.save(['a1', 'a2', 'b1', 'b2'])
    expect(saved).toEqual([
      { projectId: null, tabIndexes: [0, 1], activeIndex: 1 },
      { projectId: 'p1', tabIndexes: [2, 3], activeIndex: 2 },
    ])
    const restored = new SpaceModel()
    restored.restore(saved, ['n1', 'n2', 'n3', 'n4'], 2)
    expect(restored.active()).toBe('p1')
    expect(restored.tabsOf('p1', ['n1', 'n2', 'n3', 'n4'])).toEqual(['n3', 'n4'])
    expect(restored.switchTo(null, ['n1', 'n2', 'n3', 'n4'])).toBe('n2')
  })

  it('restores a window saved before spaces, and an empty current space', () => {
    const m = new SpaceModel()
    m.restore(undefined, ['x1', 'x2'], 0)
    expect(m.active()).toBeNull()
    expect(m.tabsOf(null, ['x1', 'x2'])).toEqual(['x1', 'x2'])
    const e = new SpaceModel()
    e.add('a1')
    e.switchTo('p2', ['a1'])
    const saved = e.save(['a1'])
    expect(saved).toContainEqual({ projectId: 'p2', tabIndexes: [], activeIndex: -1 })
    const back = new SpaceModel()
    back.restore(saved, ['z1'], -1)
    expect(back.active()).toBe('p2')
  })
})

describe('switching from the command bar and the chrome', () => {
  const info = (projectId: string | null, name: string, tabIds: string[], active = false): SpaceInfo => ({ projectId, name, color: projectId ? 'fern' : null, tabCount: tabIds.length, active, tabIds })
  const labels = { group: 'Spaces', title: (name: string) => `Switch to space “${name}”`, tabs: (n: number) => `${n} tabs`, keyword: 'space' }

  it('peeks at the tab a switch would show without switching', () => {
    const m = new SpaceModel()
    m.add('t1')
    m.add('t2', 'p1')
    m.add('t3', 'p1')
    m.activated('t3')
    m.activated('t1')
    expect(m.active()).toBeNull()
    expect(m.peek('p1', ['t1', 't2', 't3'])).toBe('t3')
    expect(m.active()).toBeNull()
    expect(m.peek('p2', ['t1', 't2', 't3'])).toBeNull()
  })

  it('offers every other space, by name or the word space, showing its tab or the switch address', () => {
    const spaces = [info(null, 'No project', ['t1'], true), info('p1', 'Garden', ['t2']), info('p2', 'Trip', [])]
    const target = (id: string | null): string | null => (id === 'p1' ? 't2' : null)
    expect(spaceCommandRows(spaces, 'garden', target, labels).map((r) => r.action)).toEqual([{ kind: 'switch-tab', tabId: 't2' }])
    const all = spaceCommandRows(spaces, 'space', target, labels)
    expect(all.map((r) => r.id)).toEqual(['space:p1', 'space:p2'])
    expect(all[1]?.action).toEqual({ kind: 'open-internal', url: spaceSwitchUrl('p2') })
    expect(spaceSwitchUrl(null)).toBe('apex://workspace?space=none')
    expect(spaceCommandRows(spaces, 'nothing like it', target, labels)).toEqual([])
    expect(spaceCommandRows([info(null, 'No project', ['t1'], true)], 'space', target, labels)).toEqual([])
  })

  it('shows only the current space’s tabs (pinned ones always), and drops hidden tabs from split and selection', () => {
    const tab = (id: string, pinned = false) => ({ id, pinned }) as unknown as TabsSnapshot['tabs'][number]
    const snapshot = { tabs: [tab('a'), tab('b'), tab('c', true), tab('new')], split: { primaryId: 'a', secondaryId: 'b' }, selection: ['a', 'b'] } as unknown as TabsSnapshot
    const spaces = [info(null, 'No project', ['a'], true), info('p1', 'Garden', ['b'])]
    const view = spaceView(snapshot, spaces)
    expect(view.tabs.map((t) => t.id)).toEqual(['a', 'c', 'new'])
    expect(view.split).toBeNull()
    expect(view.selection).toEqual(['a'])
    expect(spaceView(snapshot, [info(null, 'No project', ['a', 'b'], true)])).toBe(snapshot)
    expect(spaceView(snapshot, null)).toBe(snapshot)
  })

  it('builds the Move to space submenu and reads its clicks', () => {
    const spaces = [info(null, 'No project', ['a'], true), info('p1', 'Garden', ['b'])]
    const spec = spaceMoveSpec(spaces, ['a'], 'Move to space')
    expect(spec?.submenu?.map((i) => [i.id, i.checked, i.enabled])).toEqual([
      ['move-space:none', true, false],
      ['move-space:p1', false, true],
    ])
    expect(spaceMoveSpec([spaces[0]!], ['a'], 'Move to space')).toBeNull()
    expect(spaceMoveTarget('move-space:p1')).toBe('p1')
    expect(spaceMoveTarget('move-space:none')).toBeNull()
    expect(spaceMoveTarget('move-space:menu')).toBeUndefined()
    expect(spaceMoveTarget('project:p1')).toBeUndefined()
    expect(activeSpace(spaces)?.projectId).toBeNull()
    expect(spacesShown(spaces)).toBe(true)
    expect(spacesShown(null)).toBe(false)
  })
})
