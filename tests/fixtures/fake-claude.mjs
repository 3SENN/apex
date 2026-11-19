#!/usr/bin/env node
/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
// A stand-in for the `claude` CLI that speaks its headless stream-json
// protocol, for the Claude subscription engine tests. It never contacts anything but
// Atelier's own local MCP server. What it does depends on the message text:
//   crash      exits with an error on stderr
//   signedout  answers like a CLI that isn't signed in
//   ratelimit  reports the account limit, then fails
//   slow       starts a reply and waits to be interrupted (deaf: ignores interrupts)
//   tool:<name>:<json>  calls Atelier's MCP tool, then reports its result
//   context    says whether an earlier-conversation block came with the message
//   tooold     fails like a CLI too old for the model (tests/fixtures/claude-version-too-old.json)
//   overloaded fails with the API's overloaded error
//   anything else  streams a short reply with thinking
// FAKE_CLAUDE_LOG gets one JSON line per launch (argv, cwd, chosen env vars).
// --version reads FAKE_CLAUDE_VERSION_FILE (else 9.9.9); `update` writes
// FAKE_CLAUDE_UPDATE_TO there, or with FAKE_CLAUDE_UPDATE=npm says to use npm.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const log = process.env.FAKE_CLAUDE_LOG
const out = (object) => process.stdout.write(`${JSON.stringify(object)}\n`)

const versionFile = process.env.FAKE_CLAUDE_VERSION_FILE
if (args[0] === '--version') {
  const version = versionFile && existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '9.9.9'
  process.stdout.write(`${version} (Claude Code)\n`)
  process.exit(0)
}
if (args[0] === 'update') {
  if (log) appendFileSync(log, `${JSON.stringify({ update: args, autoupdater: process.env.DISABLE_AUTOUPDATER ?? null })}\n`)
  if (process.env.FAKE_CLAUDE_UPDATE === 'npm') {
    process.stdout.write('Current version: 2.1.50\nClaude Code was installed with npm. To update, run: npm i -g @anthropic-ai/claude-code\n')
    process.exit(1)
  }
  const to = process.env.FAKE_CLAUDE_UPDATE_TO ?? '9.9.10'
  process.stdout.write('Current version: 2.1.50\nChecking for updates...\n')
  if (versionFile) writeFileSync(versionFile, to)
  process.stdout.write(`Successfully updated from 2.1.50 to version ${to}\n`)
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  const mode = process.env.FAKE_CLAUDE_AUTH ?? 'in'
  if (mode === 'old') {
    process.stderr.write("error: unknown command 'auth'\n")
    process.exit(1)
  }
  if (mode === 'hang') setTimeout(() => process.exit(0), 60_000)
  else {
    out(mode === 'in' ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' } : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' })
    process.exit(mode === 'in' ? 0 : 1)
  }
}
if (args[0] === 'mcp') {
  if (log) appendFileSync(log, `${JSON.stringify({ mcp: args })}\n`)
  if (args[1] === 'add' && process.env.FAKE_CLAUDE_MCP === 'exists') {
    process.stderr.write('MCP server atelier already exists in user config\n')
    process.exit(1)
  }
  process.exit(0)
}

const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
if (log) {
  const env = Object.fromEntries(['CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DISABLE_AUTOUPDATER', 'KEEP_ME'].map((k) => [k, process.env[k] ?? null]))
  appendFileSync(log, `${JSON.stringify({ args, cwd: process.cwd(), env })}\n`)
}
const resume = flag('--resume')
if (resume === '00000000-dead-0000-0000-000000000000') {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`)
  process.exit(1)
}
const sessionId = resume && !args.includes('--fork-session') ? resume : randomUUID()
const model = flag('--model') ?? 'claude-test'
const mcpConfig = flag('--mcp-config') ? JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')) : null
let n = 0

async function callAtelier(method, params) {
  const server = mcpConfig?.mcpServers?.atelier
  const response = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...server.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) })
  return response.json()
}

function stream(id, parts, usage = { input_tokens: 12, cache_read_input_tokens: 4, cache_creation_input_tokens: 0, output_tokens: 1 }) {
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, model, usage } }, session_id: sessionId, parent_tool_use_id: null })
  for (const [kind, text] of parts) {
    const delta = kind === 'thinking' ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text }
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta }, session_id: sessionId, parent_tool_use_id: null })
  }
}

function finish(id, stopReason = 'end_turn') {
  out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 7 } }, session_id: sessionId, parent_tool_use_id: null })
  out({ type: 'stream_event', event: { type: 'message_stop' }, session_id: sessionId, parent_tool_use_id: null })
}

function result(text, extra = {}) {
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, num_turns: 1, total_cost_usd: 0.0123, usage: { input_tokens: 12, output_tokens: 7 }, ...extra })
}

let busy = false
const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } })
    if (busy && process.env.FAKE_CLAUDE_DEAF !== '1') {
      busy = false
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId, num_turns: 1 })
    }
    return
  }
  if (message.type !== 'user') return
  const blocks = message.message.content
  const text = blocks.at(-1).text
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, tools: [], mcp_servers: mcpConfig ? [{ name: 'atelier', status: 'connected' }] : [] })
  if (text.includes('crash')) {
    process.stderr.write('boom: something broke\n')
    process.exit(3)
  }
  if (text.includes('signedout')) {
    out({ type: 'assistant', message: { id: 'msg_x', model, content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] }, session_id: sessionId, parent_tool_use_id: null })
    return result('Invalid API key · Please run /login', { subtype: 'success', is_error: true })
  }
  if (text.includes('tooold')) {
    const fixture = JSON.parse(readFileSync(new URL('./claude-version-too-old.json', import.meta.url), 'utf8'))
    out({ type: 'assistant', message: { id: 'msg_err', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: fixture.text }] }, session_id: sessionId, parent_tool_use_id: null, error: 'invalid_request' })
    return result(fixture.text, { is_error: true })
  }
  if (text.includes('overloaded')) {
    const text529 = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    out({ type: 'assistant', message: { id: 'msg_err', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: text529 }] }, session_id: sessionId, parent_tool_use_id: null, error: 'overloaded' })
    return result(text529, { is_error: true })
  }
  if (text.includes('ratelimit')) {
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' }, session_id: sessionId })
    return result('Claude usage limit reached.', { is_error: true })
  }
  if (text.includes('slow')) {
    busy = true
    stream('msg_slow', [['text', 'Working']])
    return
  }
  if (text.startsWith('tool:')) {
    const [, name, json] = /^tool:([a-z_]+):(.*)$/s.exec(text)
    stream('msg_t1', [['text', 'Let me do that.']])
    out({ type: 'assistant', message: { id: 'msg_t1', model, content: [{ type: 'text', text: 'Let me do that.' }, { type: 'tool_use', id: 'toolu_1', name: `mcp__atelier__${name}`, input: JSON.parse(json) }] }, session_id: sessionId, parent_tool_use_id: null })
    finish('msg_t1', 'tool_use')
    const listed = await callAtelier('tools/list', {})
    const reply = await callAtelier('tools/call', { name, arguments: JSON.parse(json) })
    const content = reply.result?.content ?? [{ type: 'text', text: JSON.stringify(reply.error) }]
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: reply.result?.isError === true, content }] }, session_id: sessionId, parent_tool_use_id: null })
    const summary = `tools=${listed.result.tools.length} result=${content.map((c) => c.text ?? c.type).join(' ')}`
    stream('msg_t2', [['text', summary]])
    finish('msg_t2')
    return result(summary)
  }
  if (text.includes('context')) {
    const earlier = blocks.some((b) => b.text.startsWith('<earlier_conversation>'))
    stream('msg_c', [['text', `context:${earlier ? 'yes' : 'no'}`]])
    finish('msg_c')
    return result(`context:${earlier ? 'yes' : 'no'}`)
  }
  const id = `msg_${randomUUID().slice(0, 8)}`
  stream(id, [['thinking', 'Considering.'], ['text', 'Hello '], ['text', 'there.']])
  // The finished message repeats the text; Atelier must not show it twice.
  out({ type: 'assistant', message: { id, model, content: [{ type: 'thinking', thinking: 'Considering.' }, { type: 'text', text: 'Hello there.' }] }, session_id: sessionId, parent_tool_use_id: null })
  finish(id)
  result('Hello there.')
})
rl.on('close', () => process.exit(0))
