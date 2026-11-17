/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which rows of a list are on screen while they animate in and out. Pure, so
// the row-motion rules are unit-tested; ui/motion.ts wraps it in a hook.

export type PresencePhase = 'enter' | 'idle' | 'exit'

export interface PresenceEntry<T> {
  key: string
  item: T
  phase: PresencePhase
  /** When the phase started (ms, any monotonic clock). */
  since: number
}

/**
 * Merges the next list into what is on screen. New keys enter (or appear
 * idle when `animate` is off, as on first mount); keys that left stay as
 * exiting rows right after the row that preceded them, so the rows below
 * glide up only as they fold away; a key that returns while exiting is
 * revived in place. Merging the same list twice changes nothing.
 */
export function mergePresence<T>(shown: readonly PresenceEntry<T>[], next: readonly T[], keyOf: (item: T) => string, now: number, animate: boolean): PresenceEntry<T>[] {
  const before = new Map(shown.map((e) => [e.key, e]))
  const nextKeys = new Set<string>()
  const result: PresenceEntry<T>[] = []
  for (const item of next) {
    const key = keyOf(item)
    if (nextKeys.has(key)) continue
    nextKeys.add(key)
    const old = before.get(key)
    if (old && old.phase !== 'exit') result.push({ ...old, item })
    else if (old) result.push({ key, item, phase: 'idle', since: now })
    else result.push({ key, item, phase: animate ? 'enter' : 'idle', since: now })
  }
  if (!animate) return result
  // Re-insert leaving rows after their old predecessor (or at the top).
  shown.forEach((entry, index) => {
    if (nextKeys.has(entry.key)) return
    const leaving: PresenceEntry<T> = entry.phase === 'exit' ? entry : { ...entry, phase: 'exit', since: now }
    let at = 0
    for (let i = index - 1; i >= 0; i--) {
      const prevKey = shown[i]!.key
      const pos = result.findIndex((e) => e.key === prevKey)
      if (pos !== -1) {
        at = pos + 1
        break
      }
    }
    result.splice(at, 0, leaving)
  })
  return result
}

/** Drops rows whose exit finished and settles rows whose entrance finished. */
export function settlePresence<T>(entries: readonly PresenceEntry<T>[], now: number, enterMs: number, exitMs: number): PresenceEntry<T>[] {
  let changed = false
  const out: PresenceEntry<T>[] = []
  for (const e of entries) {
    if (e.phase === 'exit' && now - e.since >= exitMs) {
      changed = true
      continue
    }
    if (e.phase === 'enter' && now - e.since >= enterMs) {
      changed = true
      out.push({ ...e, phase: 'idle', since: now })
      continue
    }
    out.push(e)
  }
  return changed ? out : (entries as PresenceEntry<T>[])
}

/** Milliseconds until the next row changes phase on its own, or null when all are idle. */
export function nextPresenceChange<T>(entries: readonly PresenceEntry<T>[], now: number, enterMs: number, exitMs: number): number | null {
  let next: number | null = null
  for (const e of entries) {
    if (e.phase === 'idle') continue
    const left = Math.max(0, (e.phase === 'exit' ? exitMs : enterMs) - (now - e.since))
    next = next === null ? left : Math.min(next, left)
  }
  return next
}

/**
 * The open/close state of one layer: it stays mounted through a short exit.
 * 'closing' lasts `exitMs`; a reopen during it goes straight back to 'open'.
 */
export type LayerState = 'closed' | 'open' | 'closing'

export function nextLayerState(current: LayerState, open: boolean, exitMs: number): LayerState {
  if (open) return 'open'
  if (current === 'closed') return 'closed'
  return exitMs > 0 ? 'closing' : 'closed'
}
