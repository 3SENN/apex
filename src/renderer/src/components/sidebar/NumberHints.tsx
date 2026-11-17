/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useLayoutEffect, useState, type ReactElement, type RefObject } from 'react'
import type { OrderEntry } from '@shared/ipc'

// Number hints (SH-22): while ⌘ is held, badges 1–8 mark what ⌘1–8 would
// pick, in the order the list reports to main. They are measured once when
// they show (the list doesn't move while a key is held) and drawn fixed, so
// the same layer works in the sidebar and the strip.

export const HINT_COUNT = 8

/** The element an order entry draws on: tab rows and tiles carry their ids, chat rows their flip key. */
export function hintSelector(entry: OrderEntry): string {
  return entry.kind === 'tab' ? `[data-tab-ids~="${CSS.escape(entry.id)}"]` : `[data-flip="chat:${CSS.escape(entry.id)}"]`
}

interface Badge {
  n: number
  x: number
  y: number
}

/**
 * Where the badges go: one per entry, at most eight, skipping entries not on
 * screen. A split row holds two tabs; only the first of them gets a badge.
 */
export function placeHints(entries: readonly OrderEntry[], find: (entry: OrderEntry) => DOMRect | null, view: { top: number; bottom: number; left: number; right: number }): Badge[] {
  const out: Badge[] = []
  const used = new Set<string>()
  entries.slice(0, HINT_COUNT).forEach((entry, i) => {
    const r = find(entry)
    if (!r || r.bottom <= view.top || r.top >= view.bottom || r.right <= view.left || r.left >= view.right) return
    const key = `${Math.round(r.left)}:${Math.round(r.top)}`
    if (used.has(key)) return
    used.add(key)
    out.push({ n: i + 1, x: r.left + 3, y: r.top + r.height / 2 })
  })
  return out
}

export function NumberHints({ shown, entries, root }: { shown: boolean; entries: readonly OrderEntry[]; root: RefObject<HTMLElement | null> }): ReactElement | null {
  const [badges, setBadges] = useState<Badge[]>([])
  useLayoutEffect(() => {
    const el = root.current
    if (!shown || !el) {
      setBadges([])
      return
    }
    const box = el.getBoundingClientRect()
    setBadges(placeHints(entries, (entry) => el.querySelector(hintSelector(entry))?.getBoundingClientRect() ?? null, box))
  }, [shown, entries, root])
  if (!shown || badges.length === 0) return null
  return (
    <div className="number-hints" aria-hidden>
      {badges.map((b) => (
        <span key={b.n} className="number-hint" style={{ left: b.x, top: b.y }}>
          {b.n}
        </span>
      ))}
    </div>
  )
}
