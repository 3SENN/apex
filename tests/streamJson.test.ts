/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest'
import { interruptLine, resultText, StreamJsonReader, userLine, usageOf } from '../src/engines/claude-code/main/streamJson'
import { transcriptOf } from '../src/main/engines/backend'
import { mcpServers, toolLabel } from '../src/engines/claude-code/main/claudeCode'

// Reading Claude Code's stream-json lines into what an Atelier chat shows.

const line = (object: unknown): string => JSON.stringify(object)
const delta = (d: unknown): string => line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: d }, parent_tool_use_id: null })

describe('StreamJsonReader', () => {
  it('reads the session id, model and Atelier server status from init', () => {
    const reader = new StreamJsonReader()
    expect(reader.read(line({ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5', tools: ['mcp__atelier__navigate'], mcp_servers: [{ name: 'atelier', status: 'connected' }] }))).toEqual([
      { kind: 'init', sessionId: 's-1', model: 'claude-opus-5-5', tools: ['mcp__atelier__navigate'], mcpServers: [{ name: 'atelier', status: 'connected' }] },
    ])
  })

  it('streams text and thinking once, and pairs usage with the message', () => {
    const reader = new StreamJsonReader()
    const events = [
      line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', model: 'claude-x', usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 1 } } } }),
      delta({ type: 'thinking_delta', thinking: 'Hmm.' }),
      delta({ type: 'text_delta', text: 'Hi ' }),
      delta({ type: 'text_delta', text: 'you.' }),
      delta({ type: 'input_json_delta', partial_json: '{' }),
      line({ type: 'assistant', message: { id: 'm1', model: 'claude-x', content: [{ type: 'thinking', thinking: 'Hmm.' }, { type: 'text', text: 'Hi you.' }] } }),
      line({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } } }),
      line({ type: 'stream_event', event: { type: 'message_stop' } }),
    ].flatMap((l) => reader.read(l))
    expect(events).toEqual([
      { kind: 'thinking', messageId: 'm1', text: 'Hmm.' },
      { kind: 'text', messageId: 'm1', text: 'Hi ' },
      { kind: 'text', messageId: 'm1', text: 'you.' },
      { kind: 'usage', messageId: 'm1', model: 'claude-x', usage: { inputTokens: 10, outputTokens: 9, cacheReadTokens: 3, cacheWriteTokens: 0 }, stopReason: 'end_turn' },
    ])
  })

  it('falls back to finished messages when nothing streamed', () => {
    const reader = new StreamJsonReader()
    expect(reader.read(line({ type: 'assistant', message: { id: 'm2', model: 'claude-x', stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 2 }, content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'mcp__atelier__find', input: { query: 'Sign in' } }] } }))).toEqual([
      { kind: 'text', messageId: 'm2', text: 'Looking.' },
      { kind: 'tool-use', id: 't1', name: 'mcp__atelier__find', input: { query: 'Sign in' }, messageId: 'm2' },
      { kind: 'usage', messageId: 'm2', model: 'claude-x', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, stopReason: 'tool_use' },
    ])
  })

  it('reads tool results, results, rate limits, compaction and control responses', () => {
    const reader = new StreamJsonReader()
    expect(reader.read(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'Declined' }, { type: 'image' }] }] } }))).toEqual([{ kind: 'tool-result', id: 't1', isError: true, text: 'Declined\n[image]' }])
    expect(reader.read(line({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's', total_cost_usd: 0.5, num_turns: 3, usage: { input_tokens: 1, output_tokens: 2 } }))).toEqual([
      { kind: 'result', ok: true, subtype: 'success', text: 'Done.', sessionId: 's', costUsd: 0.5, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, numTurns: 3, errors: [] },
    ])
    expect(reader.read(line({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many'] }))[0]).toMatchObject({ ok: false, subtype: 'error_max_turns', errors: ['too many'] })
    expect(reader.read(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000, rateLimitType: 'five_hour' } }))).toEqual([{ kind: 'rate-limit', status: 'limited', resetsAt: 1_800_000_000_000, limitType: 'five_hour' }])
    expect(reader.read(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } }))[0]).toMatchObject({ status: 'warning', resetsAt: null })
    expect(reader.read(line({ type: 'system', subtype: 'status', status: 'compacting' }))).toEqual([{ kind: 'compacting', active: true }])
    expect(reader.read(line({ type: 'control_response', response: { subtype: 'success', request_id: 'r1' } }))).toEqual([{ kind: 'control-response', requestId: 'r1', ok: true, error: null }])
  })

  it('ignores sub-agent traffic, unknown events and broken lines', () => {
    const reader = new StreamJsonReader()
    expect(reader.read(line({ type: 'assistant', parent_tool_use_id: 'toolu_9', message: { id: 'm', content: [{ type: 'text', text: 'nested' }] } }))).toEqual([])
    expect(reader.read(line({ type: 'keep_alive' }))).toEqual([])
    expect(reader.read('{not json')).toEqual([])
    expect(reader.read('   ')).toEqual([])
    expect(reader.read('[1,2]')).toEqual([])
  })
})

describe('protocol helpers', () => {
  it('writes user messages and interrupts as single lines', () => {
    expect(userLine([{ type: 'text', text: 'a\nb' }])).toBe('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"a\\nb"}]}}\n')
    expect(JSON.parse(interruptLine('r1'))).toEqual({ type: 'control_request', request_id: 'r1', request: { subtype: 'interrupt' } })
  })

  it('reads usage and result text defensively', () => {
    expect(usageOf(null)).toBeNull()
    expect(usageOf({ input_tokens: 'x', output_tokens: 3 })).toEqual({ inputTokens: 0, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 })
    expect(resultText('plain')).toBe('plain')
    expect(resultText(42)).toBe('')
  })

  it('labels tool rows like the API-key engine does', () => {
    expect(toolLabel('mcp__atelier__navigate', { url: 'https://example.com' })).toBe('Open https://example.com')
    expect(toolLabel('mcp__atelier__memory', { command: 'create', path: '/memories/notes.md' })).toBe('Save to memory notes.md')
    expect(toolLabel('WebSearch', { query: 'weather' })).toBe('Search the web for "weather"')
    expect(toolLabel('mcp__other__do_thing', {})).toBe('Use do thing')
  })

  it('adds each connector as its own MCP server, never under Atelier’s name', () => {
    const servers = mcpServers({ url: 'http://127.0.0.1:1/mcp/chat/x', token: 't' }, [
      { id: '1', name: 'Linear Tasks', url: 'https://mcp.linear.example/mcp', token: 'secret' },
      { id: '2', name: 'atelier', url: 'https://other.example/mcp', token: null },
      { id: '3', name: 'linear tasks', url: 'https://second.example/mcp', token: null },
    ])
    expect(Object.keys(servers)).toEqual(['atelier', 'linear-tasks', 'atelier-connector', 'linear-tasks-2'])
    expect(servers['linear-tasks']).toEqual({ type: 'http', url: 'https://mcp.linear.example/mcp', headers: { Authorization: 'Bearer secret' } })
    expect(servers['atelier-connector']).toEqual({ type: 'http', url: 'https://other.example/mcp' })
  })

  it('turns earlier messages into a transcript without the browser context', () => {
    expect(transcriptOf([])).toBeNull()
    const text = transcriptOf([
      { role: 'user', content: [{ type: 'text', text: '<browser_context>tab</browser_context>' }, { type: 'text', text: 'Find flights' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Found three.' }] },
    ])
    expect(text).toContain('User: Find flights')
    expect(text).toContain('Assistant: Found three.')
    expect(text).not.toContain('browser_context>tab')
    expect(transcriptOf([{ role: 'user', content: 'x'.repeat(100) }], 20)?.length).toBeLessThan(300)
  })
})
