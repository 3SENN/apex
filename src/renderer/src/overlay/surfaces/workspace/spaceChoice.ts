/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

// The space switcher's row ids, shared by the overlay surface
// and the Space row's native-menu fallback: 'space:none', 'space:<projectId>'
// and 'space:new'.

export const SPACE_NEW = 'space:new'
export const SPACE_NONE = 'space:none'

/** What a chosen row asks for. */
export type SpaceChoice = { kind: 'new' } | { kind: 'switch'; projectId: string | null }

export function spaceRowId(projectId: string | null): string {
  return projectId === null ? SPACE_NONE : `space:${projectId}`
}

/** A chosen row's id as a choice; null for a dismissal or anything else. */
export function spaceChoice(value: unknown): SpaceChoice | null {
  if (typeof value !== 'string') return null
  if (value === SPACE_NEW) return { kind: 'new' }
  if (value === SPACE_NONE) return { kind: 'switch', projectId: null }
  if (value.startsWith('space:') && value.length > 'space:'.length && value !== 'space:sep') return { kind: 'switch', projectId: value.slice('space:'.length) }
  return null
}
