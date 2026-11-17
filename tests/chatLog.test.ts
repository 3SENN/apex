/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import type { LibraryFileRef } from '@shared/files'
import { EMPTY_LOG, foldAgentLog, reduceAgentLog, type LogItem } from '../src/renderer/src/agentLog'
import {
  answeredCount,
  answerFor,
  approvalScopes,
  countdownFraction,
  hasPendingRequest,
  initialQuestionState,
  needsSecondConfirm,
  agentToolRequests,
  proposalSaveInput,
  questionAnswers,
  reduceQuestions,
  secondsLeft,
  type QuestionState,
} from '../src/renderer/src/chat/logic/requests'
import { stripSkillCommand } from '../src/renderer/src/chat/logic/skillChip'
import { routineSave } from '../src/main/routines/schemas'

// How plan, delegation, request and source events fold into the chat log,
// and the request rules the tray's cards use.

const fold = (events: AgentEvent[]): LogItem[] => foldAgentLog(events).items

const file = (id: string, state: LibraryFileRef['state'] = 'ready'): LibraryFileRef => ({
  id,
  name: `${id}.md`,
  mediaType: 'text/markdown',
  size: 10,
  kind: 'report',
  chatId: 'c1',
  companionId: 'pip',
  createdAt: 1,
  state,
  artifact: false,
})

describe('agent log: plan, delegation, request and source events', () => {
  it('keeps only the latest plan, in one place', () => {
    const items = fold([
      { type: 'plan', items: [{ id: 'a', title: 'Look', status: 'active' }] },
      { type: 'user-message', id: 'u1', text: 'go' },
      { type: 'plan', items: [{ id: 'a', title: 'Look', status: 'done' }, { id: 'b', title: 'Write', status: 'active' }] },
    ])
    const plans = items.filter((i) => i.kind === 'plan')
    expect(plans).toHaveLength(1)
    expect(plans[0]).toMatchObject({ kind: 'plan', items: [{ status: 'done' }, { id: 'b' }] })
    // The plan moves to the end, after the message.
    expect(items.at(-1)?.kind).toBe('plan')
  })

  it('upserts delegations by id', () => {
    const items = fold([
      { type: 'delegation', id: 'd1', childChatId: 'child', title: 'Research', status: 'working' },
      { type: 'delegation', id: 'd2', childChatId: 'child2', title: 'Other', status: 'working' },
      { type: 'delegation', id: 'd1', childChatId: 'child', title: 'Research', status: 'done' },
    ])
    expect(items.filter((i) => i.kind === 'delegation')).toEqual([
      { kind: 'delegation', id: 'd1', childChatId: 'child', title: 'Research', status: 'done' },
      { kind: 'delegation', id: 'd2', childChatId: 'child2', title: 'Other', status: 'working' },
    ])
  })

  it('folds each request kind as pending, and request-resolved settles it by id', () => {
    const events: AgentEvent[] = [
      { type: 'auto-approval', approvalId: 'r1', description: 'Send the form', origin: 'https://a.test', rule: 'site', runsAt: 9000 },
      { type: 'site-access', requestId: 'r2', origin: 'https://b.test', action: 'Read the page' },
      { type: 'table-write', requestId: 'r3', table: 'books', sql: 'DELETE FROM books', scope: 'shared', destructive: true },
      { type: 'question', requestId: 'r4', questions: [{ id: 'q1', prompt: 'Which?' }] },
      { type: 'routine-proposal', requestId: 'r5', draft: { name: 'News', prompt: 'Read news', schedule: { kind: 'daily', time: '08:00', days: [] } } },
      { type: 'skill-draft', requestId: 'r6', draft: { name: 'tidy', description: 'Tidy', instructions: 'Do it' } },
      { type: 'app-built', requestId: 'r7', appId: 'app1', versionId: 'v1', name: 'Timer' },
    ]
    const pending = fold(events)
    expect(pending.map((i) => i.kind)).toEqual(['auto-approval', 'site-access', 'table-write', 'question', 'routine-proposal', 'skill-draft', 'app-built'])
    expect(pending.every((i) => 'outcome' in i && i.outcome === null)).toBe(true)
    expect(pending[2]).toMatchObject({ table: 'books', sql: 'DELETE FROM books', destructive: true })

    const settled = fold([...events, { type: 'request-resolved', requestId: 'r3', outcome: 'denied' }, { type: 'request-resolved', requestId: 'r5', outcome: 'saved' }])
    expect(settled.find((i) => i.id === 'r3')).toMatchObject({ outcome: 'denied' })
    expect(settled.find((i) => i.id === 'r5')).toMatchObject({ outcome: 'saved' })
    expect(settled.find((i) => i.id === 'r4')).toMatchObject({ outcome: null })
  })

  it('settles an approval through request-resolved, and ignores unknown ids', () => {
    const base: AgentEvent[] = [{ type: 'approval', approvalId: 'a1', description: 'Buy', origin: 'https://shop.test', action: 'purchase', scopes: ['once', 'chat'] }]
    const allowed = fold([...base, { type: 'request-resolved', requestId: 'a1', outcome: 'allowed' }])
    expect(allowed[0]).toMatchObject({ kind: 'approval', resolved: true, action: 'purchase', scopes: ['once', 'chat'] })
    const before = foldAgentLog(base)
    expect(reduceAgentLog(before, { type: 'request-resolved', requestId: 'nope', outcome: 'denied' }).items).toEqual(before.items)
  })

  it('appends routine lists and dedupes sources by address (a later title wins)', () => {
    const items = fold([
      { type: 'routine-list', routineIds: ['a', 'b'] },
      { type: 'source', url: 'https://x.test/1', title: 'One' },
      { type: 'source', url: 'https://x.test/1', title: 'One, updated' },
      { type: 'source', url: 'https://x.test/2', title: 'Two' },
    ])
    expect(items.filter((i) => i.kind === 'routine-list')).toEqual([{ kind: 'routine-list', id: 'routines-0', routineIds: ['a', 'b'] }])
    expect(items.filter((i) => i.kind === 'source').map((i) => (i.kind === 'source' ? i.title : ''))).toEqual(['One, updated', 'Two'])
  })

  it('keeps one card per produced file and per written file and turn', () => {
    const items = fold([
      { type: 'file-produced', turnId: 't1', file: file('f1', 'writing') },
      { type: 'file-produced', turnId: 't1', file: file('f1') },
      { type: 'file-written', turnId: 't1', ref: { kind: 'folder', folderId: 'docs', path: 'a.md' }, name: 'a.md' },
      { type: 'file-written', turnId: 't1', ref: { kind: 'folder', folderId: 'docs', path: 'a.md' }, name: 'a.md' },
      { type: 'file-written', turnId: 't2', ref: { kind: 'folder', folderId: 'docs', path: 'a.md' }, name: 'a.md' },
    ])
    expect(items.filter((i) => i.kind === 'file-produced')).toHaveLength(1)
    expect(items.find((i) => i.kind === 'file-produced')).toMatchObject({ file: { state: 'ready' } })
    expect(items.filter((i) => i.kind === 'file-written').map((i) => i.id)).toEqual(['written:t1:folder:docs:a.md', 'written:t2:folder:docs:a.md'])
  })

  it('carries the skill on your message, and the chip hides the raw command', () => {
    const items = reduceAgentLog(EMPTY_LOG, { type: 'user-message', id: 'u1', text: '/tidy-tabs please', skill: { id: 's1', name: 'tidy-tabs', builtin: true } }).items
    expect(items[0]).toMatchObject({ kind: 'user', skill: { id: 's1', builtin: true } })
    expect(stripSkillCommand('/tidy-tabs please', 'tidy-tabs')).toBe('please')
    expect(stripSkillCommand('/tidy-tabs', 'tidy-tabs')).toBe('')
    expect(stripSkillCommand('no command here', 'tidy-tabs')).toBe('no command here')
  })
})

describe('pending requests in the tray', () => {
  it('lists what still waits, oldest first, and drops what settled', () => {
    const items = fold([
      { type: 'approval', approvalId: 'a1', description: 'Post', origin: 'https://x.test' },
      { type: 'site-access', requestId: 's1', origin: 'https://y.test', action: 'Open' },
      { type: 'question', requestId: 'q1', questions: [{ id: 'q', prompt: '?' }] },
      { type: 'request-resolved', requestId: 's1', outcome: 'allowed' },
    ])
    expect(agentToolRequests(items, 'c1').map((r) => [r.kind, r.id, r.chatId])).toEqual([
      ['approval', 'a1', 'c1'],
      ['question', 'q1', 'c1'],
    ])
    expect(hasPendingRequest(items)).toBe(true)
    expect(hasPendingRequest(fold([{ type: 'plan', items: [] }]))).toBe(false)
  })

  it('offers broader scopes except for payments and security, which ask once', () => {
    expect(approvalScopes({ action: 'purchase', scopes: ['chat', 'site', 'chat'] })).toEqual(['once', 'chat', 'site'])
    expect(approvalScopes({ action: 'payment', scopes: ['once', 'chat', 'site'] })).toEqual(['once'])
    expect(approvalScopes({ action: 'security', scopes: ['site'] })).toEqual(['once'])
    expect(approvalScopes({})).toEqual(['once'])
    expect(needsSecondConfirm('once')).toBe(false)
    expect(needsSecondConfirm('chat')).toBe(true)
    expect(needsSecondConfirm('site')).toBe(true)
  })

  it('counts the 8 s auto-approval down in whole seconds and drains the bar', () => {
    expect(secondsLeft(8000, 0)).toBe(8)
    expect(secondsLeft(8000, 7001)).toBe(1)
    expect(secondsLeft(8000, 9000)).toBe(0)
    expect(countdownFraction(8000, 0, 8000)).toBe(1)
    expect(countdownFraction(8000, 4000, 8000)).toBe(0.5)
    expect(countdownFraction(8000, 9000, 8000)).toBe(0)
    expect(countdownFraction(8000, 0, 0)).toBe(0)
  })
})

describe('the question card', () => {
  const questions = [
    { id: 'when', prompt: 'When?', options: ['Today', 'Tomorrow'] },
    { id: 'who', prompt: 'Who?', options: ['Ann', 'Bo', 'Cy'], multi: true },
    { id: 'note', prompt: 'Anything else?', allowOther: true },
  ]
  const run = (actions: Parameters<typeof reduceQuestions>[1][]): QuestionState => actions.reduce(reduceQuestions, initialQuestionState())

  it('picks single and multiple answers, and a typed answer wins on single questions', () => {
    const state = run([
      { type: 'pick', id: 'when', option: 'Today', multi: false },
      { type: 'pick', id: 'who', option: 'Ann', multi: true },
      { type: 'pick', id: 'who', option: 'Cy', multi: true },
      { type: 'pick', id: 'who', option: 'Ann', multi: true },
      { type: 'other', id: 'note', text: '  bring snacks ' },
    ])
    expect(answerFor(state, questions[0]!)).toBe('Today')
    expect(answerFor(state, questions[1]!)).toEqual(['Cy'])
    expect(answerFor(state, questions[2]!)).toBe('bring snacks')
    expect(answeredCount(state, questions)).toBe(3)
    const typed = reduceQuestions(state, { type: 'other', id: 'when', text: 'Friday' })
    expect(answerFor(typed, questions[0]!)).toBe('Friday')
  })

  it('moves one question at a time, skips one or all, and answers null where skipped', () => {
    let state = run([{ type: 'next', total: 3 }, { type: 'next', total: 3 }, { type: 'next', total: 3 }])
    expect(state.index).toBe(2)
    state = reduceQuestions(state, { type: 'prev' })
    expect(state.index).toBe(1)
    state = reduceQuestions(reduceQuestions(state, { type: 'pick', id: 'who', option: 'Bo', multi: true }), { type: 'skip', id: 'who', total: 3 })
    expect(state.index).toBe(2)
    expect(questionAnswers(state, questions)).toEqual([
      { id: 'when', answer: null },
      { id: 'who', answer: null },
      { id: 'note', answer: null },
    ])
    expect(answeredCount(state, questions)).toBe(0)
  })

  it('locks after submit', () => {
    const sent = run([{ type: 'pick', id: 'when', option: 'Today', multi: false }, { type: 'submit' }])
    expect(sent.submitted).toBe(true)
    expect(reduceQuestions(sent, { type: 'pick', id: 'when', option: 'Tomorrow', multi: false })).toBe(sent)
  })
})

describe('the question block under a reply (DS-63)', () => {
  it('lifts the closing question out of a reply', async () => {
    const { trailingQuestion, showsAskBlock } = await import('../src/renderer/src/chat/logic/askBlock')
    expect(trailingQuestion('Here are three options.\n\nWhich one suits you best?')).toBe('Which one suits you best?')
    expect(trailingQuestion('I found it. Should I book the 9:40 train?')).toBe('Should I book the 9:40 train?')
    expect(trailingQuestion('- Shall I go on?')).toBe('Shall I go on?')
    expect(trailingQuestion('All done.')).toBeNull()
    expect(trailingQuestion(`${'x'.repeat(300)}?`)).toBeNull()
    const asked = fold([{ type: 'text-delta', turnId: 't', text: 'Go on?' }])
    expect(showsAskBlock({ last: true, running: false, items: asked })).toBe(true)
    expect(showsAskBlock({ last: false, running: false, items: asked })).toBe(false)
    expect(showsAskBlock({ last: true, running: true, items: asked })).toBe(false)
    const withSteps = fold([{ type: 'text-delta', turnId: 't', text: 'Go on?' }, { type: 'suggestions', id: 's', turnId: 't', heading: null, items: ['Yes'] }])
    // DS-63: next steps follow the question block instead of hiding it.
    expect(showsAskBlock({ last: true, running: false, items: withSteps })).toBe(true)
  })
})

describe('saving a routine proposal', () => {
  it('sends the draft switched on, in the shape routines.save accepts', () => {
    const draft = { name: 'News', prompt: 'Read the news', schedule: { kind: 'daily' as const, time: '08:00', days: [1, 2, 3, 4, 5] }, companionId: 'companion-1' }
    expect(routineSave.safeParse(draft).success).toBe(false)
    const input = proposalSaveInput(draft)
    expect(input).toEqual({ ...draft, enabled: true })
    expect(routineSave.safeParse(input).success).toBe(true)
  })
})
