/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import type { DirectoryEntry, LocalToolSnapshot, ToolPolicy } from '@shared/connectors'
import type { LibraryFileRef } from '@shared/files'
import type { AgentEvent } from '@shared/ipc'
import type { ConnectorRuntime } from '../src/main/connectors/runtime'
import type { LibraryFiles } from '../src/main/files/types'
import { ArtifactReports, beginArtifact, matchDirectory, runReplyTool, type ReplyToolContext, type DirectoryView } from '../src/main/agent/replyToolRun'
import { replyToolNames, replyToolParams, saveArtifactInput, suggestNextStepsInput } from '../src/main/agent/replyTools'
import { callLocalTool, ConnectorApprovals, localToolApiNames, snapshotLocalTools, type LocalCallContext } from '../src/main/agent/localTools'

// The reply client tools (suggest_next_steps, save_artifact, suggest_connector)
// and the local connector tools' approval round trip. Fakes only.

function fakeLibrary() {
  const files = new Map<string, LibraryFileRef>()
  const calls: string[] = []
  let n = 0
  const library = {
    beginReport: (input: { chatId: string; companionId: string; name: string; mediaType: string }) => {
      calls.push(`begin:${input.name}`)
      const ref: LibraryFileRef = { id: `f${++n}`, name: input.name, mediaType: input.mediaType, size: 0, kind: 'generated', chatId: input.chatId, companionId: input.companionId, createdAt: 1, state: 'writing', artifact: false } as LibraryFileRef
      files.set(ref.id, ref)
      return ref
    },
    finishReport: (id: string, content: string | Buffer) => {
      calls.push(`finish:${id}`)
      const ref = { ...files.get(id)!, size: Buffer.byteLength(content), state: 'ready' } as LibraryFileRef
      files.set(id, ref)
      return ref
    },
    fail: (id: string, message: string) => calls.push(`fail:${id}:${message.slice(0, 20)}`),
  }
  return { library: library as unknown as LibraryFiles, calls, files }
}

const directory: DirectoryView = {
  entries: [
    { id: 'linear', name: 'Linear', description: '', category: 'work', url: 'https://mcp.linear.app/mcp', auth: 'oauth', site: 'linear.app' },
    { id: 'notion', name: 'Notion', description: '', category: 'work', url: 'https://mcp.notion.com/mcp', auth: 'oauth', site: 'notion.so' },
  ] as unknown as DirectoryEntry[],
  connected: ['notion'],
}

function toolContext(options: { directory?: DirectoryView | null } = {}) {
  const { library, calls } = fakeLibrary()
  const events: AgentEvent[] = []
  const base = { chatId: 'c1', companionId: 'nova', turnId: 't1', emit: (e: AgentEvent) => events.push(e), library: () => library }
  const reports = new ArtifactReports((_callId, title, format) => beginArtifact(base, title, format))
  const ctx: ReplyToolContext = { ...base, directory: () => (options.directory === undefined ? directory : options.directory), reports }
  return { ctx, events, calls, reports }
}

describe('the tool set', () => {
  it('is fixed and sorted, and routines only save artifacts', () => {
    expect(replyToolNames({ routine: false })).toEqual(['save_artifact', 'suggest_connector', 'suggest_next_steps'])
    expect(replyToolNames({ routine: true })).toEqual(['save_artifact'])
  })

  it('streams save_artifact input eagerly, and only that tool', () => {
    const params = replyToolParams(replyToolNames({ routine: false }))
    expect(params.map((p) => p.name)).toEqual(['save_artifact', 'suggest_connector', 'suggest_next_steps'])
    expect(params.find((p) => p.name === 'save_artifact')?.eager_input_streaming).toBe(true)
    expect(params.filter((p) => p.eager_input_streaming)).toHaveLength(1)
    for (const p of params) expect(p.input_schema.type).toBe('object')
  })

  it('validates inputs with zod', () => {
    expect(suggestNextStepsInput.safeParse({ steps: [] }).success).toBe(false)
    expect(suggestNextStepsInput.safeParse({ steps: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false)
    expect(suggestNextStepsInput.safeParse({ steps: ['Book it'], extra: 1 }).success).toBe(false)
    expect(saveArtifactInput.safeParse({ title: 'Plan', format: 'docx', content: 'x' }).success).toBe(false)
    expect(saveArtifactInput.safeParse({ title: 'Plan', format: 'markdown', content: '# Plan' }).success).toBe(true)
  })
})

describe('suggest_next_steps', () => {
  it('emits a suggestions event', async () => {
    const t = toolContext()
    const text = await runReplyTool('suggest_next_steps', { heading: 'Next', steps: ['Compare prices', 'Book the 9:40 train'] }, 'call_1', t.ctx)
    expect(text).toMatch(/Shown to the user/)
    expect(t.events).toEqual([{ type: 'suggestions', id: expect.any(String), turnId: 't1', heading: 'Next', items: ['Compare prices', 'Book the 9:40 train'] }])
  })

  it('throws a readable error for invalid input, and emits nothing', async () => {
    const t = toolContext()
    await expect(runReplyTool('suggest_next_steps', { steps: ['1', '2', '3', '4', '5'] }, 'call_1', t.ctx)).rejects.toThrow()
    expect(t.events).toEqual([])
  })
})

describe('save_artifact', () => {
  it('begins the report while the input streams, then finishes it (html is an artifact)', async () => {
    const t = toolContext()
    t.reports.start(2, 'call_9')
    t.reports.delta(2, '{"title": "Trip pl')
    expect(t.calls).toEqual([])
    t.reports.delta(2, 'an", "format": "html", "content": "<h1>')
    expect(t.calls).toEqual(['begin:Trip plan.html'])
    const writing = t.events.at(-1)
    expect(writing).toMatchObject({ type: 'file-produced', file: { artifact: true, state: 'writing' } })
    t.reports.delta(2, 'Hi</h1>"}')
    const text = await runReplyTool('save_artifact', { title: 'Trip plan', format: 'html', content: '<h1>Hi</h1>' }, 'call_9', t.ctx)
    expect(text).toMatch(/Saved “Trip plan.html”/)
    expect(t.calls).toEqual(['begin:Trip plan.html', 'finish:f1'])
    expect(t.events.at(-1)).toMatchObject({ type: 'file-produced', turnId: 't1', file: { id: 'f1', state: 'ready', artifact: true } })
  })

  it('begins at run time when nothing streamed; markdown is not an artifact', async () => {
    const t = toolContext()
    await runReplyTool('save_artifact', { title: 'Notes', format: 'markdown', content: '# Notes' }, 'call_2', t.ctx)
    expect(t.calls).toEqual(['begin:Notes.md', 'finish:f1'])
    expect(t.events.at(-1)).toMatchObject({ type: 'file-produced', file: { state: 'ready', artifact: false } })
  })

  it('marks a begun report failed when the final input is invalid', async () => {
    const t = toolContext()
    t.reports.start(0, 'call_3')
    t.reports.delta(0, '{"title":"Data","format":"csv","content":""}')
    await expect(runReplyTool('save_artifact', { title: 'Data', format: 'csv', content: '' }, 'call_3', t.ctx)).rejects.toThrow()
    expect(t.calls[0]).toBe('begin:Data.csv')
    expect(t.calls[1]).toMatch(/^fail:f1:/)
    expect(t.events.at(-1)).toMatchObject({ type: 'file-produced', file: { state: 'failed' } })
  })

  it('lists reports whose call never ran, so they can be marked failed', () => {
    const t = toolContext()
    t.reports.start(1, 'call_4')
    t.reports.delta(1, '{"title":"Cut","format":"text","content":"half')
    expect(t.reports.pending().map((r) => r.id)).toEqual(['f1'])
    expect(t.reports.pending()).toEqual([])
  })
})

describe('suggest_connector', () => {
  it('emits connector-needed only for a directory service that is not connected', async () => {
    const t = toolContext()
    const text = await runReplyTool('suggest_connector', { service: 'linear', reason: 'To file the bug.' }, 'call_5', t.ctx)
    expect(text).toMatch(/connect Linear/)
    expect(t.events).toEqual([{ type: 'connector-needed', id: expect.any(String), turnId: 't1', directoryId: 'linear', service: 'Linear', reason: 'To file the bug.' }])
  })

  it('emits nothing for a connected or unknown service', async () => {
    const t = toolContext()
    expect(await runReplyTool('suggest_connector', { service: 'Notion', reason: 'Notes.' }, 'call_6', t.ctx)).toMatch(/already connected/)
    expect(await runReplyTool('suggest_connector', { service: 'Teletext', reason: 'News.' }, 'call_7', t.ctx)).toMatch(/no ready-made connector/)
    expect(t.events).toEqual([])
  })

  it('still offers a card while the directory is unavailable', async () => {
    const t = toolContext({ directory: null })
    await runReplyTool('suggest_connector', { service: 'Linear', reason: 'Issues.' }, 'call_8', t.ctx)
    expect(t.events[0]).toMatchObject({ type: 'connector-needed', directoryId: null, service: 'Linear' })
  })

  it('matches directory names loosely', () => {
    expect(matchDirectory('Linear app', directory.entries)?.id).toBe('linear')
    expect(matchDirectory('notion.so', directory.entries)?.id).toBe('notion')
    expect(matchDirectory('  ', directory.entries)).toBeNull()
  })
})

// ---- local connector tools ----

const issueTool: LocalToolSnapshot = {
  connectorId: 'tracker',
  apiName: 'Tracker__create_issue',
  toolName: 'create_issue',
  description: 'Creates an issue.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  actionLabel: 'Create issue',
}

function localSetup(policy: ToolPolicy, options: { routine?: boolean } = {}) {
  const events: AgentEvent[] = []
  const calls: unknown[] = []
  const awaiting: boolean[] = []
  const approvals = new ConnectorApprovals()
  const abort = new AbortController()
  const runtime = {
    livePolicy: () => policy,
    validateInput: (_c: string, _t: string, input: unknown) =>
      typeof (input as { title?: unknown })?.title === 'string' && (input as { title: string }).title.length > 0 ? { ok: true } : { ok: false, errors: [{ path: 'title', message: 'Required' }] },
    callLocal: async (_c: string, _t: string, input: unknown) => {
      calls.push(input)
      return { content: 'Created #42', isError: false }
    },
  } as unknown as ConnectorRuntime
  const ctx: LocalCallContext = { runtime, approvals, connectorName: () => 'Tracker', emit: (e) => events.push(e), awaiting: (on) => awaiting.push(on), routine: options.routine === true, signal: abort.signal }
  const approvalId = (): string => {
    const event = events.find((e) => e.type === 'connector-approval')
    return event && event.type === 'connector-approval' ? event.approvalId : ''
  }
  return { ctx, events, calls, awaiting, approvals, abort, approvalId }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('local connector approvals', () => {
  it('runs an allowed tool at once', async () => {
    const t = localSetup('allow')
    expect(await callLocalTool(issueTool, { title: 'Bug' }, t.ctx)).toEqual({ content: 'Created #42', isError: false })
    expect(t.events).toEqual([])
  })

  it('asks, then runs with the edited input after revalidating it', async () => {
    const t = localSetup('ask')
    const pending = callLocalTool(issueTool, { title: 'Bug' }, t.ctx)
    await tick()
    expect(t.events[0]).toMatchObject({ type: 'connector-approval', connectorId: 'tracker', connectorName: 'Tracker', tool: 'create_issue', actionLabel: 'Create issue', input: { title: 'Bug' } })
    expect(t.awaiting).toEqual([true])
    // An edit that fails the schema throws, and the approval keeps waiting.
    expect(() => t.approvals.respond(t.approvalId(), { allowed: true, input: { title: '' } })).toThrow(/Check the form: title: Required/)
    expect(t.approvals.pending).toBe(1)
    t.approvals.respond(t.approvalId(), { allowed: true, input: { title: 'Login bug' } })
    expect(await pending).toEqual({ content: 'Created #42', isError: false })
    expect(t.calls).toEqual([{ title: 'Login bug' }])
    expect(t.awaiting).toEqual([true, false])
    expect(t.events.at(-1)).toEqual({ type: 'connector-approval-resolved', approvalId: t.approvalId(), outcome: 'confirmed', edited: true })
    expect(() => t.approvals.respond(t.approvalId(), { allowed: false })).toThrow(/already answered/)
  })

  it('returns a decline with the person’s message as an error result', async () => {
    const t = localSetup('ask')
    const pending = callLocalTool(issueTool, { title: 'Bug' }, t.ctx)
    await tick()
    t.approvals.respond(t.approvalId(), { allowed: false, message: 'Use the other project' })
    expect(await pending).toEqual({ content: 'Declined: Use the other project', isError: true })
    expect(t.calls).toEqual([])
    expect(t.events.at(-1)).toMatchObject({ outcome: 'declined', edited: false })
  })

  it('declines when the chat stops', async () => {
    const t = localSetup('ask')
    const pending = callLocalTool(issueTool, { title: 'Bug' }, t.ctx)
    await tick()
    t.abort.abort()
    expect(await pending).toEqual({ content: 'Not run: the user stopped the chat.', isError: true })
  })

  it('refuses under a live off policy, and in background runs that would need to ask', async () => {
    const off = localSetup('off')
    const refused = await callLocalTool(issueTool, { title: 'Bug' }, off.ctx)
    expect(refused.isError).toBe(true)
    expect(refused.content).toMatch(/turned off create_issue for Tracker/)
    const routine = localSetup('ask', { routine: true })
    expect((await callLocalTool(issueTool, { title: 'Bug' }, routine.ctx)).content).toMatch(/background run/)
    expect(off.calls).toEqual([])
    expect(routine.events).toEqual([])
  })
})

describe('the local tool snapshot', () => {
  it('orders tools by connector name, then tool name, whatever the runtime order', () => {
    const tools: LocalToolSnapshot[] = [
      { ...issueTool, connectorId: 'b', apiName: 'Zeta__list', toolName: 'list' },
      { ...issueTool, connectorId: 'a', apiName: 'Alpha__search', toolName: 'search' },
      { ...issueTool, connectorId: 'a', apiName: 'Alpha__add', toolName: 'add' },
    ]
    const names = { a: 'Alpha', b: 'Zeta' } as Record<string, string>
    const once = snapshotLocalTools(tools, (id) => names[id] ?? id)
    expect(once.map((t) => t.apiName)).toEqual(['Alpha__add', 'Alpha__search', 'Zeta__list'])
    expect(snapshotLocalTools([...tools].reverse(), (id) => names[id] ?? id)).toEqual(once)
  })

  it('makes valid, unique and stable API names when the runtime’s collide', () => {
    const names = localToolApiNames([
      { connectorId: 'one', connectorName: 'My Notes', toolName: 'search notes' },
      { connectorId: 'two', connectorName: 'My Notes', toolName: 'search notes' },
    ])
    expect(names[0]).not.toBe(names[1])
    for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(localToolApiNames([
      { connectorId: 'one', connectorName: 'My Notes', toolName: 'search notes' },
      { connectorId: 'two', connectorName: 'My Notes', toolName: 'search notes' },
    ])).toEqual(names)
  })
})
