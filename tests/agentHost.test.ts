/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { ChatAgentEvent, QueuedMessage } from '@shared/chats'
import type { AgentEvent, Effort } from '@shared/ipc'
import { AgentHost } from '../src/main/agent/host'
import { asksForInput, cutPoint, isTypedMessage } from '../src/main/agent/session'
import { ChatStore } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import { ConnectorStore, SkillStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'
import type { AttachmentRef } from '@shared/attachments'
import type { LocalToolSnapshot } from '@shared/connectors'
import { RemoteFileCache } from '../src/main/agent/content'
import { PdfTabReader } from '../src/main/agent/pdfTab'
import type { RichChatDeps } from '../src/main/agent/sessionRichChat'
import type { ConnectorRuntime } from '../src/main/connectors/runtime'
import type { AttachmentStore, PreparedAttachment } from '../src/main/intake/types'

// The host and its sessions against a scripted stand-in for the Messages API.
// No request leaves the machine.

interface Turn {
  text?: string
  /** Browser tool calls in this turn (`client` ones, like memory, have no toolset). */
  tools?: Array<{ name: string; input: unknown; client?: boolean }>
  stop?: string
  /** The stream waits for this before it produces anything (abortable). */
  gate?: Promise<void>
}

interface Request {
  model: string
  system: string
  output_config: { effort: Effort }
  messages: Array<{ role: string; content: unknown }>
}

function abortable(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('aborted'))
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    void gate.then(resolve)
  })
}

function fakeClient(script: (request: Request, n: number) => Turn) {
  const requests: Request[] = []
  const client = {
    beta: {
      messages: {
        stream: (request: Request, { signal }: { signal: AbortSignal }) => {
          requests.push(structuredClone(request))
          const turn = script(request, requests.length)
          const content: unknown[] = []
          if (turn.text) content.push({ type: 'text', text: turn.text, citations: null })
          for (const [i, tool] of (turn.tools ?? []).entries()) {
            content.push({ type: 'tool_use', id: `toolu_${requests.length}_${i}`, name: tool.name, input: tool.input, ...(tool.client ? {} : { toolset_name: 'browser' }) })
          }
          const message = {
            id: `msg_${requests.length}`,
            type: 'message',
            role: 'assistant',
            model: request.model,
            content,
            stop_reason: turn.stop ?? (turn.tools?.length ? 'tool_use' : 'end_turn'),
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: null },
          }
          return {
            async *[Symbol.asyncIterator]() {
              if (turn.gate) await abortable(turn.gate, signal)
              if (turn.text) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } }
            },
            finalMessage: async () => message,
          }
        },
      },
    },
  }
  return { client: () => client as never, requests }
}

function fakeTabs() {
  const controlled: Array<[string, boolean, string | null]> = []
  const tabs = [{ id: 'tab-1' }, { id: 'tab-2' }].map((t) => ({ ...t, view: { webContents: {} } }))
  let active = 'tab-1'
  const manager = {
    find: (id: string) => tabs.find((t) => t.id === id),
    active: () => tabs.find((t) => t.id === active) ?? null,
    activeId: () => active,
    rail: () => null,
    activate: (id: string) => {
      active = id
    },
    all: () => tabs,
    info: (tab: { id: string }) => ({ id: tab.id, title: `Title ${tab.id}`, url: `https://${tab.id}.example/` }),
    setAgentControlled: (id: string, on: boolean, chatId: string | null = null) => controlled.push([id, on, chatId]),
    setNeedsInput: () => undefined,
  }
  return { tabs: manager as unknown as TabManager, controlled }
}

const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious and upbeat.', look: DEFAULT_LOOK }]

function setup(
  script: (request: Request, n: number) => Turn,
  settings: Partial<{ model: string; effort: Effort }> = {},
  options: { memoryGate?: Promise<void> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'apex-host-'))
  const companions = new CompanionStore(dir, { presets: () => presets })
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const skills = new SkillStore(dir)
  const connectors = new ConnectorStore(dir)
  const memoryCalls: Array<[unknown, string | null]> = []
  const events: ChatAgentEvent[] = []
  const queues: Array<[string, QueuedMessage[]]> = []
  const owners: Array<Record<string, string>> = []
  const { tabs, controlled } = fakeTabs()
  const api = fakeClient(script)
  const host = new AgentHost({
    settings: {
      get: () => ({ model: 'claude-opus-5-5', effort: 'high', webTools: true, memory: true, confirmConsequentialActions: true, ...settings }),
      view: () => ({ hasApiKey: true }),
      apiKey: () => 'test-key',
    },
    tabs,
    bridge: {} as never,
    memory: {
      execute: async (input, scope) => {
        memoryCalls.push([input, scope])
        // A step that ignores the abort for a while, like a slow disk or page reply.
        if (options.memoryGate) await options.memoryGate
        return 'ok'
      },
    },
    connectors,
    skills,
    chats,
    companions,
    presets: { personality: (persona) => presets.find((p) => p.id === persona)?.personality },
    client: api.client,
    emit: (event) => events.push(event),
    onTabOwners: (map) => owners.push(map),
    onQueue: (chatId, queued) => queues.push([chatId, queued]),
  })
  const eventsOf = (chatId: string): AgentEvent[] => events.filter((e) => e.chatId === chatId).map((e) => e.event)
  return { host, chats, companions, skills, connectors, events, eventsOf, queues, owners, controlled, memoryCalls, requests: api.requests }
}

async function until(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function gate(): { promise: Promise<void>; open(): void } {
  let open = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe('chat history helpers', () => {
  it('tell typed messages from tool results', () => {
    expect(isTypedMessage({ role: 'user', content: 'hi' })).toBe(true)
    expect(isTypedMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] })).toBe(true)
    expect(isTypedMessage({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] })).toBe(false)
    expect(isTypedMessage({ role: 'assistant', content: 'hi' })).toBe(false)
  })

  it('find where to cut for a message you sent', () => {
    const content = {
      messages: [
        { role: 'user' as const, content: 'one' },
        { role: 'assistant' as const, content: 'a' },
        { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 't' }] },
        { role: 'assistant' as const, content: 'b' },
        { role: 'user' as const, content: 'two' },
      ],
      log: [
        { type: 'user-message' as const, id: 'u1', text: 'one' },
        { type: 'text-delta' as const, turnId: 't1', text: 'a' },
        { type: 'user-message' as const, id: 'u2', text: 'two' },
      ],
    }
    expect(cutPoint(content, 'u2')).toEqual({ messageIndex: 4, logIndex: 2 })
    expect(cutPoint(content, 'u1')).toEqual({ messageIndex: 0, logIndex: 0 })
    expect(cutPoint(content, 'nope')).toBeNull()
    expect(cutPoint({ ...content, messages: content.messages.slice(0, 1) }, 'u1')).toBeNull()
  })

  it('treat a reply ending in a question as waiting for you', () => {
    expect(asksForInput('Found two flights.\n\nWhich one should I book?')).toBe(true)
    expect(asksForInput('Want the cheaper one?**')).toBe(true)
    expect(asksForInput('Booked. Is this ok? Done.')).toBe(false)
    expect(asksForInput('')).toBe(false)
  })
})

describe('agent host', () => {
  it('saves a draft at its first message with the summary fields', async () => {
    const t = setup(() => ({ text: 'Here is the summary.' }))
    const draft = t.host.create()
    expect(draft).toMatchObject({ draft: true, companionId: FIRST_COMPANION_ID, model: 'claude-opus-5-5', status: 'idle' })
    expect(t.chats.list()).toHaveLength(0)
    expect(t.host.view(draft.id)).toMatchObject({ summary: { draft: true }, setup: { fixed: false, effort: 'high', browser: true }, log: [] })

    t.host.send(draft.id, 'Summarize this page\nplease')
    await until(() => t.chats.summary(draft.id)?.status === 'finished', 'finish')
    expect(t.chats.summary(draft.id)).toMatchObject({ title: 'Summarize this page', companionId: FIRST_COMPANION_ID, model: 'claude-opus-5-5', unread: true, needsInput: false, draft: false })
    const view = t.host.view(draft.id)
    expect(view.setup).toMatchObject({ fixed: true, effort: 'high' })
    expect(view.log.map((e) => e.type)).toEqual(['user-message', 'text-delta'])
    expect(view.seq).toBe(t.events.at(-1)?.seq)
    const turnId = (view.log[1] as { turnId: string }).turnId
    expect(t.host.details(draft.id, turnId)).toMatchObject({ model: 'claude-opus-5-5', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 }, stopReason: 'end_turn', memoryPaths: [] })
    // Events are keyed by chat and numbered in order.
    expect(t.events.every((e) => e.chatId === draft.id)).toBe(true)
    expect(t.events.map((e) => e.seq)).toEqual(t.events.map((_, i) => i + 1))
    // The browser context goes with each typed message.
    expect(JSON.stringify(t.requests[0]?.messages[0])).toContain("The user's tab: tab-1")
  })

  it('stays read while a surface shows the chat, and showing it marks it read', async () => {
    const t = setup(() => ({ text: 'Done.' }))
    const id = t.host.start('Hello')
    t.host.setViewing('panel', id)
    await until(() => t.chats.summary(id)?.status === 'finished')
    expect(t.chats.summary(id)?.unread).toBe(false)

    t.host.setViewing('panel', null)
    t.host.send(id, 'Again')
    await until(() => t.chats.summary(id)?.unread === true, 'unread')
    t.host.setViewing('page', id)
    expect(t.chats.summary(id)?.unread).toBe(false)
  })

  it('resolves model and effort: chat choice, then companion default, then global', async () => {
    const t = setup(() => ({ text: 'ok' }), { model: 'claude-opus-5-5', effort: 'high' })
    const nova = t.companions.create({ presetId: 'nova' })
    t.companions.update(nova.id, { model: 'claude-sonnet-5-5', effort: 'low', instructions: 'Answer in haiku.' })

    const fromCompanion = t.host.create({ companionId: nova.id })
    expect(t.host.view(fromCompanion.id).setup).toMatchObject({ companionId: nova.id, model: 'claude-sonnet-5-5', effort: 'low' })
    const chosen = t.host.create({ companionId: nova.id, model: 'claude-haiku-5-5', effort: 'max' })
    expect(t.host.view(chosen.id).setup).toMatchObject({ model: 'claude-haiku-5-5', effort: 'max' })
    t.host.configure(chosen.id, { effort: 'medium' })
    expect(t.host.view(chosen.id).setup.effort).toBe('medium')

    t.host.send(chosen.id, 'Hi')
    await until(() => t.chats.summary(chosen.id)?.status === 'finished')
    const request = t.requests[0]
    expect(request).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'medium' } })
    // The companion's name, personality and standing instructions are in the prompt.
    expect(request?.system).toContain('You are Nova')
    expect(request?.system).toContain('Curious and upbeat.')
    expect(request?.system).toContain('<standing_instructions>\nAnswer in haiku.\n</standing_instructions>')
    expect(request?.system).toContain('/memories/shared/')
    expect(() => t.host.configure(chosen.id, { model: 'claude-opus-5-5' })).toThrow(/Continue in a new chat/)

    // Existing chats keep their snapshot when the companion changes.
    t.companions.update(nova.id, { model: 'claude-opus-5-5', effort: 'max' })
    expect(t.host.view(chosen.id).setup).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
  })

  it('keeps a draft’s chosen companion while hidden, and falls back only when it is gone', () => {
    const t = setup(() => ({ text: 'ok' }))
    const nova = t.companions.create({ presetId: 'nova', activate: false })
    const draft = t.host.create({ companionId: nova.id })
    t.companions.setHidden(nova.id, true)
    // Hidden companions keep their chats and routines (CO-03, CO-07).
    expect(t.host.view(draft.id).setup.companionId).toBe(nova.id)
    t.companions.setHidden(nova.id, false)
    const gone = t.companions.create({ presetId: 'nova', activate: false })
    const orphan = t.host.create({ companionId: gone.id })
    t.companions.remove(gone.id)
    expect(t.host.view(orphan.id).setup.companionId).toBe(FIRST_COMPANION_ID)
    expect(() => t.host.create({ companionId: 'missing' })).toThrow('That companion no longer exists.')
    // A draft without a choice follows whoever is active until its first message.
    const open = t.host.create()
    t.companions.setActive(nova.id)
    expect(t.host.view(open.id).summary.companionId).toBe(nova.id)
  })

  it('runs a hidden companion’s routine as that companion, with its own skill', async () => {
    const t = setup(() => ({ text: 'Digest ready.' }))
    const juniper = t.companions.create({ presetId: 'nova', activate: false })
    t.companions.update(juniper.id, { name: 'Juniper' })
    t.skills.save({ name: 'digest', description: '', instructions: 'Summarize my reading list.', owner: juniper.id })
    t.companions.setHidden(juniper.id, true)
    const run = await t.host.runRoutine({ id: 'routine-1', prompt: '/digest', owner: juniper.id })
    expect(run.ok).toBe(true)
    expect(t.chats.summary(run.chatId ?? '')?.companionId).toBe(juniper.id)
    expect(t.requests[0]?.system).toContain('Juniper')
    expect(JSON.stringify(t.requests[0]?.messages)).toContain('Summarize my reading list.')
  })

  it('sends a message typed after Stop once the stopped run winds down', async () => {
    const late = gate()
    const t = setup(
      (_request, n) => (n === 1 ? { tools: [{ name: 'memory', input: { command: 'view', path: '/memories' }, client: true }] } : { text: `Reply ${n}.` }),
      {},
      { memoryGate: late.promise },
    )
    const id = t.host.start('Long task')
    await until(() => t.memoryCalls.length === 1, 'memory step started')
    t.host.stop(id)
    expect(t.host.send(id, 'actually, do this instead')).toEqual({ queued: true })
    late.open()
    await until(() => !t.host.isRunning(id) && t.host.view(id).queued.length === 0 && t.requests.length === 2, 'correction sent')
    const users = t.host.view(id).log.flatMap((e) => (e.type === 'user-message' ? [e.text] : []))
    expect(users).toEqual(['Long task', 'actually, do this instead'])
  })

  it('queues messages sent while running, and stop hands back what was not sent', async () => {
    const first = gate()
    const t = setup((_request, n) => (n === 1 ? { text: 'First.', gate: first.promise } : { text: `Reply ${n}.` }))
    const id = t.host.start('One')
    await until(() => t.host.isRunning(id))
    expect(t.host.send(id, 'Two')).toEqual({ queued: true })
    t.host.send(id, 'Three')
    const queued = t.host.view(id).queued
    expect(queued.map((q) => q.text)).toEqual(['Two', 'Three'])
    t.host.editQueued(id, queued[1]?.id ?? '', 'Three, edited')
    expect(t.queues.at(-1)?.[1].map((q) => q.text)).toEqual(['Two', 'Three, edited'])
    first.open()
    await until(() => t.requests.length === 3 && !t.host.isRunning(id), 'queue drained')
    const users = t.host.view(id).log.flatMap((e) => (e.type === 'user-message' ? [e.text] : []))
    expect(users).toEqual(['One', 'Two', 'Three, edited'])

    const hold = gate()
    const t2 = setup(() => ({ text: 'never', gate: hold.promise }))
    const id2 = t2.host.start('Long task')
    await until(() => t2.host.isRunning(id2))
    t2.host.send(id2, 'Follow-up')
    expect(t2.host.stop(id2)).toEqual(['Follow-up'])
    await until(() => !t2.host.isRunning(id2), 'stopped')
    expect(t2.chats.summary(id2)).toMatchObject({ status: 'idle', unread: false, needsInput: false })
    expect(t2.eventsOf(id2).some((e) => e.type === 'stopped' && e.reason === 'user')).toBe(true)
  })

  it('runs two chats at once without letting both drive the same tab', async () => {
    const holdA = gate()
    const t = setup((request, n) => {
      const first = JSON.stringify(request.messages[0])
      if (first.includes('Chat A')) return n === 1 ? { tools: [{ name: 'switch_tab', input: { tab_id: 'tab-2' } }] } : { text: 'A done.', gate: holdA.promise }
      return request.messages.length === 1 ? { tools: [{ name: 'switch_tab', input: { tab_id: 'tab-2' } }] } : { text: 'B done.' }
    })
    const a = t.host.start('Chat A')
    await until(() => t.host.tabOwners()['tab-2'] === a, 'A owns the tab')
    expect(t.controlled).toContainEqual(['tab-2', true, a])
    expect(t.host.view(a).tabIds).toEqual(['tab-2'])

    const b = t.host.start('Chat B')
    await until(() => t.chats.summary(b)?.status === 'finished', 'B finished')
    const refused = t.eventsOf(b).find((e) => e.type === 'tool' && e.state === 'error')
    expect(refused).toMatchObject({ detail: expect.stringContaining('Another chat is working in this tab') })
    expect(t.host.tabOwners()).toEqual({ 'tab-2': a })
    expect(t.host.isRunning(a)).toBe(true)

    holdA.open()
    await until(() => t.chats.summary(a)?.status === 'finished', 'A finished')
    expect(t.host.tabOwners()).toEqual({})
    expect(t.controlled.at(-1)).toEqual(['tab-2', false, null])
    expect(t.owners.at(-1)).toEqual({})
  })

  it('edits and resends: cuts the history at your message and replays the rest', async () => {
    const t = setup((request) => ({ text: `Answer ${request.messages.length}` }))
    const id = t.host.start('First question')
    await until(() => t.chats.summary(id)?.status === 'finished')
    t.host.send(id, 'Second question')
    await until(() => t.host.view(id).log.filter((e) => e.type === 'text-delta').length === 2)
    await until(() => !t.host.isRunning(id))
    const log = t.host.view(id).log
    const second = log.find((e) => e.type === 'user-message' && e.text === 'Second question') as { id: string }
    const firstTurn = (log[1] as { turnId: string }).turnId
    t.host.feedback(id, firstTurn, 'helpful', ' Great ')
    const seqBefore = t.events.at(-1)?.seq ?? 0

    t.host.editAndResend(id, second.id, 'Second, reworded')
    await until(() => !t.host.isRunning(id) && t.requests.length === 3)
    const replay = t.events.filter((e) => e.seq > seqBefore).map((e) => e.event.type)
    expect(replay.slice(0, 3)).toEqual(['reset', 'user-message', 'text-delta'])
    const users = t.host.view(id).log.flatMap((e) => (e.type === 'user-message' ? [e.text] : []))
    expect(users).toEqual(['First question', 'Second, reworded'])
    // The cut history is what the API sees: first exchange, then the new text.
    const sent = t.requests[2]?.messages ?? []
    expect(sent).toHaveLength(3)
    expect(JSON.stringify(sent[2])).toContain('Second, reworded')
    // Ratings on kept replies survive the cut.
    expect(t.host.view(id).feedback[firstTurn]).toMatchObject({ rating: 'helpful', note: 'Great' })

    // Retry the last reply: resend the message before it.
    t.host.retry(id)
    await until(() => !t.host.isRunning(id) && t.requests.length === 4)
    expect(t.host.view(id).log.flatMap((e) => (e.type === 'user-message' ? [e.text] : []))).toEqual(['First question', 'Second, reworded'])
    expect(() => t.host.editAndResend(id, '00000000-0000-4000-8000-000000000000', 'x')).toThrow(/no longer in this chat/)
  })

  it('marks chats that wait for you, and paused runs', async () => {
    const t = setup(() => ({ text: 'Two options. Which do you prefer?' }))
    const id = t.host.start('Plan dinner')
    await until(() => t.chats.summary(id)?.status === 'finished')
    expect(t.chats.summary(id)?.needsInput).toBe(true)

    const cut = setup(() => ({ tools: [{ name: 'list_tabs', input: {} }], stop: 'max_tokens' }))
    const id2 = cut.host.start('Do a big thing')
    await until(() => cut.chats.summary(id2)?.status === 'error')
    expect(cut.chats.summary(id2)?.needsInput).toBe(true)
  })

  it('runs routines as background chats of their companion, without tabs', async () => {
    const t = setup(() => ({ text: 'Morning brief.' }))
    const nova = t.companions.create({ presetId: 'nova', activate: false })
    const run = await t.host.runRoutine({ id: 'r1', prompt: 'Brief me', owner: nova.id })
    expect(run.ok).toBe(true)
    expect(t.chats.summary(run.chatId ?? '')).toMatchObject({ routineId: 'r1', companionId: nova.id, unread: true, status: 'finished' })
    expect(t.host.view(run.chatId ?? '').setup.browser).toBe(false)
    expect(t.requests[0]?.system).toContain('scheduled routine')
    // Shared routines run as the active companion.
    const shared = await t.host.runRoutine({ id: 'r2', prompt: 'Brief me', owner: 'shared' })
    expect(t.chats.summary(shared.chatId ?? '')?.companionId).toBe(FIRST_COMPANION_ID)
  })

  it('expands the companion’s own skill and records its use', async () => {
    const t = setup(() => ({ text: 'ok' }))
    const own = t.skills.save({ name: 'recap', description: '', instructions: 'Own recap steps.', owner: FIRST_COMPANION_ID })
    t.skills.save({ name: 'recap', description: '', instructions: 'Shared recap steps.' })
    const id = t.host.start('/recap today')
    await until(() => t.chats.summary(id)?.status === 'finished')
    expect(JSON.stringify(t.requests[0]?.messages[0])).toContain('Own recap steps.')
    expect(t.skills.get(own.id)?.lastUsedAt).not.toBeNull()
  })

  it('renames drafts and saved chats, refuses blank names, and forgets removed chats', async () => {
    const t = setup(() => ({ text: 'ok' }))
    const draft = t.host.create()
    expect(t.host.rename(draft.id, '  Trip   ideas ').title).toBe('Trip ideas')
    t.host.send(draft.id, 'Where to?')
    await until(() => t.chats.summary(draft.id)?.status === 'finished')
    expect(t.chats.summary(draft.id)?.title).toBe('Trip ideas')
    expect(t.host.rename(draft.id, 'Lisbon').title).toBe('Lisbon')
    expect(() => t.host.rename(draft.id, '   ')).toThrow('Give the chat a name.')
    expect(t.host.markdown(draft.id).text).toContain('# Lisbon')
    t.host.discard([draft.id])
    t.chats.remove([draft.id])
    expect(() => t.host.view(draft.id)).toThrow('This chat no longer exists.')
  })
})

// ---- local connector approvals, continue in a new chat, duplicate ----

const issueTool: LocalToolSnapshot = { connectorId: 'tracker', apiName: 'Tracker__create_issue', toolName: 'create_issue', description: 'Creates an issue.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } }, actionLabel: 'Create issue' }

function richChatDeps(dir: string) {
  const calls: unknown[] = []
  const copies: Array<[string, string, readonly string[] | undefined]> = []
  const note: PreparedAttachment = { ref: { id: 'a1', kind: 'text', name: 'notes.txt', state: 'ready', error: null, size: 5, mediaType: 'text/plain', thumbnail: null } as AttachmentRef, payload: { type: 'text', text: 'Notes', title: 'notes.txt', sourceUrl: null } }
  const runtime = {
    localTools: () => [issueTool],
    resolveServer: () => [],
    livePolicy: () => 'ask',
    validateInput: (_c: string, _t: string, input: unknown) => ((input as { title?: string })?.title ? { ok: true } : { ok: false, errors: [{ path: 'title', message: 'Required' }] }),
    callLocal: async (_c: string, _t: string, input: unknown) => {
      calls.push(input)
      return { content: 'Created #42', isError: false }
    },
  } as unknown as ConnectorRuntime
  const store = {
    resolve: (_chatId: string, ids: readonly string[]) => ids.map(() => note),
    bindToMessage: () => undefined,
    copyForChat: (from: string, to: string, ids?: readonly string[]) => {
      copies.push([from, to, ids])
      return { copied: 1, failed: 1 }
    },
    setRemoteFile: () => undefined,
  } as unknown as AttachmentStore
  const unavailable = (): never => {
    throw new Error('not in this test')
  }
  const deps: RichChatDeps = { attachments: () => store, chatContext: unavailable, libraryFiles: unavailable, connectors: () => runtime, remoteFiles: new RemoteFileCache(dir), pdf: new PdfTabReader(async () => ({ pages: 0, text: '' })), directory: () => null, builtinSkill: () => undefined }
  return { deps, calls, copies }
}

describe('agent host: local connectors, continue and duplicate', () => {
  it('waits for a local connector approval and runs the edited input (CH-40)', async () => {
    const t = setup((_request, n) => (n === 1 ? { tools: [{ name: 'Tracker__create_issue', input: { title: 'Bug' }, client: true }] } : { text: 'Filed it.' }))
    const c = richChatDeps(mkdtempSync(join(tmpdir(), 'apex-host-c-')))
    t.host.useRichChat(c.deps)
    const id = t.host.start('file a bug')
    await until(() => t.eventsOf(id).some((e) => e.type === 'connector-approval'), 'the approval card')
    const card = t.eventsOf(id).find((e) => e.type === 'connector-approval')
    expect(card).toMatchObject({ connectorId: 'tracker', tool: 'create_issue', actionLabel: 'Create issue', input: { title: 'Bug' } })
    const approvalId = card?.type === 'connector-approval' ? card.approvalId : ''
    expect(() => t.host.approveConnector(id, approvalId, { allowed: true, input: {} })).toThrow(/Check the form/)
    t.host.approveConnector(id, approvalId, { allowed: true, input: { title: 'Login bug' } })
    await until(() => !t.host.isRunning(id), 'the run to end')
    expect(c.calls).toEqual([{ title: 'Login bug' }])
    const results = t.requests[1]?.messages.at(-1)?.content as Array<{ type: string; content?: unknown; is_error?: boolean }>
    expect(results.find((b) => b.type === 'tool_result')).toMatchObject({ content: 'Created #42' })
    // The request offered the frozen local tool.
    expect((t.requests[0] as unknown as { tools: Array<{ name?: string }> }).tools.some((tool) => tool.name === 'Tracker__create_issue')).toBe(true)
  })

  it('continues in a new chat with the last message and its copied attachments (CH-41)', async () => {
    const t = setup(() => ({ text: 'Okay.' }))
    const c = richChatDeps(mkdtempSync(join(tmpdir(), 'apex-host-c-')))
    t.host.useRichChat(c.deps)
    const id = t.host.start('summarize my notes', {}, [{ kind: 'ref', id: 'a1' }])
    await until(() => !t.host.isRunning(id), 'the first chat')
    const next = t.host.continueInNewChat(id)
    expect(next.id).not.toBe(id)
    await until(() => t.requests.length === 2 && !t.host.isRunning(next.id), 'the new chat')
    expect(c.copies[0]).toEqual([id, next.id, ['a1']])
    const sent = t.requests[1]?.messages[0]?.content as Array<{ type: string; text?: string; title?: string }>
    expect(sent.at(-1)).toMatchObject({ type: 'text', text: 'summarize my notes' })
    expect(sent.some((b) => b.type === 'document' && b.title === 'notes.txt')).toBe(true)
  })

  it('duplicates a chat and counts the attachments that could not be copied (CH-47)', async () => {
    const t = setup(() => ({ text: 'Okay.' }))
    const dir = mkdtempSync(join(tmpdir(), 'apex-host-c-'))
    const c = richChatDeps(dir)
    t.host.useRichChat(c.deps)
    const id = t.host.start('hello')
    await until(() => !t.host.isRunning(id), 'the chat')
    c.deps.remoteFiles.set(id, 'a1', 'fp', 'file_1')
    const { summary, failed } = t.host.duplicate(id)
    expect(failed).toBe(1)
    expect(c.copies.at(-1)).toEqual([id, summary.id, undefined])
    expect(c.deps.remoteFiles.get(summary.id, 'a1', 'fp')).toBe('file_1')
  })
})
