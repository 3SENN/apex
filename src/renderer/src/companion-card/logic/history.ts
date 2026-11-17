/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Undo and redo for the look editor. Every pick is a step; a run of changes
// with the same group (one colour drag) collapses into a single step until
// the group is sealed.

export interface History<T> {
  past: T[]
  present: T
  future: T[]
  /** The group the present belongs to while it is still collapsing changes. */
  group: string | null
}

export const HISTORY_LIMIT = 100

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], group: null }
}

/**
 * Records `next` as the present. A change equal to the present is ignored,
 * and one in the same open group replaces the present instead of adding a
 * step. Any new change clears the redo list.
 */
export function pushHistory<T>(history: History<T>, next: T, options: { group?: string | null; same?: (a: T, b: T) => boolean; limit?: number } = {}): History<T> {
  const same = options.same ?? Object.is
  const group = options.group ?? null
  if (same(history.present, next)) return group === history.group ? history : { ...history, group }
  if (group !== null && group === history.group) return { ...history, present: next, future: [] }
  const limit = options.limit ?? HISTORY_LIMIT
  const past = [...history.past, history.present]
  return { past: past.length > limit ? past.slice(past.length - limit) : past, present: next, future: [], group }
}

/** Closes the open group, so the next change in it starts a new step. */
export function sealHistory<T>(history: History<T>): History<T> {
  return history.group === null ? history : { ...history, group: null }
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0
}

export function undoHistory<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1]
  if (previous === undefined) return history
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future], group: null }
}

export function redoHistory<T>(history: History<T>): History<T> {
  const [next, ...future] = history.future
  if (next === undefined) return history
  return { past: [...history.past, history.present], present: next, future, group: null }
}
