/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// DS-101: the All chats chip row's pure rules, unit-tested. The status chips
// are toggles that share one filter, so pressing one sets it and pressing it
// again clears it; the dropdown chips show their value once one is picked.
import type { ChatFilters } from './list'

export type StatusChip = Exclude<ChatFilters['status'], 'any'>

/** The order of the toggle chips, before the dropdown chips. */
export const STATUS_CHIPS: readonly StatusChip[] = ['unread', 'needs-input', 'archived']

/** Pressing a status chip: on if it was off (replacing another), off if it was on. */
export function toggledStatus(current: ChatFilters['status'], pressed: StatusChip): ChatFilters['status'] {
  return current === pressed ? 'any' : pressed
}

/** A dropdown chip's label: its name at rest, the picked option's label once narrowed. */
export function dropdownChipLabel<V extends string>(value: V, rest: V, name: string, options: readonly { value: V; label: string }[]): string {
  if (value === rest) return name
  return options.find((o) => o.value === value)?.label ?? name
}

/** Best match ranks by the words, so it is offered only while searching. */
export function sortEnabled(sort: ChatFilters['sort'], query: string): boolean {
  return sort !== 'best-match' || query.trim() !== ''
}
