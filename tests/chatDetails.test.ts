/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/ipc'
import type { MessageDetails } from '@shared/chats'
import type { LibraryFileRef } from '@shared/files'
import { foldAgentLog } from '../src/renderer/src/agentLog'
import {
  COLLAPSED_BY_DEFAULT,
  DETAILS_OVERLAY_BELOW,
  canContinue,
  delegationTone,
  detailsMode,
  detailsModel,
  isCollapsed,
  sectionCount,
  shouldAutoOpen,
  usageRows,
  viewerTargetFor,
  visibleSections,
  type DetailsInput,
} from '../src/renderer/src/chat/logic/details'

// The details panel's pure fold (CH-35, DS-124): what each section lists,
// which sections show, their counts and collapse defaults, when the panel
// opens by itself, where files open and what the usage rows read.

const file = (id: string, state: LibraryFileRef['state'] = 'ready'): LibraryFileRef => ({
  id,
  name: `${id}.pdf`,
  mediaType: 'application/pdf',
  size: 1,
  kind: 'report',
  chatId: 'c1',
  companionId: 'pip',
  createdAt: 1,
  state,
  artifact: false,
})

const details = (turnId: string, inputTokens: number, outputTokens: number): MessageDetails => ({
  turnId,
  at: 1,
  model: 'm',
  usage: { inputTokens, outputTokens, cacheReadTokens: 10, cacheWriteTokens: 0 },
  stopReason: null,
  memoryPaths: [],
})

function model(events: AgentEvent[], patch: Partial<DetailsInput> = {}) {
  return detailsModel({ items: foldAgentLog(events).items, details: {}, connectorIds: [], connectorNames: {}, routineId: null, usedTabIds: [], ...patch })
}

describe('details fold', () => {
  it('collects the plan, files, sources, skills, sub-tasks and connectors', () => {
    const m = model(
      [
        { type: 'user-message', id: 'u1', text: '/brief go', skill: { id: 'brief', name: 'brief', builtin: false } },
        { type: 'user-message', id: 'u2', text: '/brief again', skill: { id: 'brief', name: 'brief', builtin: false } },
        { type: 'plan', items: [{ id: 'a', title: 'Read', status: 'done' }, { id: 'b', title: 'Skip', status: 'skipped' }, { id: 'c', title: 'Write', status: 'active' }] },
        { type: 'file-produced', turnId: 't1', file: file('f1') },
        { type: 'file-produced', turnId: 't1', file: file('f2', 'failed') },
        { type: 'file-written', turnId: 't1', ref: { kind: 'companion', companionId: 'pip', path: 'notes.md' }, name: 'notes.md' },
        { type: 'source', url: 'https://a.test', title: 'A' },
        { type: 'delegation', id: 'd1', childChatId: 'k1', title: 'Look up', status: 'working' },
        { type: 'delegation', id: 'd1', childChatId: 'k1', title: 'Look up', status: 'done' },
      ],
      { connectorIds: ['gh', 'cal'], connectorNames: { gh: 'GitHub' }, details: { t1: details('t1', 100, 50), t2: details('t2', 20, 5) } },
    )
    expect(m.plan.map((p) => p.id)).toEqual(['a', 'b', 'c'])
    expect(m.planDone).toBe(2)
    expect(m.files.map((f) => f.name)).toEqual(['f1.pdf', 'notes.md'])
    expect(m.sources).toEqual([{ url: 'https://a.test', title: 'A' }])
    expect(m.skills).toEqual([{ id: 'brief', name: 'brief', builtin: false }])
    expect(m.subtasks).toEqual([{ id: 'd1', childChatId: 'k1', title: 'Look up', status: 'done' }])
    expect(m.connectors).toEqual([{ id: 'gh', name: 'GitHub' }, { id: 'cal', name: 'cal' }])
    expect(m.tokens).toEqual({ inputTokens: 120, outputTokens: 55, cacheReadTokens: 20, cacheWriteTokens: 0, turns: 2 })
  })

  it('drops a file whose report failed after it was writing', () => {
    const m = model([
      { type: 'file-produced', turnId: 't1', file: file('f1', 'writing') },
      { type: 'file-produced', turnId: 't1', file: file('f1', 'failed') },
    ])
    expect(m.files).toEqual([])
  })

  it('shows the companion and tokens always, the rest only with content, in DS-124 order', () => {
    expect(visibleSections(model([]))).toEqual(['companion', 'usage'])
    const full = model(
      [
        { type: 'plan', items: [{ id: 'a', title: 'x', status: 'pending' }] },
        { type: 'source', url: 'https://a.test', title: 'A' },
        { type: 'delegation', id: 'd', childChatId: 'k', title: 't', status: 'working' },
      ],
      { routineId: 'r1', connectorIds: ['gh'] },
    )
    expect(visibleSections(full)).toEqual(['companion', 'plan', 'connectors', 'context', 'subtasks', 'sources', 'usage'])
    expect(sectionCount(full, 'plan')).toBe(1)
    expect(sectionCount(full, 'companion')).toBeNull()
    expect(sectionCount(full, 'usage')).toBeNull()
  })

  it('starts files and tokens collapsed, and remembers your choice', () => {
    expect([...COLLAPSED_BY_DEFAULT].sort()).toEqual(['files', 'usage'])
    expect(isCollapsed('files', {})).toBe(true)
    expect(isCollapsed('plan', {})).toBe(false)
    expect(isCollapsed('files', { files: false })).toBe(false)
    expect(isCollapsed('plan', { plan: true })).toBe(true)
  })

  it('opens by itself once, on the first plan or produced file', () => {
    const plain = foldAgentLog([{ type: 'user-message', id: 'u', text: 'hi' }]).items
    const planned = foldAgentLog([{ type: 'plan', items: [] }]).items
    const failed = foldAgentLog([{ type: 'file-produced', turnId: 't', file: file('f', 'failed') }]).items
    const written = foldAgentLog([{ type: 'file-written', turnId: 't', ref: { kind: 'library', id: 'x' }, name: 'x' }]).items
    expect(shouldAutoOpen(plain, false)).toBe(false)
    expect(shouldAutoOpen(planned, false)).toBe(true)
    expect(shouldAutoOpen(failed, false)).toBe(false)
    expect(shouldAutoOpen(written, false)).toBe(true)
    // Once you opened or closed it for this chat, it never opens by itself again.
    expect(shouldAutoOpen(planned, true)).toBe(false)
  })

  it('overlays the chat below the narrow-window width', () => {
    expect(detailsMode(DETAILS_OVERLAY_BELOW - 1)).toBe('overlay')
    expect(detailsMode(DETAILS_OVERLAY_BELOW)).toBe('column')
  })

  it('maps sub-task status to pill tones, and only stopped or interrupted ones continue', () => {
    expect(delegationTone('working')).toBe('working')
    expect(delegationTone('done')).toBe('success')
    expect(delegationTone('needs-input')).toBe('needs-input')
    expect(delegationTone('needs-attention')).toBe('error')
    expect(delegationTone('stopped')).toBe('idle')
    expect(canContinue('interrupted')).toBe(true)
    expect(canContinue('done')).toBe(false)
  })

  it('opens files in the viewer where it can, else in Workspace', () => {
    const m = model([
      { type: 'file-produced', turnId: 't', file: file('lib') },
      { type: 'file-written', turnId: 't', ref: { kind: 'memory', owner: 'pip', path: 'm.md' }, name: 'm.md' },
      { type: 'file-written', turnId: 't', ref: { kind: 'folder', folderId: 'f', path: 'a.txt' }, name: 'a.txt' },
      { type: 'file-written', turnId: 't', ref: { kind: 'skill', skillId: 's', path: 'SKILL.md' }, name: 'SKILL.md' },
    ])
    expect(m.files.map(viewerTargetFor)).toEqual([{ kind: 'library', id: 'lib' }, { kind: 'memory', owner: 'pip', path: 'm.md' }, null, { kind: 'skill', skillId: 's' }])
  })

  it('reads usage from the service when it answered, else from the turns', () => {
    const m = model([], { details: { t1: details('t1', 100, 50) } })
    expect(usageRows(m, null)).toMatchObject({ input: 100, output: 50, cacheRead: 10, turns: 1, costUsd: null, total: 160 })
    const service = { inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 5, turns: 3, approxCostUsd: 0.42 }
    expect(usageRows(m, service)).toEqual({ input: 200, output: 80, cacheRead: 0, cacheWrite: 5, turns: 3, costUsd: 0.42, total: 285 })
    expect(usageRows(m, { ...service, approxCostUsd: null }).costUsd).toBeNull()
  })
})
