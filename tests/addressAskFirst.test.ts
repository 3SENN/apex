/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { flattenGroups, type OmniboxCompletion, type OmniboxGroup, type OmniboxRow } from '@shared/omnibox'
import { askFirst, askHinted, completesInline, enterAction, hintQuery, type AskHint } from '../src/renderer/src/overlay/surfaces/address/enter'

// DC-14: the address bar's Ask row follows the decision model. A sure "ask"
// for the text in the field puts the Ask row first and Enter asks; a stale
// hint, a "search", an inline completion or a private window change nothing.

const row = (group: string, id: string, action: OmniboxRow['action']): OmniboxRow => ({ id, group, title: id, action })
const text = 'plan a weekend in porto'
const groups: OmniboxGroup[] = [
  { group: 'typed', rows: [row('typed', 'typed:search', { kind: 'navigate', url: 'https://search.example/?q=plan' })] },
  { group: 'top', rows: [row('top', 'top:porto', { kind: 'navigate', url: 'https://porto.example/' })] },
  { group: 'ask', rows: [row('ask', 'ask', { kind: 'ask', text })] },
  { group: 'suggest', rows: [row('suggest', 'suggest:porto', { kind: 'navigate', url: 'https://search.example/?q=porto' })] },
]
const ask: AskHint = { text, kind: 'ask' }

describe('the Ask row first (DC-14)', () => {
  it('moves the Ask group to the top and keeps the rest in main’s order', () => {
    expect(askFirst(groups).map((g) => g.group)).toEqual(['ask', 'typed', 'top', 'suggest'])
    expect(groups.map((g) => g.group)).toEqual(['typed', 'top', 'ask', 'suggest'])
  })

  it('leaves the order alone without an Ask row, or with it already first', () => {
    const noAsk = groups.filter((g) => g.group !== 'ask')
    expect(askFirst(noAsk)).toEqual(noAsk)
    expect(askFirst(askFirst(groups))).toEqual(askFirst(groups))
    expect(askFirst([])).toEqual([])
  })

  it('makes Enter with no row picked ask the companion, and leaves a picked row to the caller', () => {
    const rows = flattenGroups(askFirst(groups))
    expect(enterAction({ value: text, typed: text, completion: null, rowsFor: text, rows })).toEqual({ kind: 'ask', text })
    // Arrows walk the order on screen: ↓ once is the Ask row, ↓ twice the search.
    expect(rows[0]?.id).toBe('ask')
    expect(rows[1]?.id).toBe('typed:search')
    expect(enterAction({ value: text, typed: text, completion: null, rowsFor: text, rows: flattenGroups(groups) })).toEqual({ kind: 'navigate', url: 'https://search.example/?q=plan' })
  })
})

describe('when the hint stands (DC-14)', () => {
  it('stands only for an "ask" about exactly what is typed now', () => {
    expect(askHinted(ask, text, null)).toBe(true)
    expect(askHinted(ask, `${text} `, null)).toBe(true)
    expect(askHinted(null, text, null)).toBe(false)
    expect(askHinted({ text, kind: 'search' }, text, null)).toBe(false)
    // Typed on after the pause: the hint is for older text and is dropped.
    expect(askHinted(ask, `${text} in may`, null)).toBe(false)
    expect(askHinted(ask, 'plan a weekend', null)).toBe(false)
  })

  it('gives way to an inline completion, but not to a typo hint', () => {
    const inline: OmniboxCompletion = { input: 'weather', text: 'weather.com', url: 'https://weather.com/', typo: false }
    expect(completesInline(inline, 'weather')).toBe(true)
    expect(completesInline(inline, 'weather.com')).toBe(false)
    expect(completesInline({ ...inline, typo: true }, 'weather')).toBe(false)
    expect(completesInline(null, 'weather')).toBe(false)
    expect(askHinted({ text: 'weather', kind: 'ask' }, 'weather', inline)).toBe(false)
    expect(askHinted({ text: 'weather', kind: 'ask' }, 'weather', { ...inline, typo: true })).toBe(true)
  })
})

describe('what is asked about (DC-14)', () => {
  it('asks about plain text, trimmed', () => {
    expect(hintQuery('  how tall is the eiffel tower ', false)).toBe('how tall is the eiffel tower')
  })

  it('never asks in a private window, for an address, or for under three characters', () => {
    expect(hintQuery(text, true)).toBeNull()
    expect(hintQuery('example.com', false)).toBeNull()
    expect(hintQuery('https://example.com/a?b=1', false)).toBeNull()
    expect(hintQuery('localhost:3000', false)).toBeNull()
    expect(hintQuery('hi', false)).toBeNull()
    expect(hintQuery('   ', false)).toBeNull()
  })
})
