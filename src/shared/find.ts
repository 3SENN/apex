/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Find in page (SH-44): each tab keeps its own open state, query and
// matches in main (find.ts); the find-bar surface shows them. Pure helpers
// for seeding and the count live here.

export interface FindState {
  open: boolean
  query: string
  /** Total matches; 0 with a query means none. */
  matches: number
  /** 1-based index of the active match; 0 when there is none. */
  active: number
  /** A search was sent and its result hasn't come back yet. */
  searching: boolean
}

export const CLOSED_FIND: FindState = { open: false, query: '', matches: 0, active: 0, searching: false }

export const FIND_QUERY_MAX = 512
/** About 250 characters of a selection seed the field. */
export const FIND_SEED_MAX = 250
/** Typing waits this long before searching. */
export const FIND_DEBOUNCE_MS = 60

/**
 * What a page selection seeds the field with (SH-44): the first line,
 * trimmed, at most about 250 characters (cut at a word when it can be), and
 * nothing from a password field.
 */
export function findSeed(selection: string, fromPassword: boolean): string {
  if (fromPassword) return ''
  const line = (selection.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim()
  if (line.length <= FIND_SEED_MAX) return line
  const cut = line.slice(0, FIND_SEED_MAX)
  const space = cut.lastIndexOf(' ')
  return space > FIND_SEED_MAX * 0.6 ? cut.slice(0, space) : cut
}

/** The count the bar shows: n/m, "No matches", or nothing while empty or searching. */
export type FindCount = { kind: 'none' } | { kind: 'searching' } | { kind: 'no-matches' } | { kind: 'count'; active: number; matches: number }

export function findCount(state: FindState): FindCount {
  if (!state.query) return { kind: 'none' }
  if (state.searching) return { kind: 'searching' }
  if (state.matches === 0) return { kind: 'no-matches' }
  return { kind: 'count', active: Math.max(1, state.active), matches: state.matches }
}
