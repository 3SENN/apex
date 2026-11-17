/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import { foldAgentLog } from '../src/renderer/src/agentLog'
import {
  FIND_QUERY_MAX,
  findCountLabel,
  findEntries,
  findMatches,
  highlightRanges,
  nearestMatch,
  needsOlderPages,
  occurrences,
  stepMatch,
} from '../src/renderer/src/chat/logic/find'

// Find in a chat (CH-37): the index covers the whole folded log, including
// older pages folded in front once they load, so a match in a message that
// isn't rendered yet still counts; the view maps it by occurrence.

const reply = (turnId: string, text: string): AgentEvent => ({ type: 'text-delta', turnId, text })

describe('find in chat', () => {
  it('finds case-insensitively, without overlaps, and returns the ranges', () => {
    expect(occurrences('Banana bANana', 'ana')).toEqual([[1, 4], [8, 11]])
    expect(occurrences('aaaa', 'aa')).toEqual([[0, 2], [2, 4]])
    expect(occurrences('text', '   ')).toEqual([])
    expect(highlightRanges('Lisbon in **May**? Lisbon.', 'lisbon')).toEqual([[0, 6], [19, 25]])
  })

  it('cuts very long queries', () => {
    const long = 'x'.repeat(FIND_QUERY_MAX + 50)
    expect(occurrences('x'.repeat(FIND_QUERY_MAX), long)).toEqual([[0, FIND_QUERY_MAX]])
  })

  it('searches your messages and replies as they render (Markdown removed, skill command hidden)', () => {
    const items = foldAgentLog([
      { type: 'user-message', id: 'u1', text: '/trip plan Lisbon', skill: { id: 's', name: 'trip', builtin: false } },
      reply('t1', 'Here is **Lisbon** in [May](https://x.test).'),
    ]).items
    const entries = findEntries(items)
    expect(entries).toEqual([
      { itemId: 'u1', text: 'plan Lisbon' },
      { itemId: 't1', text: expect.stringContaining('Here is Lisbon in May') },
    ])
    expect(findMatches(entries, 'trip')).toEqual([])
    expect(findMatches(entries, 'lisbon').map((m) => [m.itemId, m.occurrence])).toEqual([
      ['u1', 0],
      ['t1', 0],
    ])
  })

  it('covers older pages folded in front, so matches outside the rendered window still count', () => {
    // An older page (loaded on demand) folds in front of the newer events.
    const older: AgentEvent[] = [{ type: 'user-message', id: 'old', text: 'the alpaca question' }, reply('t0', 'Alpacas hum.')]
    const newer: AgentEvent[] = [{ type: 'user-message', id: 'new', text: 'and llamas?' }, reply('t1', 'Llamas, unlike alpacas, spit.')]
    const loaded = findMatches(findEntries(foldAgentLog(newer).items), 'alpaca')
    const full = findMatches(findEntries(foldAgentLog([...older, ...newer]).items), 'alpaca')
    expect(loaded).toHaveLength(1)
    expect(full.map((m) => m.itemId)).toEqual(['old', 't0', 't1'])
    expect(full[2]).toMatchObject({ start: 15, end: 21 })
    expect(needsOlderPages(3)).toBe(true)
    expect(needsOlderPages(0)).toBe(false)
  })

  it('steps with wrap-around, and keeps your place when the query changes', () => {
    expect(stepMatch(-1, 3, 1)).toBe(0)
    expect(stepMatch(-1, 3, -1)).toBe(2)
    expect(stepMatch(2, 3, 1)).toBe(0)
    expect(stepMatch(0, 3, -1)).toBe(2)
    expect(stepMatch(0, 0, 1)).toBe(-1)
    const entries = [
      { itemId: 'a', text: 'cat' },
      { itemId: 'b', text: 'dog' },
      { itemId: 'c', text: 'cat dog' },
    ]
    const matches = findMatches(entries, 'cat')
    expect(nearestMatch(matches, entries, 'b')).toBe(1)
    // With no previous match, the newest one (the bottom of the chat).
    expect(nearestMatch(matches, entries, null)).toBe(1)
    expect(nearestMatch([], entries, 'a')).toBe(-1)
  })

  it('labels the count', () => {
    const words = { of: 'of', none: 'No results' }
    expect(findCountLabel(0, 12, 'x', words)).toBe('1 of 12')
    expect(findCountLabel(-1, 0, 'x', words)).toBe('No results')
    expect(findCountLabel(-1, 0, '  ', words)).toBe('')
  })
})
