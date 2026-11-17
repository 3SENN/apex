/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { randomUUID } from 'node:crypto'
import type { OrderEntry } from '@shared/ipc'
import { GROUP_COLORS, GROUP_NAME_MAX, type GroupColor, type TabGroup } from '@shared/tabs'
import type { SavedGroup } from '@shared/windows'

// Tab groups (SH-23, SH-24): a name, one of Atelier's own colours and a
// collapsed flag, held per window and saved with its session. Pure apart
// from the store's own state, so the rules are unit-tested without Electron.

/** The least-used colour, in palette order, so new groups stay easy to tell apart. */
export function nextGroupColor(used: readonly GroupColor[]): GroupColor {
  const counts = new Map<GroupColor, number>(GROUP_COLORS.map((c) => [c, 0]))
  for (const c of used) counts.set(c, (counts.get(c) ?? 0) + 1)
  let best: GroupColor = GROUP_COLORS[0]
  for (const c of GROUP_COLORS) if ((counts.get(c) ?? 0) < (counts.get(best) ?? 0)) best = c
  return best
}

export function cleanGroupName(name: string | undefined): string {
  return (name ?? '').replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX)
}

/** The visible order without tabs hidden in collapsed groups (⌘1–8 and next/previous skip them). */
export function skipCollapsed(order: readonly OrderEntry[], hidden: (tabId: string) => boolean): OrderEntry[] {
  return order.filter((e) => e.kind !== 'tab' || !hidden(e.id))
}

/**
 * Gathers a group's members into one block where its first member sits,
 * keeping everyone's relative order: a group is always contiguous in the
 * manual order, so it moves and draws as one block.
 */
export function gatherGroup(ids: readonly string[], members: ReadonlySet<string>): string[] {
  const first = ids.findIndex((id) => members.has(id))
  if (first === -1) return ids.slice()
  const block = ids.filter((id) => members.has(id))
  const rest = ids.filter((id) => !members.has(id))
  const before = ids.slice(0, first).filter((id) => !members.has(id)).length
  return [...rest.slice(0, before), ...block, ...rest.slice(before)]
}

/**
 * Tabs joining a group that already has tabs go to the end of its block, so
 * the group stays where it is (gathering at the first member would move the
 * whole group up to a joining tab that sat above it).
 */
export function joinBlock(ids: readonly string[], block: ReadonlySet<string>, adding: readonly string[]): string[] {
  const add = new Set(adding.filter((id) => !block.has(id)))
  const rest = ids.filter((id) => !add.has(id))
  const last = rest.reduce((at, id, i) => (block.has(id) ? i : at), -1)
  if (last === -1) return gatherGroup(ids, new Set([...block, ...add]))
  return [...rest.slice(0, last + 1), ...ids.filter((id) => add.has(id)), ...rest.slice(last + 1)]
}

/**
 * ⌃⇧PageUp/PageDown: moves a tab one place in the manual order. A grouped
 * tab at its block's edge steps out of the group instead of jumping; an
 * ungrouped tab hops over a whole neighbouring group block. `min`/`max`
 * bound the move to the tab's pinned or unpinned block.
 */
export function moveOne(
  ids: readonly string[],
  id: string,
  delta: 1 | -1,
  groupOf: (id: string) => string | null,
  bounds: { min: number; max: number } = { min: 0, max: ids.length - 1 },
): { ids: string[]; leaveGroup: boolean } {
  const from = ids.indexOf(id)
  if (from === -1) return { ids: ids.slice(), leaveGroup: false }
  const own = groupOf(id)
  const neighbourAt = from + delta
  if (own !== null) {
    const neighbour = ids[neighbourAt]
    // At the edge of its block (or the list): leave the group where it stands.
    if (neighbour === undefined || neighbourAt < bounds.min || neighbourAt > bounds.max || groupOf(neighbour) !== own) return { ids: ids.slice(), leaveGroup: true }
    const next = ids.slice()
    next.splice(from, 1)
    next.splice(neighbourAt, 0, id)
    return { ids: next, leaveGroup: false }
  }
  if (neighbourAt < bounds.min || neighbourAt > bounds.max) return { ids: ids.slice(), leaveGroup: false }
  // Hop over the neighbouring group's whole block.
  let to = neighbourAt
  const neighbourGroup = groupOf(ids[neighbourAt] ?? '')
  if (neighbourGroup !== null) {
    while (ids[to + delta] !== undefined && to + delta >= bounds.min && to + delta <= bounds.max && groupOf(ids[to + delta] ?? '') === neighbourGroup) to += delta
  }
  const next = ids.slice()
  next.splice(from, 1)
  next.splice(to, 0, id)
  return { ids: next, leaveGroup: false }
}

/** One window's groups and who belongs to them. */
export class TabGroupStore {
  #groups: TabGroup[] = []
  readonly #member = new Map<string, string>()

  all(): TabGroup[] {
    return this.#groups.map((g) => ({ ...g }))
  }

  get(id: string): TabGroup | undefined {
    const g = this.#groups.find((x) => x.id === id)
    return g ? { ...g } : undefined
  }

  require(id: string): TabGroup {
    const g = this.#groups.find((x) => x.id === id)
    if (!g) throw new Error('That group no longer exists.')
    return g
  }

  groupOf(tabId: string): string | null {
    return this.#member.get(tabId) ?? null
  }

  /** Member ids in the given order. */
  tabsOf(id: string, order: readonly string[]): string[] {
    return order.filter((t) => this.#member.get(t) === id)
  }

  /** True for a tab inside a collapsed group. */
  isHidden(tabId: string): boolean {
    const id = this.#member.get(tabId)
    return id !== undefined && this.#groups.some((g) => g.id === id && g.collapsed)
  }

  create(tabIds: readonly string[], name?: string, id: string = `g-${randomUUID()}`): TabGroup {
    const group: TabGroup = { id, name: cleanGroupName(name), color: nextGroupColor(this.#groups.map((g) => g.color)), collapsed: false }
    this.#groups.push(group)
    this.add(id, tabIds)
    return { ...group }
  }

  update(id: string, patch: { name?: string; color?: GroupColor; collapsed?: boolean }): TabGroup {
    const g = this.require(id)
    if (patch.name !== undefined) g.name = cleanGroupName(patch.name)
    if (patch.color !== undefined) g.color = patch.color
    if (patch.collapsed !== undefined) g.collapsed = patch.collapsed
    return { ...g }
  }

  /** Moves tabs into a group (out of any other), pruning groups left empty. */
  add(id: string, tabIds: readonly string[]): void {
    this.require(id)
    for (const t of tabIds) this.#member.set(t, id)
    this.#prune()
  }

  remove(tabIds: readonly string[]): void {
    for (const t of tabIds) this.#member.delete(t)
    this.#prune()
  }

  /** Ends a group; its tabs stay, ungrouped. */
  ungroup(id: string): void {
    for (const [t, g] of this.#member) if (g === id) this.#member.delete(t)
    this.#groups = this.#groups.filter((g) => g.id !== id)
  }

  serialize(): SavedGroup[] {
    return this.all()
  }

  /** Brings back saved groups; members are set through `add` as the tabs arrive. */
  restore(groups: readonly SavedGroup[]): void {
    for (const g of groups) {
      if (this.#groups.some((x) => x.id === g.id) || !(GROUP_COLORS as readonly string[]).includes(g.color)) continue
      this.#groups.push({ id: g.id, name: cleanGroupName(g.name), color: g.color, collapsed: g.collapsed })
    }
  }

  /** Assigns a restored tab to a restored group (no prune: the rest may still be on the way). */
  assign(tabId: string, groupId: string): void {
    if (this.#groups.some((g) => g.id === groupId)) this.#member.set(tabId, groupId)
  }

  /** Drops groups nothing belongs to any more. */
  prune(): void {
    this.#prune()
  }

  #prune(): void {
    const used = new Set(this.#member.values())
    this.#groups = this.#groups.filter((g) => used.has(g.id))
  }
}
