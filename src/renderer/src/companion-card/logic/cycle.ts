/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which companion the switchers step to. Pure, so the card, the new-tab
// picker and their tests agree on the order.

export interface SwitchableCompanion {
  id: string
  hidden: boolean
}

/**
 * The ids the card's previous and next arrows step through: visible
 * companions in creation order. A hidden companion being shown stays in the
 * order at its own place, so the arrows still lead away from it.
 */
export function switcherOrder(items: readonly SwitchableCompanion[], currentId: string | null): string[] {
  return items.filter((c) => !c.hidden || c.id === currentId).map((c) => c.id)
}

/** The next (1) or previous (-1) id, wrapping around; `currentId` itself when it is alone or unknown. */
export function stepCompanion(order: readonly string[], currentId: string, direction: 1 | -1): string {
  const index = order.indexOf(currentId)
  if (index < 0) return order[0] ?? currentId
  if (order.length < 2) return currentId
  return order[(index + direction + order.length) % order.length] ?? currentId
}

/** New-tab picker positions: every visible companion, then an entry that adds one. */
export type PickerSlot = { kind: 'companion'; id: string } | { kind: 'add' }

export function pickerSlots(items: readonly SwitchableCompanion[]): PickerSlot[] {
  return [...items.filter((c) => !c.hidden).map((c): PickerSlot => ({ kind: 'companion', id: c.id })), { kind: 'add' }]
}

/** Steps through picker slots, wrapping from the add entry back to the first companion. */
export function stepSlot(slots: readonly PickerSlot[], index: number, direction: 1 | -1): number {
  if (slots.length === 0) return 0
  const from = index >= 0 && index < slots.length ? index : 0
  return (from + direction + slots.length) % slots.length
}

export function slotIndexOf(slots: readonly PickerSlot[], companionId: string): number {
  return slots.findIndex((s) => s.kind === 'companion' && s.id === companionId)
}

/**
 * Where the card goes after a companion is deleted: the next one in the
 * switcher order, else the previous one, else null (nothing left to show).
 */
export function successorAfterRemoval(items: readonly SwitchableCompanion[], removedId: string): string | null {
  const order = switcherOrder(items, removedId)
  const index = order.indexOf(removedId)
  const rest = order.filter((id) => id !== removedId)
  if (rest.length === 0) return null
  if (index < 0) return rest[0] ?? null
  return rest[index % rest.length] ?? rest[0] ?? null
}

/** Visible companions; hiding or deleting the last one is refused by main and disabled in the UI. */
export function visibleCount(items: readonly SwitchableCompanion[]): number {
  return items.filter((c) => !c.hidden).length
}

/** Whether `id` is the only visible companion, so it can be neither hidden nor deleted. */
export function isLastVisible(items: readonly SwitchableCompanion[], id: string): boolean {
  const target = items.find((c) => c.id === id)
  return target !== undefined && !target.hidden && visibleCount(items) <= 1
}
