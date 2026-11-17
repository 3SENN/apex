/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { format } from '@shared/i18n/core'
import { isPseudo, PSEUDO_EXPANSION, pseudoize } from '@shared/i18n/pseudo'

// The en-XA transform keeps messages working while making them stand out.

const letters = (s: string): number => [...s.replace(/\{[^{}]*\}/g, '')].length

describe('pseudo-locale', () => {
  it('accents, brackets and lengthens', () => {
    const out = pseudoize('Settings')
    expect(isPseudo(out)).toBe(true)
    expect(out).toMatch(/^\[Šéţţíñĝš /)
    expect(out.length - 2).toBeGreaterThanOrEqual(Math.ceil('Settings'.length * (1 + PSEUDO_EXPANSION)))
  })

  it('keeps placeholders as written', () => {
    const out = pseudoize('Sign in to {host}')
    expect(out).toContain('{host}')
    expect(format(out, { host: 'example.com' })).toContain('example.com')
  })

  it('keeps plural headers, case names and #', () => {
    const msg = '{count, plural, one {# tab is open.} other {# tabs are open.}}'
    const out = pseudoize(msg)
    expect(out).toContain('{count, plural,')
    expect(out).toContain(' one {')
    expect(out).toContain(' other {')
    expect(format(out, { count: 1 })).toMatch(/^\[1 ţáƀ íš öþéñ\./)
    expect(format(out, { count: 3 })).toMatch(/^\[3 ţáƀš áŕé öþéñ\./)
  })

  it('pads by the longest plural case', () => {
    const out = pseudoize('{n, plural, one {a} other {abcdefghij}}')
    expect(letters(out)).toBeGreaterThan(4)
  })

  it('leaves empty and already-pseudo text alone', () => {
    expect(pseudoize('')).toBe('')
    const once = pseudoize('Close')
    expect(pseudoize(once)).toBe(once)
  })

  it('keeps punctuation and digits', () => {
    expect(pseudoize('Save as PDF…')).toMatch(/^\[Šáṽé áš ÞÐƑ…/)
    expect(pseudoize('Go to entry 3')).toContain('3')
  })
})
