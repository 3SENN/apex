/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Spaces: a project's set of tabs within one window. The
// window shows the current space's tabs and hides the rest, which stay
// open in their own spaces; new tabs join the current space; "no project"
// holds everything else. Pinned tabs show in every space. Switching to a
// space shows the tab you last used there (or a new tab when it has none),
// and choosing a hidden tab (the command bar, a link from a chat) switches
// to its space. The model is per window and saved with the window session
// as SavedWindow.spaces.
import type { OmniboxRow } from '@shared/omnibox'
import type { SpaceInfo } from '@shared/workspace'
import type { SavedWindow } from '@shared/windows'

export type SavedSpace = NonNullable<SavedWindow['spaces']>[number]

export class SpaceModel {
  #active: string | null = null
  readonly #member = new Map<string, string | null>()
  readonly #last = new Map<string | null, string>()

  active(): string | null {
    return this.#active
  }

  spaceOf(tabId: string): string | null | undefined {
    return this.#member.get(tabId)
  }

  /** A new tab joins the current space (or the one named). */
  add(tabId: string, projectId: string | null = this.#active): void {
    if (!this.#member.has(tabId)) this.#member.set(tabId, projectId)
  }

  remove(tabId: string): void {
    this.#member.delete(tabId)
    for (const [space, tab] of this.#last) if (tab === tabId) this.#last.delete(space)
  }

  move(tabIds: readonly string[], projectId: string | null): void {
    for (const id of tabIds) {
      const from = this.#member.get(id)
      if (from !== undefined && this.#last.get(from) === id) this.#last.delete(from)
      this.#member.set(id, projectId)
    }
  }

  /**
   * A tab became the active one. Remembers it for its space, and when it
   * belongs to another space, that space becomes current. Pinned tabs belong
   * to every space and never switch. Returns whether the space changed.
   */
  activated(tabId: string, pinned = false): boolean {
    if (pinned) return false
    if (!this.#member.has(tabId)) this.#member.set(tabId, this.#active)
    const space = this.#member.get(tabId) ?? null
    this.#last.set(space, tabId)
    if (space === this.#active) return false
    this.#active = space
    return true
  }

  /**
   * Makes `projectId` the current space. Returns the tab to show: the one
   * last used there, else its first tab in `order`, else null (open a new
   * tab, which then joins the space).
   */
  switchTo(projectId: string | null, order: readonly string[]): string | null {
    this.#active = projectId
    return this.peek(projectId, order)
  }

  /** The tab switching to `projectId` would show, without switching. */
  peek(projectId: string | null, order: readonly string[]): string | null {
    const tabs = this.tabsOf(projectId, order)
    const last = this.#last.get(projectId)
    if (last && tabs.includes(last)) return last
    return tabs[0] ?? null
  }

  /** A project was deleted: its tabs go to "no project". */
  dropProject(projectId: string): void {
    for (const [tab, space] of this.#member) if (space === projectId) this.#member.set(tab, null)
    this.#last.delete(projectId)
    if (this.#active === projectId) this.#active = null
  }

  /** The space's tabs, in `order` (the window's unpinned tabs). */
  tabsOf(projectId: string | null, order: readonly string[]): string[] {
    return order.filter((id) => (this.#member.get(id) ?? null) === projectId)
  }

  /** "No project" first, then every project, each with its tabs. */
  list(projects: ReadonlyArray<{ id: string; name: string; color: string }>, order: readonly string[], noneName: string): SpaceInfo[] {
    const known = new Set(projects.map((p) => p.id))
    // Tabs of a project that no longer exists count as "no project".
    const spaceOf = (id: string): string | null => {
      const s = this.#member.get(id) ?? null
      return s !== null && known.has(s) ? s : null
    }
    const active = this.#active !== null && known.has(this.#active) ? this.#active : null
    const tabsOf = (space: string | null): string[] => order.filter((id) => spaceOf(id) === space)
    const none = tabsOf(null)
    return [
      { projectId: null, name: noneName, color: null, tabCount: none.length, active: active === null, tabIds: none },
      ...projects.map((p) => {
        const ids = tabsOf(p.id)
        return { projectId: p.id, name: p.name, color: p.color, tabCount: ids.length, active: active === p.id, tabIds: ids }
      }),
    ]
  }

  /** The window's spaces for session.json, as indexes into the saved tab list. */
  save(savedOrder: readonly string[]): SavedSpace[] {
    const bySpace = new Map<string | null, number[]>()
    savedOrder.forEach((id, index) => {
      const space = this.#member.get(id) ?? null
      bySpace.set(space, [...(bySpace.get(space) ?? []), index])
    })
    const spaces: SavedSpace[] = []
    for (const [projectId, tabIndexes] of bySpace) {
      const last = this.#last.get(projectId)
      spaces.push({ projectId, tabIndexes, activeIndex: last ? savedOrder.indexOf(last) : -1 })
    }
    // A current space with no tabs still round-trips.
    if (!bySpace.has(this.#active)) spaces.push({ projectId: this.#active, tabIndexes: [], activeIndex: -1 })
    return spaces
  }

  /**
   * Rebuilds the spaces of a restored window. `restoredOrder` holds the new
   * tab ids at the saved indexes; `activeIndex` is the window's active tab.
   */
  restore(saved: readonly SavedSpace[] | undefined, restoredOrder: readonly string[], activeIndex: number): void {
    this.#member.clear()
    this.#last.clear()
    this.#active = null
    for (const space of saved ?? []) {
      for (const index of space.tabIndexes) {
        const id = restoredOrder[index]
        if (id) this.#member.set(id, space.projectId)
      }
      const last = restoredOrder[space.activeIndex]
      if (last) this.#last.set(space.projectId, last)
    }
    for (const id of restoredOrder) if (!this.#member.has(id)) this.#member.set(id, null)
    const activeTab = restoredOrder[activeIndex]
    if (activeTab) this.#active = this.#member.get(activeTab) ?? null
    else {
      // No active tab saved: keep the space that was current (it had no tabs).
      const empty = saved?.find((s) => s.tabIndexes.length === 0)
      this.#active = empty?.projectId ?? null
    }
  }
}

/** The space switch the command bar opens for a space with no tabs (WorkspacePage reads it and switches). */
export function spaceSwitchUrl(projectId: string | null): string {
  return `atelier://workspace?space=${projectId === null ? 'none' : encodeURIComponent(projectId)}`
}

/**
 * Command-bar rows that switch space: every space but the
 * current one, once a project exists, matching every typed word against the
 * space's name or the word "space". A space with tabs switches by showing
 * its tab (activating a tab switches to its space); an empty one goes
 * through spaceSwitchUrl.
 */
export function spaceCommandRows(spaces: readonly SpaceInfo[], text: string, target: (projectId: string | null) => string | null, labels: { group: string; title: (name: string) => string; tabs: (count: number) => string; keyword: string }): OmniboxRow[] {
  if (spaces.length < 2) return []
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const keyword = labels.keyword.toLowerCase()
  return spaces
    .filter((s) => !s.active)
    .filter((s) => {
      const hay = `${s.name} ${keyword} spaces`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
    .map((s): OmniboxRow => {
      const tabId = target(s.projectId)
      return {
        id: `space:${s.projectId ?? 'none'}`,
        group: labels.group,
        title: labels.title(s.name),
        subtitle: labels.tabs(s.tabCount),
        icon: 'space',
        action: tabId ? { kind: 'switch-tab', tabId } : { kind: 'open-internal', url: spaceSwitchUrl(s.projectId) },
      }
    })
}
