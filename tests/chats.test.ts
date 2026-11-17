/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CHAT_SUMMARY_FLAG_DEFAULTS, CHAT_SUMMARY_LINK_DEFAULTS } from '@shared/chats'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chatDateGroup, memoryLocation, type ChatSummary } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import { ChatStore, INTERRUPTED, chatMarkdown, closeDanglingToolUses, exportFileName, filterChats, normalizeSummary, searchTextOf, type ChatContent } from '../src/main/chats'

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const summary = (n: number, overrides: Partial<ChatSummary> = {}): ChatSummary => ({
  id: ID(n),
  title: `Chat ${n}`,
  createdAt: n,
  updatedAt: n,
  lastActiveAt: n,
  routineId: null,
  companionId: 'companion-1',
  model: 'claude-opus-5-5',
  status: 'finished',
  unread: false,
  pinned: false,
  archived: false,
  needsInput: false,
  draft: false,
  ...CHAT_SUMMARY_FLAG_DEFAULTS, ...CHAT_SUMMARY_LINK_DEFAULTS,
  ...overrides,
})

const content = (id: string, log: AgentEvent[] = []): ChatContent => ({
  id,
  capabilities: { model: 'claude-opus-5-5', effort: 'high', browser: true, webTools: true, memory: true, connectorIds: [], memoryScope: 'companion' },
  system: 'You are Pip.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  log,
  details: {},
  feedback: {},
})

describe('chat summaries', () => {
  it('fill fields older chats lack and reset run states after a restart', () => {
    const out = normalizeSummary({ id: ID(1), title: 'Old', createdAt: 5, updatedAt: 9, routineId: 'r1', status: 'running' }, 'companion-1')
    expect(out).toEqual({
      id: ID(1), title: 'Old', createdAt: 5, updatedAt: 9, lastActiveAt: 9, routineId: 'r1', companionId: 'companion-1', model: '',
      status: 'idle', unread: false, pinned: false, archived: false, needsInput: false, draft: false,
      ...CHAT_SUMMARY_FLAG_DEFAULTS, ...CHAT_SUMMARY_LINK_DEFAULTS,
    })
    expect(normalizeSummary({ id: ID(2), title: '  ', status: 'needs-approval', companionId: 'c2', pinned: true }, 'companion-1')).toMatchObject({
      title: 'New chat', status: 'idle', companionId: 'c2', pinned: true,
    })
    expect(normalizeSummary({ id: ID(3), title: 'x', status: 'bogus' }, 'c').status).toBe('idle')
  })
})

describe('chat filters', () => {
  const chats = [
    summary(1, { title: 'Flights to Lisbon', lastActiveAt: 10 }),
    summary(2, { title: 'Weekly report', routineId: 'r1', unread: true, lastActiveAt: 30 }),
    summary(3, { title: 'Groceries', pinned: true, lastActiveAt: 5, companionId: 'c2' }),
    summary(4, { title: 'Archived trip', archived: true, lastActiveAt: 50 }),
    summary(5, { title: 'Lisbon hotels', needsInput: true, lastActiveAt: 20, createdAt: 0 }),
  ]
  const body: Record<string, string> = { [ID(3)]: 'milk and lisbon cheese', [ID(2)]: 'sales numbers' }
  const text = (id: string): string => body[id] ?? ''
  const ids = (list: ChatSummary[]): number[] => list.map((c) => Number(c.id.slice(-3)))

  it('put pinned chats first, then the most recently active, and hide archived ones', () => {
    expect(ids(filterChats(chats, {}, text))).toEqual([3, 2, 5, 1])
    expect(ids(filterChats(chats, { status: 'archived' }, text))).toEqual([4])
    expect(ids(filterChats(chats, { sort: 'oldest' }, text))).toEqual([3, 5, 1, 2])
  })

  it('filter by status, companion and routine runs', () => {
    expect(ids(filterChats(chats, { status: 'unread' }, text))).toEqual([2])
    expect(ids(filterChats(chats, { status: 'needs-input' }, text))).toEqual([5])
    expect(ids(filterChats(chats, { companionId: 'c2' }, text))).toEqual([3])
    expect(ids(filterChats(chats, { routine: 'only' }, text))).toEqual([2])
    expect(ids(filterChats(chats, { routine: 'exclude' }, text))).toEqual([3, 5, 1])
  })

  it('search titles and content, every word, ranked by best match', () => {
    expect(ids(filterChats(chats, { query: 'lisbon', sort: 'best-match' }, text))).toEqual([3, 5, 1])
    expect(ids(filterChats(chats, { query: 'lisbon hotels', sort: 'best-match' }, text))).toEqual([5])
    expect(ids(filterChats(chats, { query: 'SALES' }, text))).toEqual([2])
    // Without a query, best match falls back to recent.
    expect(ids(filterChats(chats, { sort: 'best-match' }, text))).toEqual([3, 2, 5, 1])
  })

  it('page with offset and limit', () => {
    expect(ids(filterChats(chats, { offset: 1, limit: 2 }, text))).toEqual([2, 5])
  })

  it('search only the text you and the replies wrote', () => {
    const log: AgentEvent[] = [
      { type: 'user-message', id: 'u', text: 'Find FLIGHTS' },
      { type: 'thinking-delta', turnId: 't', text: 'secret plan' },
      { type: 'text-delta', turnId: 't', text: 'Found three.' },
      { type: 'tool', id: 'x', label: 'Searched the web', state: 'done' },
    ]
    expect(searchTextOf(log)).toBe('find flights\nfound three.')
  })
})

describe('chat dates and memory links', () => {
  it('group by calendar day', () => {
    const now = new Date(2026, 9, 28, 10, 0).getTime()
    expect(chatDateGroup(new Date(2026, 9, 28, 0, 1).getTime(), now)).toBe('today')
    expect(chatDateGroup(new Date(2026, 9, 27, 23, 59).getTime(), now)).toBe('yesterday')
    expect(chatDateGroup(new Date(2026, 9, 22).getTime(), now)).toBe('week')
    expect(chatDateGroup(new Date(2026, 9, 1).getTime(), now)).toBe('month')
    expect(chatDateGroup(new Date(2026, 7, 1).getTime(), now)).toBe('older')
  })

  it('map agent memory paths to an owner and path', () => {
    expect(memoryLocation('/memories/shared/user.md', 'c1')).toEqual({ owner: 'shared', path: '/memories/user.md' })
    expect(memoryLocation('/memories/notes/a.md', 'c1')).toEqual({ owner: 'c1', path: '/memories/notes/a.md' })
    expect(memoryLocation('/memories/sharedness.md', 'c1')).toEqual({ owner: 'c1', path: '/memories/sharedness.md' })
  })
})

describe('chat export', () => {
  it('writes Markdown with speakers, steps and notices, without thinking', () => {
    const log: AgentEvent[] = [
      { type: 'user-message', id: 'u1', text: 'Book a table' },
      { type: 'thinking-delta', turnId: 't1', text: 'hmm' },
      { type: 'text-delta', turnId: 't1', text: 'Opening the site.' },
      { type: 'tool', id: 'c1', label: 'Clicked "Reserve"', state: 'error' },
      { type: 'approval', approvalId: 'a', description: 'Pip wants to click button "Book"', origin: 'https://food.example' },
      { type: 'approval-resolved', approvalId: 'a', allowed: false },
      { type: 'error', message: 'Stopped.' },
    ]
    const md = chatMarkdown({ title: 'Dinner', createdAt: 0 }, log, 'Pip', () => 'today')
    expect(md).toBe([
      '# Dinner', '', '*Pip · today*', '', '**You**', '', 'Book a table', '', '**Pip**', '', 'Opening the site.', '',
      '- Clicked "Reserve" (failed)', '', '> Asked for approval: Pip wants to click button "Book"', '', '> You declined.', '', '> Stopped.', '',
    ].join('\n'))
  })

  it('makes safe file names', () => {
    expect(exportFileName('Trip: Lisbon / Porto?', 'md')).toBe('Trip Lisbon Porto.md')
    expect(exportFileName('   ', 'apexcompanion')).toBe('Untitled.apexcompanion')
  })
})

describe('chat store', () => {
  it('migrates an old index: companion, model from the chat file, missing summary fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-chats-'))
    mkdirSync(join(dir, 'chats'))
    writeFileSync(join(dir, 'chats', 'index.json'), JSON.stringify([{ id: ID(1), title: 'Old chat', createdAt: 1, updatedAt: 2, routineId: null }, { id: 'bad', title: 'x' }]))
    writeFileSync(join(dir, 'chats', `${ID(1)}.json`), JSON.stringify({ ...content(ID(1)), capabilities: { model: 'claude-sonnet-5-5', browser: true, webTools: true, memory: true, connectorIds: [] } }))
    const store = new ChatStore(dir, 'companion-1')
    expect(store.list()).toEqual([expect.objectContaining({ id: ID(1), companionId: 'companion-1', model: 'claude-sonnet-5-5', status: 'idle', unread: false, lastActiveAt: 2 })])
    // The migration is written back.
    expect(JSON.parse(readFileSync(join(dir, 'chats', 'index.json'), 'utf8'))[0]).toMatchObject({ companionId: 'companion-1', model: 'claude-sonnet-5-5' })
    // An old file loads with empty details and feedback.
    expect(store.load(ID(1))).toMatchObject({ details: {}, feedback: {} })
    expect(() => store.load('nope')).toThrow('This chat no longer exists.')
  })

  it('saves, updates flags without touching content, duplicates and removes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-chats-'))
    const store = new ChatStore(dir, 'companion-1')
    const events: number[] = []
    store.on('changed', (items) => events.push(items.length))
    store.save(content(ID(1), [{ type: 'user-message', id: 'u', text: 'Plan a trip to Kyoto' }]), { created: summary(1, { title: 'Plan a trip' }) })
    expect(store.summary(ID(1))).toMatchObject({ title: 'Plan a trip', draft: false })
    expect(existsSync(join(dir, 'chats', `${ID(1)}.txt`))).toBe(true)

    expect(store.update([ID(1), ID(9)], { pinned: true, unread: true })).toHaveLength(1)
    // An update that changes nothing writes and emits nothing.
    expect(store.update([ID(1)], { pinned: true })).toHaveLength(0)
    expect(events).toEqual([1, 1])

    // Saving content keeps the flags the index holds.
    store.save(content(ID(1), [{ type: 'user-message', id: 'u', text: 'Plan a trip to Kyoto' }]), { patch: { status: 'finished' } })
    expect(store.summary(ID(1))).toMatchObject({ pinned: true, unread: true, status: 'finished' })

    expect(store.query({ query: 'kyoto' }).map((c) => c.id)).toEqual([ID(1)])

    const copy = store.duplicate(ID(1), 99)
    expect(copy).toMatchObject({ title: 'Plan a trip (copy)', pinned: false, unread: false, createdAt: 99, lastActiveAt: 99 })
    expect(store.load(copy.id).log).toEqual(store.load(ID(1)).log)
    expect(store.query({ query: 'kyoto' })).toHaveLength(2)

    store.remove([ID(1)])
    expect(store.summary(ID(1))).toBeUndefined()
    expect(existsSync(join(dir, 'chats', `${ID(1)}.json`))).toBe(false)
    expect(new ChatStore(dir, 'companion-1').list().map((c) => c.id)).toEqual([copy.id])
  })

  it('answers tool calls left without results by a quit or crash, so the next request is valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-chats-'))
    const store = new ChatStore(dir, 'companion-1')
    const dangling = content(ID(1))
    dangling.messages = [
      { role: 'user', content: [{ type: 'text', text: 'context' }, { type: 'text', text: 'Book it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it.', citations: null },
          { type: 'tool_use', id: 'toolu_a', name: 'left_click', input: {}, toolset_name: 'browser' } as never,
          { type: 'tool_use', id: 'toolu_b', name: 'memory', input: {} },
        ],
      },
    ]
    store.save(dangling, { created: summary(1) })
    const loaded = store.load(ID(1))
    expect(loaded.messages).toHaveLength(3)
    expect(loaded.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', toolset_name: 'browser', is_error: true, content: INTERRUPTED },
        { type: 'tool_result', tool_use_id: 'toolu_b', is_error: true, content: INTERRUPTED },
      ],
    })
    // Complete histories are left alone.
    const done = [...loaded.messages, { role: 'assistant' as const, content: 'Done.' }]
    expect(closeDanglingToolUses(done)).toBe(done)
    expect(closeDanglingToolUses([])).toEqual([])
  })

  it('keeps updatedAt when asked, for ratings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-chats-'))
    const store = new ChatStore(dir, 'companion-1')
    store.save(content(ID(1)), { created: summary(1) })
    store.update([ID(1)], { updatedAt: 5 })
    store.save(content(ID(1)), { touch: false })
    expect(store.summary(ID(1))?.updatedAt).toBe(5)
  })
})

describe('chat service schemas', () => {
  it('validate ids, filters, bulk ids and options', async () => {
    const { SERVICE_SCHEMAS } = await import('../src/main/services')
    const chats = SERVICE_SCHEMAS.chats
    expect(chats.list.safeParse([]).success).toBe(true)
    expect(chats.list.safeParse([{ query: 'x', status: 'unread', sort: 'best-match', limit: 50 }]).success).toBe(true)
    expect(chats.list.safeParse([{ status: 'deleted' }]).success).toBe(false)
    expect(chats.list.safeParse([{ extra: true }]).success).toBe(false)
    expect(chats.get.safeParse([ID(1)]).success).toBe(true)
    expect(chats.get.safeParse(['../../etc']).success).toBe(false)
    expect(chats.pin.safeParse([[ID(1), ID(2)]]).success).toBe(true)
    expect(chats.pin.safeParse([[]]).success).toBe(false)
    expect(chats.create.safeParse([{ companionId: 'companion-1', model: 'claude-sonnet-5-5', effort: 'low' }]).success).toBe(true)
    expect(chats.create.safeParse([{ model: 'gpt-4' }]).success).toBe(false)
    expect(chats.rename.safeParse([ID(1), '   ']).success).toBe(false)
    expect(chats.feedback.safeParse([ID(1), ID(2), 'helpful', 'note']).success).toBe(true)
    expect(chats.feedback.safeParse([ID(1), ID(2), 'meh']).success).toBe(false)
    expect(chats.setViewing.safeParse(['panel', null]).success).toBe(true)
    expect(chats.editQueued.safeParse([ID(1), ID(2), null]).success).toBe(true)
    expect(SERVICE_SCHEMAS.memory.list.safeParse([]).success).toBe(true)
    expect(SERVICE_SCHEMAS.memory.write.safeParse(['/memories/a.md', 'x', 'companion-1']).success).toBe(true)
    expect(SERVICE_SCHEMAS.memory.write.safeParse(['/memories/a.md', 'x', '../evil']).success).toBe(false)
    expect(SERVICE_SCHEMAS.skills.save.safeParse([{ name: 'a', description: '', instructions: 'x', owner: 'shared' }]).success).toBe(true)
  })
})

// Older attachments and capabilities on load.
describe('older attachment normalization', () => {
  it('turns older AttachmentView entries into AttachmentRef, keeps store refs, and fills the capability fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apex-chats-'))
    mkdirSync(join(dir, 'chats'))
    writeFileSync(join(dir, 'chats', 'index.json'), JSON.stringify([{ id: ID(1), title: 'Old chat', createdAt: 1, updatedAt: 2, companionId: 'companion-1' }]))
    const cRef = { id: 'a-1', kind: 'pdf', name: 'Report.pdf', state: 'ready', error: null, size: 10, mediaType: 'application/pdf', thumbnail: null }
    const log = [
      { type: 'user-message', id: 'u1', text: 'Look', attachments: [{ kind: 'image', thumbnail: 'data:image/png;base64,AAA', label: 'shot.png' }, { kind: 'meeting', meetingId: 'm-7', title: 'Standup' }, { kind: 'mystery' }] },
      { type: 'user-message', id: 'u2', text: 'And this', attachments: [cRef] },
      { type: 'user-message', id: 'u3', text: 'None' },
    ]
    writeFileSync(join(dir, 'chats', `${ID(1)}.json`), JSON.stringify({ ...content(ID(1)), log }))
    const loaded = new ChatStore(dir, 'companion-1').load(ID(1))
    const attachments = loaded.log.map((e) => (e.type === 'user-message' ? (e as { attachments?: unknown[] }).attachments : null))
    expect(attachments[0]).toEqual([
      { id: 'legacy-u1-0', kind: 'image', name: 'shot.png', state: 'ready', error: null, size: 0, mediaType: 'image/png', thumbnail: 'data:image/png;base64,AAA' },
      { id: 'legacy-u1-1', kind: 'meeting', name: 'Standup', state: 'ready', error: null, size: 0, mediaType: 'text/plain', thumbnail: null, sourceId: 'm-7' },
    ])
    expect(attachments[1]).toEqual([cRef])
    expect(attachments[2]).toBeUndefined()
    expect(loaded.capabilities).toMatchObject({ documents: false, compaction: false, containerId: null, localTools: [], toolPolicies: {}, cClientTools: [] })
  })
})
