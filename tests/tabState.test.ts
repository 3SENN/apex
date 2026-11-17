/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OrderEntry } from '@shared/ipc'
import { ClosedTabStack, PinnedTabsStore, chatIdOf, currentIndex, effectiveOrder, isRestorableUrl, nthEntry, stepEntry } from '../src/main/tabState'

const tab = (id: string): OrderEntry => ({ kind: 'tab', id })
const chat = (id: string): OrderEntry => ({ kind: 'chat', id })

describe('visible tab order', () => {
  const tabs = [
    { id: 'tab-1', chatId: null },
    { id: 'tab-2', chatId: null },
    { id: 'tab-3', chatId: 'c1' },
  ]

  it("uses main's order until the chrome reports one", () => {
    expect(effectiveOrder(null, tabs)).toEqual([tab('tab-1'), tab('tab-2'), tab('tab-3')])
  })

  it('follows the reported order, drops closed tabs and appends new ones', () => {
    const reported = [tab('tab-2'), chat('c9'), tab('tab-gone'), tab('tab-1')]
    expect(effectiveOrder(reported, [...tabs, { id: 'tab-4', chatId: null }])).toEqual([tab('tab-2'), chat('c9'), tab('tab-1'), tab('tab-3'), tab('tab-4')])
  })

  it("never counts a chat page twice when its chat row is listed", () => {
    const reported = [chat('c1'), tab('tab-1'), tab('tab-2')]
    expect(effectiveOrder(reported, tabs)).toEqual(reported)
  })

  it('finds the active entry by tab or by its chat row', () => {
    const order = [chat('c1'), tab('tab-1'), tab('tab-2')]
    expect(currentIndex(order, { id: 'tab-2', chatId: null })).toBe(2)
    expect(currentIndex(order, { id: 'tab-3', chatId: 'c1' })).toBe(0)
    expect(currentIndex(order, { id: 'tab-9', chatId: null })).toBe(-1)
    expect(currentIndex(order, null)).toBe(-1)
  })

  it('steps with wrap-around', () => {
    const order = [tab('a'), tab('b'), tab('c')]
    expect(stepEntry(order, 2, 1)).toEqual(tab('a'))
    expect(stepEntry(order, 0, -1)).toEqual(tab('c'))
    expect(stepEntry(order, 1, 1)).toEqual(tab('c'))
    expect(stepEntry(order, -1, 1)).toEqual(tab('a'))
    expect(stepEntry(order, -1, -1)).toEqual(tab('c'))
    expect(stepEntry([], 0, 1)).toBeNull()
  })

  it('picks the nth entry and the last for ⌘9', () => {
    const order = [tab('a'), chat('x'), tab('b')]
    expect(nthEntry(order, 1)).toEqual(chat('x'))
    expect(nthEntry(order, 7)).toBeNull()
    expect(nthEntry(order, 'last')).toEqual(tab('b'))
  })

  it('reads the chat id of a chat page', () => {
    expect(chatIdOf('apex://chat/abc-123')).toBe('abc-123')
    expect(chatIdOf('apex://chats')).toBeNull()
    expect(chatIdOf(null)).toBeNull()
  })
})

describe('closed tabs', () => {
  it('reopens newest first, skips blank tabs and keeps a bounded stack', () => {
    const stack = new ClosedTabStack(2)
    stack.push({ url: 'about:blank', title: 'New Tab', pinned: false, index: 0 })
    expect(stack.size).toBe(0)
    stack.push({ url: 'https://a.example/', title: 'A', pinned: false, index: 0 })
    stack.push({ url: 'https://b.example/', title: 'B', pinned: true, index: 1 })
    stack.push({ url: 'apex://chats', title: 'All chats', pinned: false, index: 2 })
    expect(stack.size).toBe(2)
    expect(stack.pop()?.url).toBe('apex://chats')
    expect(stack.pop()?.pinned).toBe(true)
    expect(stack.pop()).toBeNull()
  })

  it('forgets what was pushed after a mark (a Clear that was undone)', () => {
    const stack = new ClosedTabStack()
    stack.push({ url: 'https://kept.example/', title: 'Kept', pinned: false, index: 0 })
    const mark = stack.mark()
    stack.push({ url: 'https://a.example/', title: 'A', pinned: false, index: 1 })
    stack.push({ url: 'about:blank', title: 'New Tab', pinned: false, index: 2 })
    stack.push({ url: 'https://b.example/', title: 'B', pinned: false, index: 2 })
    expect(stack.size).toBe(3)
    stack.dropSince(mark)
    expect(stack.size).toBe(1)
    expect(stack.pop()).toEqual({ url: 'https://kept.example/', title: 'Kept', pinned: false, index: 0 })
  })
})

describe('pinned tabs', () => {
  it('round-trips and keeps only restorable addresses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-pinned-'))
    const store = new PinnedTabsStore(dir)
    expect(store.load()).toEqual([])
    store.save([
      { url: 'https://mail.example/', title: 'Mail' },
      { url: 'apex://chats', title: 'All chats' },
      { url: 'file:///etc/passwd', title: 'no' },
      { url: 'apex://nope', title: 'no' },
    ])
    expect(store.load()).toEqual([{ url: 'https://mail.example/', title: 'Mail' }, { url: 'apex://chats', title: 'All chats' }])
  })

  it('survives a corrupt file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-pinned-'))
    writeFileSync(join(dir, 'pinned-tabs.json'), '{oops')
    expect(new PinnedTabsStore(dir).load()).toEqual([])
    writeFileSync(join(dir, 'pinned-tabs.json'), JSON.stringify([{ url: 'https://ok.example/', title: 'Ok' }, { url: 42 }, 'x']))
    expect(new PinnedTabsStore(dir).load()).toEqual([{ url: 'https://ok.example/', title: 'Ok' }])
  })

  it('restores only web pages and known Apex pages', () => {
    expect(isRestorableUrl('https://a.example/')).toBe(true)
    expect(isRestorableUrl('apex://chat/abc')).toBe(true)
    expect(isRestorableUrl('javascript:alert(1)')).toBe(false)
    expect(isRestorableUrl('apex://chat/../../x')).toBe(false)
  })
})
