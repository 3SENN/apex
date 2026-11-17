/* Copyright (c) 2026 The Apex Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BetaMessage, BetaMessageParam, BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { DEFAULT_LOOK, type CompanionPreset } from '@shared/companion'
import type { ChatAgentEvent } from '@shared/chats'
import type { AgentEvent } from '@shared/ipc'
import { AgentHost } from '../src/main/agent/host'
import {
  compactionParts,
  CompactionWatch,
  historyStart,
  isContextTooLong,
  manualOutcome,
  ON_DEMAND_BETA,
  replacedTokens,
  requestMessages,
  supportsCompaction,
  THRESHOLD_BETA,
} from '../src/main/agent/compaction'
import { ChatStore } from '../src/main/chats'
import { CompanionStore, FIRST_COMPANION_ID } from '../src/main/companions'
import { smokeRichChat } from '../src/main/agent/smokeClientRichChat'
import { createSmokeClient } from '../src/main/smokeClient'
import { ConnectorStore, SkillStore } from '../src/main/stores'
import type { TabManager } from '../src/main/tabs'

// CH-26 and SS-03: threshold compaction on API-key chats, the
// compaction block kept verbatim (append-only history), and manual
// compaction. End to end on the offline smoke client.

const summaryOnly: BetaMessageParam = { role: 'assistant', content: [{ type: 'compaction', content: 'Summary.' }] as never }
const user = (text: string): BetaMessageParam => ({ role: 'user', content: text })

describe('what a request adds', () => {
  it('asks for threshold compaction on chats that have it', () => {
    expect(compactionParts({ compaction: true, messages: [user('hi')] })).toEqual({ betas: [THRESHOLD_BETA], context_management: { edits: [{ type: 'compact_20260112' }] } })
    expect(compactionParts({ compaction: false, messages: [user('hi')] })).toEqual({ betas: [] })
  })

  it('asks for an on-demand summary when compacting by hand', () => {
    const parts = compactionParts({ compaction: true, messages: [user('hi')], manual: true })
    expect(parts.betas).toEqual([ON_DEMAND_BETA])
    expect(parts.compaction).toMatchObject({ type: 'summarize', instructions: expect.stringContaining('Summarize this conversation') })
    expect(parts.context_management).toBeUndefined()
  })

  it('keeps the on-demand beta while the history carries a summary, without the threshold edit', () => {
    const history = [user('a'), summaryOnly, user('b')]
    expect(compactionParts({ compaction: true, messages: history })).toEqual({ betas: [ON_DEMAND_BETA] })
    expect(compactionParts({ compaction: false, messages: history })).toEqual({ betas: [ON_DEMAND_BETA] })
  })

  it('starts the request at the newest on-demand summary', () => {
    const history = [user('a'), { role: 'assistant', content: 'A.' } as BetaMessageParam, user('b'), summaryOnly, user('c')]
    expect(historyStart(history)).toBe(3)
    expect(requestMessages(history)).toEqual([summaryOnly, user('c')])
    const plain = [user('a')]
    expect(requestMessages(plain)).toBe(plain)
  })

  it('skips models without compaction', () => {
    expect(supportsCompaction('claude-opus-5-5')).toBe(true)
    expect(supportsCompaction('claude-sonnet-5-5')).toBe(true)
    expect(supportsCompaction('claude-haiku-4-5')).toBe(false)
    expect(supportsCompaction('claude-unknown')).toBe(false)
  })
})

const usage = (extra: Record<string, unknown> = {}) => ({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, ...extra }) as BetaMessage['usage']
const message = (content: unknown[], stop: string, extra: Record<string, unknown> = {}): BetaMessage => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, usage: usage(extra) }) as unknown as BetaMessage

describe('the streamed compaction card', () => {
  it('runs at the block start and is done with the summary and the closed context’s size', () => {
    const watch = new CompactionWatch(1234)
    const start = watch.onEvent({ type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: null } } as unknown as BetaRawMessageStreamEvent)
    expect(start).toMatchObject({ type: 'compaction', state: 'running', trigger: 'auto' })
    expect(watch.onEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'x' } } as BetaRawMessageStreamEvent)).toBeNull()
    const iterations = [
      { type: 'message', input_tokens: 150_000, output_tokens: 10, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
      { type: 'compaction', input_tokens: 152_000, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ]
    const [done] = watch.finish(message([{ type: 'compaction', content: 'The summary.' }, { type: 'text', text: 'Go on.' }], 'end_turn', { iterations }))
    expect(done).toEqual({ type: 'compaction', id: (start as Extract<AgentEvent, { type: 'compaction' }>).id, state: 'done', trigger: 'auto', summary: 'The summary.', thresholdTokens: 150_000, replacedTokens: 152_010 })
  })

  it('fails when the block came back without a summary', () => {
    const [failed] = new CompactionWatch(null).finish(message([{ type: 'compaction', content: null }], 'end_turn'))
    expect(failed).toMatchObject({ type: 'compaction', state: 'failed' })
  })

  it('uses the previous turn’s input when usage has no iterations', () => {
    expect(replacedTokens(usage(), 4321)).toBe(4321)
    expect(replacedTokens(null, null)).toBeNull()
  })
})

describe('manual outcomes', () => {
  it('reads the summary or a plain reason', () => {
    expect(manualOutcome(message([{ type: 'compaction', content: 'S.' }], 'compaction'))).toEqual({ ok: true, summary: 'S.' })
    expect(manualOutcome(message([], 'max_tokens'))).toMatchObject({ ok: false, reason: expect.stringContaining('cut off') })
    expect(manualOutcome(message([], 'refusal'))).toMatchObject({ ok: false, reason: expect.stringContaining('declined') })
    expect(manualOutcome(message([{ type: 'compaction', content: null }], 'compaction'))).toMatchObject({ ok: false })
  })

  it('recognizes a context that no longer fits', () => {
    expect(isContextTooLong(new Error('prompt is too long: 1000001 tokens > 1000000 maximum'))).toBe(true)
    expect(isContextTooLong(new Error('rate limited'))).toBe(false)
  })
})

// ---- end to end ----

const presets: CompanionPreset[] = [{ id: 'nova', name: 'Nova', tagline: '', personality: 'Curious.', look: DEFAULT_LOOK }]

function setup(model = 'claude-opus-5-5') {
  const dir = mkdtempSync(join(tmpdir(), 'apex-compact-'))
  const chats = new ChatStore(dir, FIRST_COMPANION_ID)
  const events: ChatAgentEvent[] = []
  const smoke = createSmokeClient()
  const tabs = { find: () => undefined, active: () => null, activeId: () => null, rail: () => null, activate: () => undefined, all: () => [], info: () => ({ title: '', url: '' }), setAgentControlled: () => undefined, setNeedsInput: () => undefined } as unknown as TabManager
  const host = new AgentHost({
    settings: { get: () => ({ model, effort: 'medium', webTools: false, memory: false, confirmConsequentialActions: true, documents: false }), view: () => ({ hasApiKey: true }), apiKey: () => 'test-key' },
    tabs,
    bridge: {} as never,
    memory: { execute: async () => 'ok' },
    connectors: new ConnectorStore(dir),
    skills: new SkillStore(dir),
    chats,
    companions: new CompanionStore(dir, { presets: () => presets }),
    presets: { personality: () => undefined },
    client: smoke.client,
    emit: (event) => events.push(event),
    onTabOwners: () => undefined,
    onQueue: () => undefined,
  })
  const eventsOf = (id: string): AgentEvent[] => events.filter((e) => e.chatId === id).map((e) => e.event)
  const idle = (id: string) => until(() => !host.isRunning(id))
  return { host, chats, eventsOf, idle }
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('Timed out')
}

const compactions = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: 'compaction' }> => e.type === 'compaction')

describe('compaction in a chat', () => {
  it('keeps the compaction block in the history and replays it on the next request', async () => {
    smokeRichChat.reset()
    const t = setup()
    const id = t.host.start('hello')
    await t.idle(id)
    expect(smokeRichChat.lastRequest?.betas).toContain(THRESHOLD_BETA)
    expect(smokeRichChat.lastRequest?.context_management).toEqual({ edits: [{ type: 'compact_20260112' }] })

    t.host.send(id, 'smoke:compaction please')
    await t.idle(id)
    const cards = compactions(t.eventsOf(id))
    expect(cards.map((c) => c.state)).toEqual(['running', 'done'])
    expect(cards[1]).toMatchObject({ summary: 'Earlier, the smoke test chatted about picnics and laptops.', trigger: 'auto' })
    expect(cards[0]?.id).toBe(cards[1]?.id)

    // Saved verbatim (append-only), and sent back as it was.
    const saved = t.chats.load(id).messages
    const assistant = saved.filter((m) => m.role === 'assistant').at(-1)
    expect((assistant?.content as Array<{ type: string }>).map((b) => b.type)).toEqual(['compaction', 'text'])
    t.host.send(id, 'and now?')
    await t.idle(id)
    const replayed = smokeRichChat.lastRequest?.messages.find((m) => m.role === 'assistant' && Array.isArray(m.content) && (m.content as Array<{ type: string }>)[0]?.type === 'compaction')
    expect(replayed?.content).toEqual(assistant?.content)
  })

  it('compacts by hand: the summary comes back alone and later requests start from it', async () => {
    smokeRichChat.reset()
    const t = setup()
    const id = t.host.start('first question')
    await t.idle(id)
    t.host.send(id, 'second question')
    await t.idle(id)

    t.host.compact(id)
    await until(() => compactions(t.eventsOf(id)).some((c) => c.state !== 'running'))
    await t.idle(id)
    expect(smokeRichChat.lastRequest?.compaction).toMatchObject({ type: 'summarize' })
    expect(smokeRichChat.lastRequest?.betas).toContain(ON_DEMAND_BETA)
    const manual = compactions(t.eventsOf(id)).filter((c) => c.trigger === 'manual')
    expect(manual.map((c) => c.state)).toEqual(['running', 'done'])
    expect(manual[1]?.summary).toMatch(/Summary of the chat so far/)

    t.host.send(id, 'third question')
    await t.idle(id)
    const sent = smokeRichChat.lastRequest?.messages ?? []
    expect((sent[0]?.content as Array<{ type: string }>)[0]?.type).toBe('compaction')
    expect(JSON.stringify(sent)).not.toContain('first question')
    // The whole history is still saved.
    expect(JSON.stringify(t.chats.load(id).messages)).toContain('first question')
  })

  it('sends no compaction on models without it', async () => {
    smokeRichChat.reset()
    const t = setup('claude-haiku-4-5')
    const id = t.host.start('hello')
    await t.idle(id)
    expect(smokeRichChat.lastRequest?.betas ?? []).not.toContain(THRESHOLD_BETA)
    expect(smokeRichChat.lastRequest?.context_management).toBeUndefined()
  })
})
