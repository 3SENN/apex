/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import { EMPTY_LOG, reduceAgentLog } from '../src/renderer/src/agentLog'

const fold = (events: AgentEvent[]) => events.reduce(reduceAgentLog, EMPTY_LOG)

describe('reduceAgentLog', () => {
  it('streams text and thinking into one assistant entry per turn', () => {
    const log = fold([
      { type: 'user-message', id: 'u1', text: 'Summarize this page' },
      { type: 'thinking-delta', turnId: 't1', text: 'Reading ' },
      { type: 'text-delta', turnId: 't1', text: 'I will ' },
      { type: 'text-delta', turnId: 't1', text: 'read it.' },
      { type: 'tool', id: 'c1', label: 'Read the page text', state: 'running' },
      { type: 'tool', id: 'c1', label: 'Read the page text', state: 'done' },
      { type: 'text-delta', turnId: 't2', text: 'Done.' },
    ])
    expect(log.items).toEqual([
      { kind: 'user', id: 'u1', text: 'Summarize this page' },
      { kind: 'assistant', id: 't1', text: 'I will read it.', thinking: 'Reading ' },
      { kind: 'tool', id: 'c1', label: 'Read the page text', state: 'done' },
      { kind: 'assistant', id: 't2', text: 'Done.', thinking: '' },
    ])
  })

  it('tracks approvals and their resolution', () => {
    const log = fold([
      { type: 'approval', approvalId: 'a1', description: 'Apex agent wants to click "Buy".', origin: 'https://shop.test' },
      { type: 'approval-resolved', approvalId: 'a1', allowed: false },
    ])
    expect(log.items).toEqual([{ kind: 'approval', id: 'a1', description: 'Apex agent wants to click "Buy".', origin: 'https://shop.test', resolved: false }])
  })

  it('shows errors as notices and keeps status', () => {
    const log = fold([
      { type: 'status', status: 'running' },
      { type: 'error', message: 'Stopped.' },
      { type: 'error', message: 'The Anthropic API key was rejected.' },
    ])
    expect(log.status).toBe('running')
    expect(log.items.map((i) => (i.kind === 'notice' ? i.tone : i.kind))).toEqual(['info', 'error'])
  })

  it('clears entries on reset', () => {
    expect(fold([{ type: 'user-message', id: 'u', text: 'hi' }, { type: 'reset' }]).items).toEqual([])
  })
})

// The rich-card events fold into one card each.
describe('reduceAgentLog C cards', () => {
  const file = { id: 'f1', name: 'Plan.md', mediaType: 'text/markdown', size: 0, kind: 'generated', chatId: 'c1', companionId: 'nova', createdAt: 1, state: 'writing', artifact: false } as const

  it('upserts compaction, files, partial and connector cards by id', () => {
    const log = fold([
      { type: 'compaction', id: 'k1', state: 'running', trigger: 'auto' },
      { type: 'compaction', id: 'k1', state: 'done', trigger: 'auto', summary: 'S.', replacedTokens: 150000 },
      { type: 'file-produced', turnId: 't1', file },
      { type: 'file-produced', turnId: 't1', file: { ...file, state: 'ready', size: 9 } },
      { type: 'partial', turnId: 't1', reason: 'stopped' },
      { type: 'partial', turnId: 't1', reason: 'stopped' },
      { type: 'connector-approval', approvalId: 'p1', connectorId: 'x', connectorName: 'Tracker', tool: 'create_issue', actionLabel: 'Create issue', inputSchema: {}, input: { title: 'Bug' } },
      { type: 'connector-approval-resolved', approvalId: 'p1', outcome: 'confirmed', edited: true },
      { type: 'connector-needed', id: 'n1', turnId: 't1', directoryId: 'linear', service: 'Linear', reason: 'Issues.' },
    ])
    expect(log.items).toEqual([
      { kind: 'compaction', id: 'k1', state: 'done', trigger: 'auto', summary: 'S.', replacedTokens: 150000, thresholdTokens: null },
      { kind: 'file-produced', id: 'f1', turnId: 't1', file: { ...file, state: 'ready', size: 9 } },
      { kind: 'partial', id: 'partial-t1', turnId: 't1', reason: 'stopped' },
      { kind: 'connector-approval', id: 'p1', connectorId: 'x', connectorName: 'Tracker', tool: 'create_issue', actionLabel: 'Create issue', inputSchema: {}, input: { title: 'Bug' }, outcome: 'confirmed', edited: true },
      { kind: 'connector-needed', id: 'n1', turnId: 't1', directoryId: 'linear', service: 'Linear', reason: 'Issues.' },
    ])
  })

  it('joins a turn’s memory changes into one card, and keeps suggestions and opened tabs', () => {
    const log = fold([
      { type: 'memory-change', turnId: 't1', changes: [{ op: 'saved', owner: 'nova', path: '/memories/a.md' }] },
      { type: 'memory-change', turnId: 't1', changes: [{ op: 'forgotten', owner: 'nova', path: '/memories/b.md' }] },
      { type: 'suggestions', id: 's1', turnId: 't1', heading: null, items: ['Book it'] },
      { type: 'tab-opened', turnId: 't1', tabId: 'tab-3', url: 'https://example.com/', title: 'Example' },
    ])
    expect(log.items).toEqual([
      { kind: 'memory-change', id: 'memory-t1', turnId: 't1', changes: [{ op: 'saved', owner: 'nova', path: '/memories/a.md' }, { op: 'forgotten', owner: 'nova', path: '/memories/b.md' }] },
      { kind: 'suggestions', id: 's1', turnId: 't1', heading: null, items: ['Book it'] },
      { kind: 'tab-opened', id: 'tab-t1-tab-3', turnId: 't1', tabId: 'tab-3', url: 'https://example.com/', title: 'Example' },
    ])
  })

  it('keeps attachment chips on the user message', () => {
    const ref = { id: 'a1', kind: 'pdf', name: 'Report.pdf', state: 'ready', error: null, size: 1, mediaType: 'application/pdf', thumbnail: null } as const
    const log = fold([{ type: 'user-message', id: 'u1', text: 'Read this', attachments: [ref] }])
    expect(log.items).toEqual([{ kind: 'user', id: 'u1', text: 'Read this', attachments: [ref] }])
  })
})
