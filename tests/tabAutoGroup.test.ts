/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, safeStorage: { isEncryptionAvailable: () => false }, net: { fetch: vi.fn() }, shell: { openExternal: vi.fn() } }))

import type { DecisionAnswer, DecisionRequest, DecisionResult } from '../src/shared/decisions'
import type { TabGroup } from '../src/shared/tabs'
import { RULES_ONLY, setDecider, type Decider } from '../src/main/decisions/service'
import { joinBlock } from '../src/main/tabGroups'
import type { TabPlace, TabTopic } from '../src/main/decisions/uses'
import { backgroundMenu, canAutoGroup, tabMenu } from '../src/renderer/src/components/sidebar/logic/menus'
import type { TabInfo } from '../src/shared/ipc'
import { AUTO_GROUP_ASK_MAX, applyTabGroupPlan, askPlaces, groupCandidates, groupTabs, planTabGroups, siteName, siteOf, type GroupTarget, type GroupableTab } from '../src/main/tabAutoGroup'

// Group tabs (DC-18): by site with the rule, by topic or into your own
// groups with the decision model; pinned and grouped tabs never move.

const tab = (id: string, url: string, title = id, extra: Partial<GroupableTab> = {}): GroupableTab => ({ id, url, title, pinned: false, groupId: null, ...extra })
const topicName = (topic: TabTopic): string => topic[0]!.toUpperCase() + topic.slice(1)
const none = new Map<string, TabPlace>()

/** A decider whose model answers every tab question with `pick(request)` (a choice at 0.9). */
function fakeDecider(pick: (request: DecisionRequest) => string | null, on = true): Decider & { asked: DecisionRequest[] } {
  const asked: DecisionRequest[] = []
  return {
    asked,
    decide: async (call) => {
      const rule = await call.rule
      if (call.private || !on) return rule
      const request = call.request()
      asked.push(request)
      const choice = pick(request)
      if (choice === null) return rule
      const answer: DecisionAnswer = { type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }
      const result: DecisionResult = { answers: { place: answer }, model: 'kev-latest', source: 'model', ms: 50, inputTokens: 40 }
      return call.read(result, rule) ?? rule
    },
    active: (use) => on && use === 'tabs',
    ready: () => on,
    paused: () => false,
    ask: () => Promise.reject(new Error('not used')),
    model: () => Promise.reject(new Error('not used')),
  }
}

/** An in-memory window for applying plans. */
function fakeWindow(tabs: GroupableTab[], groups: TabGroup[] = []): GroupTarget & { member: Map<string, string>; list: TabGroup[] } {
  const member = new Map<string, string>(tabs.filter((t) => t.groupId).map((t) => [t.id, t.groupId as string]))
  const list = groups.slice()
  let n = 0
  return {
    member,
    list,
    groups: () => list.slice(),
    groupOf: (id) => member.get(id) ?? null,
    find: (id) => tabs.find((t) => t.id === id),
    createGroup: (ids, name) => {
      const g: TabGroup = { id: `new-${++n}`, name: name ?? '', color: 'graphite', collapsed: false }
      list.push(g)
      for (const id of ids) member.set(id, g.id)
      return g
    },
    addToGroup: (id, ids) => ids.forEach((t) => member.set(t, id)),
    ungroup: (id) => {
      list.splice(list.findIndex((g) => g.id === id), 1)
      for (const [t, g] of member) if (g === id) member.delete(t)
    },
    removeFromGroup: (ids) => ids.forEach((t) => member.delete(t)),
  }
}

afterEach(() => setDecider(null))

describe('Group tabs: what may move', () => {
  it('takes only ungrouped, unpinned web tabs, and only the given ones when asked', () => {
    const tabs = [tab('a', 'https://a.com'), tab('p', 'https://a.com', 'p', { pinned: true }), tab('g', 'https://a.com', 'g', { groupId: 'g1' }), tab('n', 'apex://newtab'), tab('b', 'about:blank'), tab('c', 'http://c.com')]
    expect(groupCandidates(tabs).map((t) => t.id)).toEqual(['a', 'c'])
    expect(groupCandidates(tabs, ['c', 'p']).map((t) => t.id)).toEqual(['c'])
  })

  it('reads a site as its registrable domain, short-named, and keeps an address for an IP', () => {
    expect(siteOf('https://mail.google.com/x')).toEqual({ key: 'google.com', name: 'google' })
    expect(siteOf('https://www.bbc.co.uk/news')).toEqual({ key: 'bbc.co.uk', name: 'bbc' })
    expect(siteOf('http://127.0.0.1:5173/a')).toEqual({ key: '127.0.0.1', name: '127.0.0.1' })
    expect(siteOf('not a url')).toBeNull()
  })

  it('names a site as its pages write it, else as the address has it', () => {
    expect(siteName('github', ['Issues · GitHub', 'Pull requests · GitHub', 'githubber'])).toBe('GitHub')
    expect(siteName('youtube', ['Cats - YouTube'])).toBe('YouTube')
    expect(siteName('nytimes', ['Morning briefing'])).toBe('nytimes')
  })
})

describe('Group tabs: the plan', () => {
  it('groups two or more tabs of a site with the rule, leaving single sites alone', () => {
    const tabs = [tab('a', 'https://github.com/x', 'Repo · GitHub'), tab('b', 'https://news.site.org'), tab('c', 'https://gist.github.com/y', 'Gist · GitHub'), tab('d', 'https://docs.google.com'), tab('e', 'https://mail.google.com', 'Inbox - Google Mail')]
    const plan = planTabGroups(tabs, [], none, topicName)
    expect(plan.join).toEqual([])
    expect(plan.create).toEqual([
      { name: 'GitHub', tabIds: ['a', 'c'] },
      { name: 'Google', tabIds: ['d', 'e'] },
    ])
  })

  it('adds a site to a group already named like it, even a single tab', () => {
    const plan = planTabGroups([tab('a', 'https://github.com/x')], [{ id: 'g1', name: 'GitHub' }], none, topicName)
    expect(plan).toEqual({ join: [{ groupId: 'g1', tabIds: ['a'] }], create: [] })
  })

  it('follows the model: your groups, topics with two or more tabs, and the site rule for the rest', () => {
    const tabs = [tab('a', 'https://shop.one'), tab('b', 'https://mail.example.com'), tab('c', 'https://shop.two'), tab('d', 'https://news.x.com'), tab('e', 'https://docs.x.com'), tab('f', 'https://cal.example.com')]
    const answers = new Map<string, TabPlace>([
      ['a', { topic: 'shopping' }],
      ['b', { group: 0 }],
      ['c', { topic: 'shopping' }],
      ['d', { topic: 'news' }],
      ['f', { group: 7 }],
    ])
    const plan = planTabGroups(tabs, [{ id: 'g1', name: 'Mail' }], answers, topicName)
    expect(plan.join).toEqual([{ groupId: 'g1', tabIds: ['b'] }])
    // d is the only news tab, so it goes by site with e; f's group doesn't exist, so it goes by site alone.
    expect(plan.create).toEqual([
      { name: 'Shopping', tabIds: ['a', 'c'] },
      { name: 'x', tabIds: ['d', 'e'] },
    ])
  })

  it('puts a topic into the group already called that', () => {
    const answers = new Map<string, TabPlace>([['a', { topic: 'work' }]])
    expect(planTabGroups([tab('a', 'https://a.com')], [{ id: 'g1', name: 'work' }], answers, topicName).join).toEqual([{ groupId: 'g1', tabIds: ['a'] }])
  })
})

describe('Group tabs: applying and undo', () => {
  it('skips tabs that changed meanwhile, and undo puts the groups back as they were', () => {
    const tabs = [tab('a', 'https://a.com'), tab('b', 'https://a.com'), tab('c', 'https://b.com'), tab('d', 'https://b.com', 'd', { pinned: true }), tab('e', 'https://m.com')]
    const win = fakeWindow(tabs, [{ id: 'g1', name: 'Mail', color: 'berry', collapsed: false }])
    const done = applyTabGroupPlan(win, {
      join: [{ groupId: 'g1', tabIds: ['e'] }, { groupId: 'gone', tabIds: ['c'] }],
      create: [{ name: 'a', tabIds: ['a', 'b'] }, { name: 'b', tabIds: ['c', 'd'] }],
    })
    expect(done.tabs).toBe(3)
    expect(done.groups).toBe(2)
    expect(win.list.map((g) => g.name)).toEqual(['Mail', 'a'])
    expect(win.member.get('e')).toBe('g1')
    done.undo()
    expect(win.list.map((g) => g.id)).toEqual(['g1'])
    expect([...win.member]).toEqual([])
  })
})

describe('Group tabs: asking the model', () => {
  it('asks nothing while the model is off for tabs', async () => {
    setDecider(RULES_ONLY)
    const place = vi.fn(async () => ({ topic: 'work' as const }))
    expect((await askPlaces([tab('a', 'https://a.com')], [], false, place)).size).toBe(0)
    expect(place).not.toHaveBeenCalled()
  })

  it('asks about at most 50 tabs, passing the window’s privacy', async () => {
    setDecider(fakeDecider(() => 'work'))
    const tabs = Array.from({ length: AUTO_GROUP_ASK_MAX + 5 }, (_, i) => tab(`t${i}`, `https://s${i}.com`))
    const place = vi.fn(async (_t: { title: string; url: string }, _g: readonly string[], _p: boolean) => ({ topic: 'work' as const }))
    const answers = await askPlaces(tabs, ['Mail'], true, place)
    expect(place).toHaveBeenCalledTimes(AUTO_GROUP_ASK_MAX)
    expect(place.mock.calls.every((c) => c[2] === true && c[1][0] === 'Mail')).toBe(true)
    expect(answers.size).toBe(AUTO_GROUP_ASK_MAX)
  })

  it('stops waiting after its time budget, keeping the answers it has; the rest go by site', async () => {
    setDecider(fakeDecider(() => 'work'))
    const place = vi.fn((t: { title: string; url: string }): Promise<TabPlace> => (t.url === 'https://a.com' ? Promise.resolve({ topic: 'work' }) : new Promise<TabPlace>(() => undefined)))
    const started = Date.now()
    const answers = await askPlaces([tab('a', 'https://a.com'), tab('b', 'https://b.com')], [], false, place, 50)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect([...answers.keys()]).toEqual(['a'])
  })

  it('groups by topic through the real question, into your named group when it picks one', async () => {
    const fake = fakeDecider((request) => {
      const state = request.state as { title: string }
      return /inbox/i.test(state.title) ? 'group_0' : 'work'
    })
    setDecider(fake)
    const tabs = [tab('a', 'https://docs.one.com', 'Plan'), tab('b', 'https://board.two.com', 'Sprint'), tab('c', 'https://mail.three.com', 'Inbox'), tab('p', 'https://x.com', 'p', { pinned: true })]
    const win = fakeWindow(tabs, [{ id: 'g0', name: '', color: 'graphite', collapsed: false }, { id: 'g1', name: 'Mail', color: 'berry', collapsed: false }])
    const done = await groupTabs(win, tabs, { isPrivate: false, topicName })
    expect(done).toMatchObject({ tabs: 3, groups: 2, byTopic: true })
    // The unnamed group isn't offered, so group_0 is "Mail".
    expect(win.member.get('c')).toBe('g1')
    expect(win.list.find((g) => g.name === 'Work')).toBeTruthy()
    expect(win.member.get('a')).toBe(win.member.get('b'))
    expect(win.member.has('p')).toBe(false)
    expect(fake.asked).toHaveLength(3)
  })

  it('keeps the site rule in a private window, sending nothing', async () => {
    const fake = fakeDecider(() => 'work')
    setDecider(fake)
    const tabs = [tab('a', 'https://one.com/a'), tab('b', 'https://one.com/b'), tab('c', 'https://two.com')]
    const win = fakeWindow(tabs)
    const done = await groupTabs(win, tabs, { isPrivate: true, topicName })
    expect(done).toMatchObject({ tabs: 2, groups: 1, byTopic: false })
    expect(win.list.map((g) => g.name)).toEqual(['one'])
    expect(fake.asked).toHaveLength(0)
  })
})

describe('Group tabs: joining a group', () => {
  it('puts joining tabs at the end of the group’s block, so the group stays where it is', () => {
    expect(joinBlock(['a', 'g1', 'g2', 'b'], new Set(['g1', 'g2']), ['a'])).toEqual(['g1', 'g2', 'a', 'b'])
    expect(joinBlock(['g1', 'x', 'b'], new Set(['g1']), ['b'])).toEqual(['g1', 'b', 'x'])
    expect(joinBlock(['a', 'b'], new Set(), ['b'])).toEqual(['a', 'b'])
  })
})

describe('Group tabs: the menus', () => {
  const info = (t: GroupableTab): TabInfo => ({ ...t, favicon: null, loading: false, canGoBack: false, canGoForward: false, crumbs: null }) as unknown as TabInfo

  it('is offered when two tabs could share a group, or one could join a named group', () => {
    const one = [info(tab('a', 'https://a.com')), info(tab('n', 'apex://newtab'))]
    expect(canAutoGroup(one, [])).toBe(false)
    expect(canAutoGroup(one, [{ id: 'g', name: 'Mail', color: 'berry', collapsed: false }])).toBe(true)
    expect(canAutoGroup([...one, info(tab('b', 'https://b.com'))], [])).toBe(true)
  })

  it('sits in the tab menu (counted for a selection) and the background menu', () => {
    const tabs = [info(tab('a', 'https://a.com')), info(tab('b', 'https://b.com')), info(tab('c', 'https://c.com'))]
    const single = tabMenu({ tab: tabs[0]!, tabs, split: null, closedCount: 0, bookmarked: false, splitCandidates: tabs })
    expect(single.find((i) => i.id === 'group-auto')).toMatchObject({ label: 'Group Tabs Automatically', enabled: true })
    const many = tabMenu({ tab: tabs[0]!, tabs, split: null, closedCount: 0, bookmarked: false, splitCandidates: tabs, targets: tabs.slice(0, 2) })
    expect(many.find((i) => i.id === 'group-auto')?.label).toBe('Group 2 Tabs Automatically')
    const bg = backgroundMenu({ layout: 'sidebar', sidebarOpen: true, theme: 'system', closedCount: 0, unpinnedCount: 3, bookmarkable: 3, canGroup: false })
    expect(bg.find((i) => i.id === 'group-auto')?.enabled).toBe(false)
  })
})
