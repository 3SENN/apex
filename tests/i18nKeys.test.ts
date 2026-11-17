/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { format, t } from '@shared/i18n/core'
import { EN, EN_FRAGMENTS } from '@shared/i18n/en'

// The catalogue's guard: a key defined in two
// fragments fails. Literal JSX strings are tests/noHardcodedStrings.test.ts's
//, and Dutch parity is tests/i18nParity.test.ts's.

describe('i18n catalogue', () => {
  it('defines every key once, prefixed with its area', () => {
    const seen = new Map<string, string>()
    const dupes: string[] = []
    for (const [area, fragment] of Object.entries(EN_FRAGMENTS)) {
      for (const key of Object.keys(fragment)) {
        if (seen.has(key)) dupes.push(`${key} (${seen.get(key)} and ${area})`)
        seen.set(key, area)
        expect(key.split('.')[0], key).toBe(area)
        expect(key, 'keys are dotted').toMatch(/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)+$/)
      }
    }
    expect(dupes).toEqual([])
    expect(Object.keys(EN).length).toBe(seen.size)
  })

  it('formats {name} and plural messages', () => {
    expect(format('Hello {name}', { name: 'Pip' })).toBe('Hello Pip')
    expect(format('{count, plural, one {# tab} other {# tabs}}', { count: 1 })).toBe('1 tab')
    expect(format('{count, plural, one {# tab} other {# tabs}}', { count: 3 })).toBe('3 tabs')
    expect(format('{count, plural, =0 {No tabs} other {# tabs}}', { count: 0 })).toBe('No tabs')
    expect(format('Keep {missing}', {})).toBe('Keep {missing}')
    expect(t('core.closeWindow.detail', { count: 2 })).toBe('2 tabs are open.')
  })
})
