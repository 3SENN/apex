/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The card's list-tab template as plain logic (DS-113, DS-114): the skills
// filter, the routines search and sort, and when a loading skeleton shows.

// ---- skills ----

/** The Skills search row's filter button: every skill, the ones used before, or the unused ones. */
export type SkillUseFilter = 'all' | 'used' | 'unused'

export const SKILL_USE_FILTERS: readonly SkillUseFilter[] = ['all', 'used', 'unused']

export function skillUseMatches(skill: { lastUsedAt: number | null }, filter: SkillUseFilter): boolean {
  if (filter === 'used') return skill.lastUsedAt !== null
  if (filter === 'unused') return skill.lastUsedAt === null
  return true
}

// ---- routines ----

/** The Routines search row's sort button: by name, or by the next run (paused last). */
export type RoutineSort = 'next' | 'name'

interface RoutineLike {
  name: string
  prompt: string
  enabled: boolean
  nextRunAt: number | null
}

/** Every word of the query appears in the routine's name or its prompt. */
export function routineMatches(routine: Pick<RoutineLike, 'name' | 'prompt'>, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = `${routine.name} ${routine.prompt}`.toLowerCase()
  return words.every((w) => haystack.includes(w))
}

/** A sorted copy: by name, or soonest next run first with paused and unscheduled ones after, by name. */
export function sortRoutines<T extends RoutineLike>(routines: readonly T[], sort: RoutineSort): T[] {
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  if (sort === 'name') return [...routines].sort(byName)
  const when = (r: T): number => (r.enabled && r.nextRunAt !== null ? r.nextRunAt : Number.POSITIVE_INFINITY)
  return [...routines].sort((a, b) => {
    const wa = when(a)
    const wb = when(b)
    if (wa !== wb) return wa < wb ? -1 : 1
    return byName(a, b)
  })
}

// ---- loading ----

/** DS-106: the skeleton waits this long for the data before it shows… */
export const SKELETON_DELAY_MS = 100
/** …and once shown, stays at least this long, so it never flashes. */
export const SKELETON_HOLD_MS = 100

/**
 * When the skeleton shows for a load that takes `loadMs`, relative to its
 * start: null when the data beats the delay (nothing flashes), else from the
 * delay until the data is in, held at least SKELETON_HOLD_MS.
 */
export function skeletonWindow(loadMs: number, delay = SKELETON_DELAY_MS, hold = SKELETON_HOLD_MS): { from: number; until: number } | null {
  if (!(loadMs > delay)) return null
  return { from: delay, until: Math.max(loadMs, delay + hold) }
}

// ---- focus ----

/**
 * Whether a list tab's search may take focus as the tab opens (DS-36). Not
 * while the user walks the tab row with the keyboard: a focused tab showing
 * its keyboard ring keeps focus, so the arrow keys keep moving between tabs.
 */
export function shouldTakeFocus(active: Pick<Element, 'getAttribute' | 'matches'> | null): boolean {
  if (!active || active.getAttribute('role') !== 'tab') return true
  try {
    return !active.matches(':focus-visible')
  } catch {
    return true
  }
}
