/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings › Dock icon (ST-09): the radio value for a choice and back, and
// which companion a choice points at. Pure, so tested.
import type { Settings } from '@shared/ipc'

export const DOCK_STANDARD = 'standard'

/** The radio value for a choice: 'standard' or the companion's id. */
export function dockValue(choice: Settings['dockIcon']): string {
  return choice.kind === 'companion' ? choice.companionId : DOCK_STANDARD
}

export function dockChoiceFor(value: string): Settings['dockIcon'] {
  return value === DOCK_STANDARD ? { kind: 'standard' } : { kind: 'companion', companionId: value }
}

/** The companion a Dock choice points at, or null for the standard icon (or one that is gone). */
export function chosenCompanion<T extends { id: string }>(choice: Settings['dockIcon'], companions: readonly T[] | null): T | null {
  if (choice.kind !== 'companion' || !companions) return null
  return companions.find((c) => c.id === choice.companionId) ?? null
}
