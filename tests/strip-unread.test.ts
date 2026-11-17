/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { NO_FINISHED, stepFinished, unreadTabIds } from '../src/renderer/src/components/sidebar/logic/stripUnread'

// SH-21: strip tabs show the unread mark the sidebar rows show.

const tab = (id: string, agentChatId: string | null = null, url = 'https://example.com/') => ({ id, url, agentChatId })

describe('strip unread mark', () => {
  it('marks a background tab once its companion lets go of it', () => {
    let state = stepFinished(NO_FINISHED, [tab('a'), tab('b', 'c1')], 'a', [{ id: 'c1', status: 'running', unread: false }])
    expect(state.finished.size).toBe(0)
    state = stepFinished(state, [tab('a'), tab('b')], 'a', [{ id: 'c1', status: 'idle', unread: true }])
    expect([...state.finished]).toEqual(['b'])
    expect([...unreadTabIds([tab('a'), tab('b')], 'a', [], state.finished)]).toEqual(['b'])
    // Looking at it clears the mark.
    state = stepFinished(state, [tab('a'), tab('b')], 'b', [])
    expect(state.finished.size).toBe(0)
  })

  it('skips a failed run and keeps the same state when nothing changed', () => {
    const running = stepFinished(NO_FINISHED, [tab('a'), tab('b', 'c1')], 'a', [])
    expect(stepFinished(running, [tab('a'), tab('b', 'c1')], 'a', [])).toBe(running)
    const failed = stepFinished(running, [tab('a'), tab('b')], 'a', [{ id: 'c1', status: 'error', unread: true }])
    expect(failed.finished.size).toBe(0)
  })

  it('forgets a closed tab and never marks the tab in front', () => {
    let state = stepFinished(NO_FINISHED, [tab('a'), tab('b', 'c1'), tab('c', 'c2')], 'a', [])
    state = stepFinished(state, [tab('a'), tab('b'), tab('c')], 'a', [])
    expect([...state.finished].sort()).toEqual(['b', 'c'])
    state = stepFinished(state, [tab('a'), tab('c')], 'a', [])
    expect([...state.finished]).toEqual(['c'])
    expect(state.owners.size).toBe(0)
    expect([...unreadTabIds([tab('a'), tab('c')], 'c', [], state.finished)]).toEqual([])
  })

  it('marks a chat page tab whose chat has unread results, except the one in front', () => {
    const tabs = [tab('a', null, 'apex://chat/c1'), tab('b', null, 'apex://chat/c2')]
    const chats = [{ id: 'c1', status: 'idle' as const, unread: true }, { id: 'c2', status: 'idle' as const, unread: false }]
    expect([...unreadTabIds(tabs, 'b', chats, new Set())]).toEqual(['a'])
    expect([...unreadTabIds(tabs, 'a', chats, new Set())]).toEqual([])
  })
})
