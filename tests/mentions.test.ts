/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { cycleFilter, filterMentions, listKey, mentionToken, orphanedTokens, recordQuery, replaceTrigger, triggerAt, type MentionCandidate } from '../src/renderer/src/chat/logic/mentions'

// @ mentions and # record search (CH-25, CH-08): where a trigger
// starts, how picking rewrites the draft and the caret, the filters, and keys.

describe('triggers', () => {
  it('opens @ only at the start of a word', () => {
    expect(triggerAt('Ask @do', 7)).toEqual({ char: '@', query: 'do', start: 4, end: 7 })
    expect(triggerAt('@', 1)).toEqual({ char: '@', query: '', start: 0, end: 1 })
    expect(triggerAt('mail me@example.com', 19)).toBeNull()
    expect(triggerAt('Ask @do', 3)).toBeNull()
  })

  it('finds the word around a caret inside it', () => {
    expect(triggerAt('see @docs now', 6)).toEqual({ char: '@', query: 'd', start: 4, end: 9 })
  })

  it('searches # only once something follows it', () => {
    expect(recordQuery(triggerAt('#', 1))).toBeNull()
    expect(recordQuery(triggerAt('find #inv', 9))).toBe('inv')
    expect(recordQuery(triggerAt('ask @inv', 8))).toBeNull()
    expect(triggerAt('a#b', 3)).toBeNull()
    expect(triggerAt('##', 2)).toBeNull()
  })

  it('gives up on very long words', () => {
    const long = `@${'x'.repeat(61)}`
    expect(triggerAt(long, long.length)).toBeNull()
  })
})

describe('caret replacement', () => {
  it('puts the token in with one space after it and the caret past the space', () => {
    expect(replaceTrigger('Compare @do', { start: 8, end: 11 }, '@Docs')).toEqual({ text: 'Compare @Docs ', caret: 14 })
    expect(replaceTrigger('Compare @do with that', { start: 8, end: 11 }, '@Docs')).toEqual({ text: 'Compare @Docs with that', caret: 14 })
    expect(replaceTrigger('@do\nnext', { start: 0, end: 3 }, '@Docs')).toEqual({ text: '@Docs\nnext', caret: 5 })
  })

  it('drops the word without leaving a double space', () => {
    expect(replaceTrigger('ask #inv now', { start: 4, end: 8 }, '')).toEqual({ text: 'ask now', caret: 4 })
    expect(replaceTrigger('#inv', { start: 0, end: 4 }, '')).toEqual({ text: '', caret: 0 })
  })
})

describe('candidates and filters', () => {
  const all: MentionCandidate[] = [
    { kind: 'tab', id: 't1', label: 'Harbour notes', detail: 'example.com' },
    { kind: 'tab', id: 't2', label: 'Weather', detail: 'harbourmaster.org' },
    { kind: 'chat', id: 'c1', label: 'Trip planning' },
    { kind: 'companion', id: 'p1', label: 'Juno' },
    { kind: 'connector', id: 'k1', label: 'Notes app' },
  ]

  it('keeps one kind under its filter, and ranks a label start first', () => {
    expect(filterMentions(all, 'tab', 'harb').map((c) => c.id)).toEqual(['t1', 't2'])
    expect(filterMentions(all, 'connector', '').map((c) => c.id)).toEqual(['k1'])
    expect(filterMentions(all, 'all', 'notes').map((c) => c.id)).toEqual(['t1', 'k1'])
    expect(filterMentions(all, 'all', 'zzz')).toEqual([])
  })

  it('shows a few of each kind under All', () => {
    const many: MentionCandidate[] = Array.from({ length: 10 }, (_, i) => ({ kind: 'tab' as const, id: `t${i}`, label: `Tab ${i}` }))
    const out = filterMentions([...many, { kind: 'chat', id: 'c', label: 'Chat' }], 'all', '')
    expect(out.filter((c) => c.kind === 'tab')).toHaveLength(3)
    expect(out.some((c) => c.kind === 'chat')).toBe(true)
  })

  it('cycles the filter chips both ways', () => {
    expect(cycleFilter('all', 1)).toBe('tab')
    expect(cycleFilter('all', -1)).toBe('connector')
    expect(cycleFilter('connector', 1)).toBe('all')
  })

  it('makes tokens and notices tokens typed away', () => {
    expect(mentionToken('  Harbour   notes ')).toBe('@Harbour notes')
    expect(mentionToken('')).toBe('@untitled')
    const tokens = new Map([
      ['a1', '@Harbour notes'],
      ['a2', '@Trip planning'],
    ])
    expect(orphanedTokens('Compare @Harbour notes', tokens)).toEqual(['a2'])
  })
})

describe('list keys', () => {
  it('moves and wraps, picks with Enter, changes the filter with Tab and closes with Esc', () => {
    expect(listKey('ArrowDown', false, 3, 2, true)).toEqual({ type: 'move', active: 0 })
    expect(listKey('ArrowUp', false, 3, 0, true)).toEqual({ type: 'move', active: 2 })
    expect(listKey('Enter', false, 3, 1, true)).toEqual({ type: 'pick', index: 1 })
    expect(listKey('Enter', true, 3, 1, true)).toBeNull()
    expect(listKey('Tab', true, 3, 1, true)).toEqual({ type: 'filter', direction: -1 })
    expect(listKey('Tab', false, 3, 1, false)).toEqual({ type: 'pick', index: 1 })
    expect(listKey('Escape', false, 0, -1, true)).toEqual({ type: 'close' })
    expect(listKey('Enter', false, 0, 0, true)).toBeNull()
    expect(listKey('a', false, 3, 0, true)).toBeNull()
  })
})
