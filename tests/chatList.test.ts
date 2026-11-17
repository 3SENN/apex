/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS, type ChatSummary } from '@shared/chats'
import { foldAgentLog } from '../src/renderer/src/agentLog'
import {
  EMPTY_SELECTION,
  bulkAvailability,
  movePreview,
  previewMessages,
  reduceSelection,
  rowClickAction,
  type SelectionAction,
  type SelectionState,
} from '../src/renderer/src/chat/logic/bulk'
import { POPOVER_LIMIT, popoverKey, popoverRows, popoverState, routineInbox } from '../src/renderer/src/chat/logic/popover'
import { ChatStore, filterChats } from '../src/main/chats'

// All chats' selection mode, bulk actions and preview (CH-48, CH-49), the
// chat-list popover's filters and keys (CH-50), and main's chat list rules
// for private, child, imported and project chats.

function chat(id: string, patch: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title: id,
    createdAt: 0,
    updatedAt: 0,
    lastActiveAt: 0,
    routineId: null,
    companionId: 'pip',
    model: '',
    status: 'idle',
    unread: false,
    pinned: false,
    archived: false,
    needsInput: false,
    draft: false,
    ...CHAT_SUMMARY_FLAG_DEFAULTS,
    ...CHAT_SUMMARY_LINK_DEFAULTS,
    ...patch,
  }
}

const run = (actions: SelectionAction[], from: SelectionState = EMPTY_SELECTION): SelectionState => actions.reduce(reduceSelection, from)
const order = ['a', 'b', 'c', 'd']

describe('selection mode', () => {
  it('enters, toggles, extends a range from the anchor, selects all, clears and ends', () => {
    expect(run([{ type: 'enter' }])).toMatchObject({ active: true, anchor: null })
    const range = run([{ type: 'toggle', id: 'b', range: false, order }, { type: 'toggle', id: 'd', range: true, order }])
    expect([...range.ids]).toEqual(['b', 'c', 'd'])
    expect(range.anchor).toBe('b')
    const off = reduceSelection(range, { type: 'toggle', id: 'c', range: false, order })
    expect([...off.ids]).toEqual(['b', 'd'])
    expect([...run([{ type: 'select-all', order }]).ids]).toEqual(order)
    expect(run([{ type: 'select-all', order }, { type: 'clear' }])).toMatchObject({ active: true, anchor: null })
    expect(run([{ type: 'select-all', order }, { type: 'done' }])).toBe(EMPTY_SELECTION)
  })

  it('prunes chats that left the list, keeping the same state when nothing changed', () => {
    const s = run([{ type: 'select-all', order }])
    expect([...reduceSelection(s, { type: 'prune', present: ['a', 'c'] }).ids]).toEqual(['a', 'c'])
    expect(reduceSelection(s, { type: 'prune', present: order })).toBe(s)
  })

  it('picks the bulk action wording from what is selected', () => {
    expect(bulkAvailability([chat('a', { unread: true }), chat('b')])).toEqual({ count: 2, read: 'mark-read', archive: 'archive', running: false })
    expect(bulkAvailability([chat('a', { archived: true }), chat('b', { archived: true, status: 'running' })])).toEqual({ count: 2, read: 'mark-unread', archive: 'unarchive', running: true })
    expect(bulkAvailability([]).archive).toBe('archive')
  })
})

describe('the preview pane', () => {
  it('moves with ↑ and ↓, clamped at the ends', () => {
    expect(movePreview(order, null, 1)).toBe('a')
    expect(movePreview(order, null, -1)).toBe('d')
    expect(movePreview(order, 'b', 1)).toBe('c')
    expect(movePreview(order, 'd', 1)).toBe('d')
    expect(movePreview(order, 'a', -1)).toBe('a')
    expect(movePreview([], 'a', 1)).toBeNull()
  })

  it('previews on a plain click where there is room, else opens; selection and modifiers win', () => {
    expect(rowClickAction({ previewAvailable: true, selecting: false, shift: false, mod: false })).toBe('preview')
    expect(rowClickAction({ previewAvailable: false, selecting: false, shift: false, mod: false })).toBe('open')
    expect(rowClickAction({ previewAvailable: true, selecting: false, shift: false, mod: true })).toBe('open-new-tab')
    expect(rowClickAction({ previewAvailable: true, selecting: true, shift: false, mod: false })).toBe('toggle')
    expect(rowClickAction({ previewAvailable: true, selecting: false, shift: true, mod: false })).toBe('toggle-range')
  })

  it('shows the latest messages as plain text', () => {
    const items = foldAgentLog([
      { type: 'user-message', id: 'u1', text: 'one' },
      { type: 'text-delta', turnId: 't1', text: '**bold** reply' },
      { type: 'user-message', id: 'u2', text: '   ' },
      { type: 'user-message', id: 'u3', text: 'three' },
    ]).items
    expect(previewMessages(items, (md) => md.replace(/\*\*/g, ''), 2)).toEqual([
      { id: 't1', role: 'assistant', text: 'bold reply' },
      { id: 'u3', role: 'user', text: 'three' },
    ])
  })
})

describe('the chat-list popover', () => {
  const chats = [
    chat('old', { title: 'Old trip', lastActiveAt: 1 }),
    chat('new', { title: 'New trip', lastActiveAt: 5, unread: true }),
    chat('pin', { title: 'Pinned', lastActiveAt: 0, pinned: true }),
    chat('run', { title: 'Morning news', lastActiveAt: 3, routineId: 'r1', unread: true }),
    chat('ask', { title: 'Question', lastActiveAt: 4, needsInput: true }),
    chat('hidden', { title: 'Private trip', private: true, lastActiveAt: 9 }),
    chat('kid', { title: 'Child trip', parentChatId: 'new', lastActiveAt: 9 }),
    chat('gone', { title: 'Archived trip', archived: true, lastActiveAt: 9 }),
    chat('draft', { title: 'Draft trip', draft: true, lastActiveAt: 9 }),
  ]

  it('filters by query and filter, pinned first then newest, never private, child, archived or draft chats', () => {
    expect(popoverRows(chats, '', 'all').map((c) => c.id)).toEqual(['pin', 'new', 'ask', 'run', 'old'])
    expect(popoverRows(chats, 'trip', 'all').map((c) => c.id)).toEqual(['new', 'old'])
    expect(popoverRows(chats, 'TRIP new', 'all').map((c) => c.id)).toEqual(['new'])
    expect(popoverRows(chats, '', 'unread').map((c) => c.id)).toEqual(['new', 'run'])
    expect(popoverRows(chats, '', 'needs-input').map((c) => c.id)).toEqual(['ask'])
    expect(popoverRows(chats, '', 'routines').map((c) => c.id)).toEqual(['run'])
    const many = Array.from({ length: POPOVER_LIMIT + 5 }, (_, i) => chat(`c${i}`, { lastActiveAt: i }))
    expect(popoverRows(many, '', 'all')).toHaveLength(POPOVER_LIMIT)
  })

  it('collects the routine inbox: unread results and runs waiting for you', () => {
    const inbox = routineInbox([...chats, chat('wait', { routineId: 'r2', status: 'needs-approval', lastActiveAt: 7 }), chat('read', { routineId: 'r3' })])
    expect(inbox.map((c) => c.id)).toEqual(['wait', 'run'])
  })

  it('has states for loading, a load error, no chats yet and no matches', () => {
    expect(popoverState({ loaded: false, failed: false, all: 0, rows: 0 })).toEqual({ kind: 'loading' })
    expect(popoverState({ loaded: false, failed: true, all: 0, rows: 0 })).toEqual({ kind: 'error' })
    expect(popoverState({ loaded: true, failed: false, all: 0, rows: 0 })).toEqual({ kind: 'empty' })
    expect(popoverState({ loaded: true, failed: false, all: 3, rows: 0 })).toEqual({ kind: 'no-matches' })
    expect(popoverState({ loaded: true, failed: false, all: 3, rows: 2 })).toEqual({ kind: 'rows' })
  })

  it('is driven from the search field', () => {
    const at = (index: number, count = 3, query = '') => ({ index, count, query, filter: 'all' as const })
    expect(popoverKey({ key: 'ArrowDown' }, at(0))).toEqual({ type: 'move', index: 1 })
    expect(popoverKey({ key: 'ArrowDown' }, at(2))).toEqual({ type: 'move', index: 2 })
    expect(popoverKey({ key: 'n', ctrl: true }, at(0))).toEqual({ type: 'move', index: 1 })
    expect(popoverKey({ key: 'ArrowUp' }, at(0))).toEqual({ type: 'move', index: 0 })
    expect(popoverKey({ key: 'End' }, at(0))).toEqual({ type: 'move', index: 2 })
    expect(popoverKey({ key: 'Enter' }, at(1))).toEqual({ type: 'open', index: 1, newTab: false })
    expect(popoverKey({ key: 'Enter', meta: true }, at(1))).toEqual({ type: 'open', index: 1, newTab: true })
    expect(popoverKey({ key: 'Enter' }, at(0, 0))).toEqual({ type: 'none' })
    expect(popoverKey({ key: 'ArrowRight', alt: true }, at(0))).toEqual({ type: 'filter', filter: 'unread' })
    expect(popoverKey({ key: 'ArrowLeft', alt: true }, at(0))).toEqual({ type: 'filter', filter: 'routines' })
    expect(popoverKey({ key: 'Escape' }, at(0, 3, 'trip'))).toEqual({ type: 'clear-query' })
    expect(popoverKey({ key: 'Escape' }, at(0))).toEqual({ type: 'close' })
    expect(popoverKey({ key: 'x' }, at(0))).toEqual({ type: 'none' })
  })
})

describe('main’s chat list', () => {
  it('leaves out private and child chats by default, and imported chats when asked', () => {
    const all = [chat('a'), chat('p', { private: true }), chat('k', { parentChatId: 'a' }), chat('i', { imported: { source: 'chatgpt', originalTitle: 'x', originalCreatedAt: null, importedAt: 1 } }), chat('j', { projectId: 'proj' })]
    const ids = (filter: Parameters<typeof filterChats>[1]): string[] => filterChats(all, filter, () => '').map((c) => c.id).sort()
    expect(ids({})).toEqual(['a', 'i', 'j'])
    expect(ids({ children: 'only' })).toEqual(['k'])
    expect(ids({ children: 'include' })).toEqual(['a', 'i', 'j', 'k'])
    expect(ids({ imported: 'exclude' })).toEqual(['a', 'j'])
    expect(ids({ imported: 'only' })).toEqual(['i'])
    expect(ids({ projectId: 'proj' })).toEqual(['j'])
  })

  it('imports a read-only transcript with user and text events, no API history, and searchable text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-chats-d-'))
    const store = new ChatStore(dir, 'pip')
    const summary = store.importTranscript(
      {
        title: '  Trip   ideas ',
        companionId: 'pip',
        imported: { source: 'claude', originalTitle: 'Trip ideas', originalCreatedAt: 1000, importedAt: 0 },
        messages: [
          { role: 'user', text: 'Where to in May?', at: 1000 },
          { role: 'assistant', text: 'Try the Azores.', at: 2000 },
          { role: 'user', text: '   ', at: null },
        ],
      },
      5000,
    )
    expect(summary).toMatchObject({ title: 'Trip ideas', createdAt: 1000, companionId: 'pip', private: false, parentChatId: null, projectId: null, routineRun: null })
    expect(summary.imported).toEqual({ source: 'claude', originalTitle: 'Trip ideas', originalCreatedAt: 1000, importedAt: 5000 })
    const content = store.load(summary.id)
    expect(content.messages).toEqual([])
    expect(content.log.map((e) => e.type)).toEqual(['user-message', 'text-delta'])
    expect(Object.values(content.details).map((d) => d.at)).toEqual([2000])
    expect(store.query({ query: 'azores' }).map((c) => c.id)).toEqual([summary.id])
    expect(store.query({ imported: 'exclude' })).toEqual([])
    // The ledger rows (imported, projectId, parentChatId, routineRun) persist through a reload.
    store.update([summary.id], { projectId: 'proj' })
    const reloaded = new ChatStore(dir, 'pip').summary(summary.id)
    expect(reloaded).toMatchObject({ projectId: 'proj', parentChatId: null, routineRun: null, imported: { source: 'claude', importedAt: 5000 } })
  })
})

describe('the sidebar chat menu (D additions)', () => {
  it('adds Move to project and Export for saved chats, never for private ones', async () => {
    const { chatMenu, setChatProjectMenu } = await import('../src/renderer/src/components/sidebar/logic/menus')
    setChatProjectMenu((ids) => ({ id: 'project:menu', label: 'Move to Project', submenu: ids.map((id) => ({ id: `project:x:${id}`, label: id })) }))
    try {
      const many = chatMenu([chat('a'), chat('b')], { inSidebar: true })
      expect(many.find((i) => i.id === 'project:menu')?.submenu?.map((i) => i.id)).toEqual(['project:x:a', 'project:x:b'])
      expect(many.find((i) => i.id === 'export')?.label).toBe('Export 2 Chats…')
      const secret = chatMenu([chat('p', { private: true })], { inSidebar: true }).map((i) => i.id)
      expect(secret).not.toContain('export')
      expect(secret).not.toContain('project:menu')
    } finally {
      setChatProjectMenu(null)
    }
    expect(chatMenu([chat('a')], { inSidebar: true }).map((i) => i.id)).not.toContain('project:menu')
  })
})
