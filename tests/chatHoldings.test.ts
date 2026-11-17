/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { ChatContextPage } from '@shared/chatContext'
import { clampSelection, compactCount, faviconStack, folderCrumbs, orderChatPages, pagesMenuKey, parentFolder, type PagesMenuKey, type PagesMenuState } from '@shared/filesLogic'

// The chat's holdings (CH-28, CH-34): the pages-in-this-chat menu's
// keyboard reducer, its favicon stack, and folder paths in the files modal.

const page = (over: Partial<ChatContextPage>): ChatContextPage => ({ tabId: 't1', url: 'https://example.test/', title: 'Example', favicon: null, source: 'opened', inContext: true, controlled: false, addedAt: 0, ...over })

const pages = [page({ tabId: 't1', title: 'One' }), page({ tabId: 't2', title: 'Two', controlled: true }), page({ tabId: 't3', title: 'Three' })]

function press(keys: PagesMenuKey[], start: PagesMenuState = { selected: 0 }, list = pages) {
  let state = start
  let effect = { kind: 'none' } as ReturnType<typeof pagesMenuKey>['effect']
  for (const key of keys) ({ state, effect } = pagesMenuKey(state, list, key))
  return { state, effect }
}

describe('pages menu keys', () => {
  it('moves with ↑ and ↓, wrapping at both ends, and jumps with Home and End', () => {
    expect(press(['ArrowDown']).state.selected).toBe(1)
    expect(press(['ArrowDown', 'ArrowDown', 'ArrowDown']).state.selected).toBe(0)
    expect(press(['ArrowUp']).state.selected).toBe(2)
    expect(press(['End']).state.selected).toBe(2)
    expect(press(['End', 'Home']).state.selected).toBe(0)
  })

  it('Enter focuses the selected page and Esc closes', () => {
    expect(press(['ArrowDown', 'ArrowDown', 'Enter']).effect).toEqual({ kind: 'focus', page: pages[2] })
    expect(press(['Escape']).effect).toEqual({ kind: 'close' })
  })

  it('Delete removes the selected page, but not one the agent controls', () => {
    expect(press(['Delete']).effect).toEqual({ kind: 'remove', page: pages[0] })
    expect(press(['ArrowDown', 'Backspace']).effect).toEqual({ kind: 'refused', page: pages[1] })
  })

  it('does nothing harmful on an empty list, and keeps the selection on a row that exists', () => {
    expect(press(['ArrowDown'], { selected: 0 }, []).state.selected).toBe(-1)
    expect(press(['Enter'], { selected: 0 }, []).effect).toEqual({ kind: 'none' })
    expect(press(['Delete'], { selected: 0 }, []).effect).toEqual({ kind: 'none' })
    expect(clampSelection({ selected: 2 }, 2)).toEqual({ selected: 1 })
    expect(clampSelection({ selected: -1 }, 3)).toEqual({ selected: 0 })
    expect(clampSelection({ selected: 4 }, 0)).toEqual({ selected: -1 })
    // A removal shrank the list under the selection: Delete acts on the row that is now selected.
    expect(press(['Delete'], { selected: 2 }, pages.slice(0, 2)).effect).toEqual({ kind: 'refused', page: pages[1] })
  })
})

describe('pages control (CH-34)', () => {
  it('lists open tabs first, newest first, then context-only pages', () => {
    const list = [page({ tabId: null, title: 'Kept', addedAt: 9 }), page({ tabId: 'a', title: 'Old', addedAt: 1 }), page({ tabId: 'b', title: 'New', addedAt: 5 })]
    expect(orderChatPages(list).map((p) => p.title)).toEqual(['New', 'Old', 'Kept'])
  })

  it('stacks at most three favicons and counts every page', () => {
    const many = Array.from({ length: 5 }, (_, i) => page({ tabId: `t${i}`, url: `https://s${i}.test/`, favicon: i === 0 ? 'data:image/png;base64,AA==' : null, addedAt: i }))
    const stack = faviconStack(many)
    expect(stack.count).toBe(5)
    expect(stack.icons).toHaveLength(3)
    expect(stack.icons[0]?.url).toBe('https://s4.test/')
    expect(new Set(stack.icons.map((i) => i.key)).size).toBe(3)
    expect(faviconStack([])).toEqual({ icons: [], count: 0 })
  })
})

describe('chat files modal paths (CH-28)', () => {
  it('goes back one folder at a time, and names each crumb with the path it opens', () => {
    expect(parentFolder('attachments/a/b')).toBe('attachments/a')
    expect(parentFolder('attachments')).toBe('')
    expect(parentFolder('')).toBe('')
    expect(folderCrumbs('tool-results/run 1')).toEqual([
      { name: 'tool-results', path: 'tool-results' },
      { name: 'run 1', path: 'tool-results/run 1' },
    ])
    expect(folderCrumbs('')).toEqual([])
  })

  it('shortens character counts', () => {
    expect([999, 1000, 1250, 9_960, 12_400, 999_499, 999_999, 2_450_000].map(compactCount)).toEqual(['999', '1k', '1.3k', '10k', '12k', '999k', '1M', '2.5M'])
  })
})
