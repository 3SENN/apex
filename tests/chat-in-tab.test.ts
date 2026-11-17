/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import {
  NO_HELD_CHATS,
  PAGE_SHARE,
  canHoldChat,
  clampPageShare,
  heldChatOf,
  holdIn,
  parseHeld,
  planExpand,
  pruneHeld,
  releaseChat,
  releaseTab,
  serializeHeld,
  tabHolding,
} from '../src/renderer/src/chat/logic/inTab'

// DS-65 (CH-03): expanding the side panel turns the same tab into the chat
// page with its web page beside it, not a split across two tabs.

describe('DS-65 expand plan', () => {
  it('holds the chat in a website tab', () => {
    expect(planExpand({ id: 't1', url: 'https://example.com/a' }, false)).toEqual({ kind: 'hold', tabId: 't1' })
  })

  it('turns a new tab into the chat page itself', () => {
    expect(planExpand({ id: 't1', url: '' }, false)).toEqual({ kind: 'navigate', tabId: 't1' })
    expect(planExpand({ id: 't1', url: 'about:blank' }, false)).toEqual({ kind: 'navigate', tabId: 't1' })
  })

  it('opens the chat in its own tab beside an Apex page, a destination or no tab', () => {
    expect(planExpand({ id: 't1', url: 'apex://settings' }, false)).toEqual({ kind: 'open' })
    expect(planExpand({ id: 't1', url: 'https://example.com' }, true)).toEqual({ kind: 'open' })
    expect(planExpand(null, false)).toEqual({ kind: 'open' })
  })

  it('only website tabs can hold a chat', () => {
    expect(canHoldChat('https://example.com')).toBe(true)
    expect(canHoldChat('file:///Users/you/a.pdf')).toBe(true)
    expect(canHoldChat('')).toBe(false)
    expect(canHoldChat('apex://chat/c1')).toBe(false)
  })
})

describe('DS-65 held chats', () => {
  it('records which tab holds which chat', () => {
    const held = holdIn(NO_HELD_CHATS, 't1', 'c1')
    expect(heldChatOf(held, 't1')).toBe('c1')
    expect(heldChatOf(held, 't2')).toBeNull()
    expect(heldChatOf(held, null)).toBeNull()
    expect(tabHolding(held, 'c1')).toBe('t1')
    expect(NO_HELD_CHATS.size).toBe(0)
  })

  it('shows a chat in one tab at a time and one chat per tab', () => {
    let held = holdIn(NO_HELD_CHATS, 't1', 'c1')
    held = holdIn(held, 't2', 'c1')
    expect([...held]).toEqual([['t2', 'c1']])
    held = holdIn(held, 't2', 'c2')
    expect([...held]).toEqual([['t2', 'c2']])
    expect(holdIn(held, 't2', 'c2')).toBe(held)
  })

  it('collapsing lets go of the tab, deleting lets go of the chat', () => {
    const held = holdIn(holdIn(NO_HELD_CHATS, 't1', 'c1'), 't2', 'c2')
    expect([...releaseTab(held, 't1')]).toEqual([['t2', 'c2']])
    expect(releaseTab(held, 'gone')).toBe(held)
    expect([...releaseChat(held, 'c2')]).toEqual([['t1', 'c1']])
    expect(releaseChat(held, 'none')).toBe(held)
  })

  it('drops holds whose tab closed or left its website', () => {
    const held = holdIn(holdIn(holdIn(NO_HELD_CHATS, 't1', 'c1'), 't2', 'c2'), 't3', 'c3')
    const tabs = [
      { id: 't1', url: 'https://example.com/next' },
      { id: 't2', url: 'apex://settings' },
    ]
    expect([...pruneHeld(held, tabs)]).toEqual([['t1', 'c1']])
    const kept = holdIn(NO_HELD_CHATS, 't1', 'c1')
    expect(pruneHeld(kept, tabs)).toBe(kept)
    expect(pruneHeld(NO_HELD_CHATS, [])).toBe(NO_HELD_CHATS)
  })

  it('round-trips through session storage and ignores junk', () => {
    const held = holdIn(holdIn(NO_HELD_CHATS, 't1', 'c1'), 't2', 'c2')
    expect([...parseHeld(serializeHeld(held))]).toEqual([...held])
    expect(parseHeld(null).size).toBe(0)
    expect(parseHeld('not json').size).toBe(0)
    expect(parseHeld('{"t1":"c1"}').size).toBe(0)
    expect([...parseHeld('[["t1","c1"],["t2"],[3,"c"],["t3",""],["t4","c1"]]')]).toEqual([['t4', 'c1']])
  })
})

describe('DS-65 page pane width', () => {
  it('keeps the page between its limits', () => {
    expect(clampPageShare(0.5)).toBe(0.5)
    expect(clampPageShare(0)).toBe(PAGE_SHARE.min)
    expect(clampPageShare(1)).toBe(PAGE_SHARE.max)
    expect(clampPageShare(Number.NaN)).toBe(PAGE_SHARE.default)
  })
})
