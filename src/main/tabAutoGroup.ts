/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describeHost } from '@shared/domains'
import type { TabInfo } from '@shared/ipc'
import type { TabGroup } from '@shared/tabs'
import { decider } from './decisions/service'
import { tabPlace, type TabPlace, type TabTopic } from './decisions/uses'

// "Group tabs" (DC-18): gathers a window's ungrouped, unpinned web tabs into
// groups. The rule groups tabs that share a site, meaning the registrable
// domain (mail.google.com and docs.google.com are both google.com), when two
// or more do. With the decision model on for tabs, each tab is first placed
// in one of the window's named groups or under a topic; a topic with two or
// more tabs becomes a group, and single-topic leftovers and unsure answers
// go by site. A site or topic named like an existing group joins it. Pinned
// tabs and tabs already in a group never move. The planner is pure; the
// tabs feature applies the plan and offers Undo.

/** At most this many tabs are asked about per run; the rest go by site. */
export const AUTO_GROUP_ASK_MAX = 50
/** Questions in flight at once. */
const ASK_AT_ONCE = 4
/** A run waits this long for the model at most; tabs it hasn't answered by then go by site. */
export const AUTO_GROUP_BUDGET_MS = 4_000

export type GroupableTab = Pick<TabInfo, 'id' | 'url' | 'title' | 'pinned' | 'groupId'>

export interface TabGroupPlan {
  /** Tabs joining groups the window already has. */
  join: { groupId: string; tabIds: string[] }[]
  /** New groups, in the order their first tab sits. */
  create: { name: string; tabIds: string[] }[]
}

/** The tabs a run may move: unpinned, ungrouped web pages, in window order (only `only` when given). */
export function groupCandidates(tabs: readonly GroupableTab[], only?: readonly string[]): GroupableTab[] {
  const pick = only && only.length > 0 ? new Set(only) : null
  return tabs.filter((t) => !t.pinned && t.groupId === null && /^https?:\/\//i.test(t.url) && (!pick || pick.has(t.id)))
}

/** The window's groups that have a name, in order: the ones the model may pick (an answer's index points here). */
export function namedGroups(groups: readonly TabGroup[]): TabGroup[] {
  return groups.filter((g) => g.name.trim() !== '')
}

/** A tab's site: its registrable domain, and the short name a group of it gets ("github", or the address for an IP). */
export function siteOf(url: string): { key: string; name: string } | null {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  const { registrable } = describeHost(host)
  if (!registrable) return null
  const address = /^[\d.]+$/.test(registrable) || registrable.includes(':')
  return { key: registrable, name: address ? registrable : (registrable.split('.')[0] ?? registrable) }
}

/** The site's short name as its pages write it ("GitHub" from "Issues · GitHub"), else as the address has it. */
export function siteName(name: string, titles: readonly string[]): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const word = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu')
  const seen = new Map<string, number>()
  for (const title of titles) {
    const found = word.exec(title)?.[0]
    if (found) seen.set(found, (seen.get(found) ?? 0) + 1)
  }
  let best = name
  let most = 0
  for (const [form, count] of seen) {
    if (count > most) {
      best = form
      most = count
    }
  }
  return best
}

/**
 * The plan for a run. `groups` are the window's named groups as offered to
 * the model, so `{ group: i }` means `groups[i]`; `answers` holds the
 * model's sure places (none with the model off).
 */
export function planTabGroups(candidates: readonly GroupableTab[], groups: readonly Pick<TabGroup, 'id' | 'name'>[], answers: ReadonlyMap<string, TabPlace>, topicName: (topic: TabTopic) => string): TabGroupPlan {
  const index = new Map(candidates.map((t, i) => [t.id, i]))
  const at = (id: string | undefined): number => (id === undefined ? Infinity : (index.get(id) ?? Infinity))
  const inOrder = (ids: readonly string[]): string[] => [...new Set(ids)].sort((a, b) => at(a) - at(b))
  const key = (name: string): string => name.trim().toLocaleLowerCase()

  const existing = new Map<string, string>()
  for (const g of groups) if (g.name.trim() && !existing.has(key(g.name))) existing.set(key(g.name), g.id)
  const join = new Map<string, string[]>()
  const created = new Map<string, { name: string; tabIds: string[] }>()
  const joinGroup = (groupId: string, ids: readonly string[]): void => void join.set(groupId, [...(join.get(groupId) ?? []), ...ids])
  /** Puts tabs under a name: into the group already called that, else a new group when two or more share it. */
  const place = (name: string, tabs: readonly GroupableTab[]): boolean => {
    const ids = tabs.map((t) => t.id)
    const groupId = existing.get(key(name))
    if (groupId) {
      joinGroup(groupId, ids)
      return true
    }
    const made = created.get(key(name))
    if (made) {
      made.tabIds.push(...ids)
      return true
    }
    if (tabs.length < 2) return false
    created.set(key(name), { name, tabIds: ids })
    return true
  }

  const byTopic = new Map<TabTopic, GroupableTab[]>()
  const bySite: GroupableTab[] = []
  for (const tab of candidates) {
    const answer = answers.get(tab.id) ?? null
    const group = answer && 'group' in answer ? groups[answer.group] : undefined
    if (group) joinGroup(group.id, [tab.id])
    else if (answer && 'topic' in answer) byTopic.set(answer.topic, [...(byTopic.get(answer.topic) ?? []), tab])
    else bySite.push(tab)
  }
  for (const [topic, tabs] of byTopic) if (!place(topicName(topic), tabs)) bySite.push(...tabs)

  const sites = new Map<string, { name: string; tabs: GroupableTab[] }>()
  for (const tab of [...bySite].sort((a, b) => at(a.id) - at(b.id))) {
    const site = siteOf(tab.url)
    if (!site) continue
    const entry = sites.get(site.key) ?? { name: site.name, tabs: [] }
    entry.tabs.push(tab)
    sites.set(site.key, entry)
  }
  for (const { name, tabs } of sites.values()) place(siteName(name, tabs.map((t) => t.title)), tabs)

  return {
    join: [...join].map(([groupId, ids]) => ({ groupId, tabIds: inOrder(ids) })),
    create: [...created.values()].map((c) => ({ name: c.name, tabIds: inOrder(c.tabIds) })).sort((a, b) => at(a.tabIds[0]) - at(b.tabIds[0])),
  }
}

/**
 * The model's sure place for each tab (the first AUTO_GROUP_ASK_MAX), a few
 * at a time; nothing is asked while it is off for tabs. A private window
 * passes `isPrivate`, so its tabs never leave Atelier and the rule decides.
 */
export async function askPlaces(tabs: readonly GroupableTab[], groupNames: readonly string[], isPrivate: boolean, place: typeof tabPlace = tabPlace, budgetMs = AUTO_GROUP_BUDGET_MS): Promise<Map<string, TabPlace>> {
  const answers = new Map<string, TabPlace>()
  if (!decider().active('tabs')) return answers
  const queue = tabs.slice(0, AUTO_GROUP_ASK_MAX)
  let next = 0
  let over = false
  const work = async (): Promise<void> => {
    while (next < queue.length && !over) {
      const tab = queue[next++]
      if (!tab) continue
      const answer = await place(tab, groupNames, isPrivate).catch(() => null)
      if (answer && !over) answers.set(tab.id, answer)
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([Promise.all(Array.from({ length: Math.min(ASK_AT_ONCE, queue.length) }, work)), new Promise<void>((resolve) => (timer = setTimeout(resolve, budgetMs)))])
  clearTimeout(timer)
  over = true
  return answers
}

/** What a run touches in a window: TabManager's group methods. */
export interface GroupTarget {
  groups(): TabGroup[]
  groupOf(tabId: string): string | null
  find(id: string): { pinned: boolean } | undefined
  createGroup(tabIds: readonly string[], name?: string): TabGroup
  addToGroup(id: string, tabIds: readonly string[]): void
  ungroup(id: string): void
  removeFromGroup(tabIds: readonly string[]): void
}

export interface AppliedGroups {
  tabs: number
  groups: number
  /** Ends the groups the run made and takes the tabs it added out of existing groups; the tabs stay where they are. */
  undo(): void
}

/** Applies a plan, skipping tabs that were closed, pinned or grouped while the model answered. */
export function applyTabGroupPlan(target: GroupTarget, plan: TabGroupPlan): AppliedGroups {
  const free = (id: string): boolean => {
    const tab = target.find(id)
    return tab !== undefined && !tab.pinned && target.groupOf(id) === null
  }
  const live = new Set(target.groups().map((g) => g.id))
  const joined: { groupId: string; tabIds: string[] }[] = []
  const created: string[] = []
  let tabs = 0
  for (const j of plan.join) {
    const ids = j.tabIds.filter(free)
    if (!live.has(j.groupId) || ids.length === 0) continue
    target.addToGroup(j.groupId, ids)
    joined.push({ groupId: j.groupId, tabIds: ids })
    tabs += ids.length
  }
  for (const c of plan.create) {
    const ids = c.tabIds.filter(free)
    if (ids.length < 2) continue
    created.push(target.createGroup(ids, c.name).id)
    tabs += ids.length
  }
  return {
    tabs,
    groups: joined.length + created.length,
    undo: () => {
      const now = new Set(target.groups().map((g) => g.id))
      for (const id of created) if (now.has(id)) target.ungroup(id)
      for (const j of joined) {
        const still = j.tabIds.filter((id) => target.groupOf(id) === j.groupId)
        if (still.length > 0) target.removeFromGroup(still)
      }
    },
  }
}

/** One run over a window's tabs (TabInfo, in window order): ask (when the model is on), plan, apply. */
export async function groupTabs(
  target: GroupTarget,
  tabs: readonly GroupableTab[],
  options: { isPrivate: boolean; only?: readonly string[]; topicName(topic: TabTopic): string; asking?(): void },
): Promise<AppliedGroups & { byTopic: boolean }> {
  const candidates = groupCandidates(tabs, options.only)
  const groups = namedGroups(target.groups())
  if (candidates.length > 0 && !options.isPrivate && decider().active('tabs')) options.asking?.()
  const answers = await askPlaces(candidates, groups.map((g) => g.name), options.isPrivate)
  const plan = planTabGroups(candidates, groups, answers, options.topicName)
  // By topic only when the model placed something: in compare mode, or when it was unsure of every tab, it went by site.
  return { ...applyTabGroupPlan(target, plan), byTopic: answers.size > 0 }
}
