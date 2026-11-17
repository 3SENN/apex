/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { SPACE_NEW, SPACE_NONE, spaceChoice, spaceRowId } from '../src/renderer/src/overlay/surfaces/workspace/spaceChoice'

// The overlay space switcher and the Space row's native-menu
// fallback share row ids, and a chosen id reads back as a switch or New project.

describe('space switcher rows', () => {
  it('gives No project and each project its own row id', () => {
    expect(spaceRowId(null)).toBe(SPACE_NONE)
    expect(spaceRowId('p-1')).toBe('space:p-1')
  })

  it('reads a chosen row back', () => {
    expect(spaceChoice(spaceRowId('p-1'))).toEqual({ kind: 'switch', projectId: 'p-1' })
    expect(spaceChoice(SPACE_NONE)).toEqual({ kind: 'switch', projectId: null })
    expect(spaceChoice(SPACE_NEW)).toEqual({ kind: 'new' })
  })

  it('ignores a dismissal, the separator and anything else', () => {
    for (const value of [undefined, null, '', 'space:', 'space:sep', 'tab:1', 42, { kind: 'new' }]) expect(spaceChoice(value)).toBeNull()
  })
})
