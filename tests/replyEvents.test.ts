/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { SHARED_OWNER } from '@shared/chats'
import { memoryChangeEvent, memoryChanges, openedTabIds, partialReason } from '../src/main/agent/replyEvents'

// CH-27's event sources: memory commands, opened tabs and partial replies.

describe('memory-change mapping', () => {
  it('maps create, edits, delete and rename to saved, updated, forgotten and renamed', () => {
    expect(memoryChanges({ command: 'create', path: '/memories/trip.md', file_text: 'x' }, 'nova')).toEqual([{ op: 'saved', owner: 'nova', path: '/memories/trip.md' }])
    expect(memoryChanges({ command: 'str_replace', path: '/memories/trip.md', old_str: 'a', new_str: 'b' }, 'nova')).toEqual([{ op: 'updated', owner: 'nova', path: '/memories/trip.md' }])
    expect(memoryChanges({ command: 'insert', path: '/memories/trip.md', insert_line: 1, insert_text: 'c' }, 'nova')).toEqual([{ op: 'updated', owner: 'nova', path: '/memories/trip.md' }])
    expect(memoryChanges({ command: 'delete', path: '/memories/trip.md' }, 'nova')).toEqual([{ op: 'forgotten', owner: 'nova', path: '/memories/trip.md' }])
    expect(memoryChanges({ command: 'rename', old_path: '/memories/a.md', new_path: '/memories/b.md' }, 'nova')).toEqual([{ op: 'renamed', owner: 'nova', path: '/memories/a.md', to: '/memories/b.md' }])
  })

  it('puts the shared folder under the shared owner, and pre-companion chats wholly there', () => {
    expect(memoryChanges({ command: 'create', path: '/memories/shared/team.md' }, 'nova')).toEqual([{ op: 'saved', owner: SHARED_OWNER, path: '/memories/team.md' }])
    expect(memoryChanges({ command: 'delete', path: '/memories/old.md' }, null)).toEqual([{ op: 'forgotten', owner: SHARED_OWNER, path: '/memories/old.md' }])
  })

  it('gives nothing for a view or a malformed command', () => {
    expect(memoryChanges({ command: 'view', path: '/memories' }, 'nova')).toEqual([])
    expect(memoryChanges({ command: 'explode', path: '/memories' }, 'nova')).toEqual([])
    expect(memoryChanges({ command: 'rename', path: '/memories/a.md' }, 'nova')).toEqual([])
    expect(memoryChanges('create', 'nova')).toEqual([])
    expect(memoryChangeEvent('t1', { command: 'view', path: '/memories' }, 'nova')).toBeNull()
    expect(memoryChangeEvent('t1', { command: 'create', path: '/memories/x.md' }, 'nova')).toEqual({ type: 'memory-change', turnId: 't1', changes: [{ op: 'saved', owner: 'nova', path: '/memories/x.md' }] })
  })
})

describe('tab-opened', () => {
  it('reads tab_opened state changes from browser_state blocks, once each', () => {
    const content = [
      { type: 'text', text: 'Opened.' },
      { type: 'browser_state', state_changes: [{ type: 'tab_opened', tab_id: 'tab-7' }, { type: 'navigated', tab_id: 'tab-1' }] },
      { type: 'browser_state', state_changes: [{ type: 'tab_opened', tab_id: 'tab-7' }, { type: 'tab_opened', tab_id: 'tab-8' }] },
    ]
    expect(openedTabIds(content)).toEqual(['tab-7', 'tab-8'])
    expect(openedTabIds('text')).toEqual([])
    expect(openedTabIds([{ type: 'browser_state', state_changes: null }])).toEqual([])
  })
})

describe('partial reasons', () => {
  const end = { stepLimit: false, cutOff: false, stopped: false, error: false, hadOutput: false }

  it('always marks the step cap and max_tokens', () => {
    expect(partialReason({ ...end, stepLimit: true })).toBe('step-limit')
    expect(partialReason({ ...end, cutOff: true })).toBe('cut-off')
    expect(partialReason({ ...end, stepLimit: true, cutOff: true })).toBe('step-limit')
  })

  it('marks a stop or an error only after some output', () => {
    expect(partialReason({ ...end, stopped: true })).toBeNull()
    expect(partialReason({ ...end, stopped: true, hadOutput: true })).toBe('stopped')
    expect(partialReason({ ...end, error: true })).toBeNull()
    expect(partialReason({ ...end, error: true, hadOutput: true })).toBe('error')
    expect(partialReason({ ...end, hadOutput: true })).toBeNull()
  })
})
