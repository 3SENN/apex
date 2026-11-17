/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Multi-select for tab rows (SH-18, SH-25): ⇧-click, ⇧Enter and ⇧Space take
// a range from the active tab, ⌘-click toggles one tab. Main holds the
// selection (tabs.setSelection) so ⌘W and the bulk menu act on it. Pure, so
// the maths is unit-tested.

/** The ids from `anchor` to `target` in the order shown (both ends included). */
export function rangeSelection(order: readonly string[], anchor: string | null, target: string): string[] {
  const to = order.indexOf(target)
  if (to === -1) return []
  const from = anchor === null ? -1 : order.indexOf(anchor)
  if (from === -1) return [target]
  const [a, b] = from <= to ? [from, to] : [to, from]
  return order.slice(a, b + 1)
}

/**
 * ⌘-click: adds or removes one tab. The first toggle also brings in the
 * active tab, so the selection reads as the two you meant.
 */
export function toggleSelection(selection: readonly string[], activeId: string | null, id: string): string[] {
  const base = selection.length === 0 && activeId && activeId !== id ? [activeId] : selection.slice()
  return base.includes(id) ? base.filter((x) => x !== id) : [...base, id]
}

/** What a row's menu acts on: the whole selection when the row is part of it, else that row alone. */
export function menuTargets(selection: readonly string[], tabId: string): string[] {
  return selection.length > 1 && selection.includes(tabId) ? selection.slice() : [tabId]
}

/** A row is drawn selected only while more than one tab is selected. */
export function isSelected(selection: readonly string[], tabId: string): boolean {
  return selection.length > 1 && selection.includes(tabId)
}
