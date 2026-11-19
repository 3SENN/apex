/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyClaudeCodeFailure, claudeCodeErrorCode, cliFailureKind, parseCliApiError, tooOldFacts, type CliFailure } from '../src/engines/claude-code/main/errors'
import { StreamJsonReader } from '../src/engines/claude-code/main/streamJson'
import { errorCard, detailsText } from '../src/renderer/src/chat/logic/errors'
import { modelName } from '@shared/chatErrors'

// Claude Code's API errors as Atelier's own cards. The fixture is what Claude
// Code 2.1.50 wrote when the API refused a model it was too old for.

const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/claude-version-too-old.json'), 'utf8')) as { text: string }
const failure = (patch: Partial<CliFailure>): CliFailure => ({ text: '', model: 'claude-opus-5-5', version: '2.1.50', ...patch })

describe('reading the CLI’s API error', () => {
  it('pulls status, type, message and error_code out of "API Error: 400 {…}"', () => {
    expect(parseCliApiError(fixture.text)).toEqual({
      status: 400,
      type: 'invalid_request_error',
      message: "Claude Code 2.1.50 does not support this model; version 2.1.280 or newer is required. Run 'claude update' to update.",
      errorCode: 'claude_code_version_too_old',
    })
    expect(parseCliApiError('API Error: Request timed out.')).toEqual({ status: null, type: null, message: 'Request timed out.', errorCode: null })
    expect(parseCliApiError('Hello there.')).toBeNull()
  })

  it('reads the versions in the CLI’s words, and the organization floor', () => {
    expect(tooOldFacts(fixture.text)).toEqual({ version: '2.1.50', required: '2.1.280', policy: false })
    expect(tooOldFacts('Claude Code 2.1.50 is older than the minimum version required by your organization’s policy')).toEqual({ version: '2.1.50', required: null, policy: true })
    expect(tooOldFacts('something else')).toBeNull()
  })
})

describe('mapping to chat errors', () => {
  it('names the bridge’s own failures by their words', () => {
    expect(claudeCodeErrorCode('Claude Code isn’t signed in. Open Settings')).toBe('cc-signed-out')
    expect(claudeCodeErrorCode('Your Claude account has reached its limit for now.')).toBe('cc-limit')
    expect(claudeCodeErrorCode('Claude Code isn’t on this computer yet.')).toBe('cc-missing')
    expect(claudeCodeErrorCode('Claude Code isn’t on this Mac yet.')).toBe('cc-missing')
    expect(errorCard('cc-signed-out').action).toBe('engine')
  })


  it('version too old: a cc-too-old card, the JSON only in Details', () => {
    const error = classifyClaudeCodeFailure(failure({ text: fixture.text, kind: 'invalid_request' }))
    expect(error.code).toBe('cc-too-old')
    expect(error.message).toBe('Your Claude Code (2.1.50) is too old for Opus 5.5. It needs 2.1.280 or newer.')
    expect(error.message).not.toContain('{')
    expect(error.facts).toEqual({ model: 'claude-opus-5-5', version: '2.1.50', required: '2.1.280' })
    expect(error.details).toBe(fixture.text)
  })

  it('knows it is too old from the typed error code alone, with the version Atelier read', () => {
    const error = classifyClaudeCodeFailure(failure({ text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Update required.","details":{"error_code":"claude_code_version_too_old"}}}', version: '2.1.60' }))
    expect(error).toMatchObject({ code: 'cc-too-old', facts: { version: '2.1.60', model: 'claude-opus-5-5' } })
    expect(error.facts?.required).toBeUndefined()
    expect(classifyClaudeCodeFailure(failure({ text: 'Refused.', apiError: 'claude_code_version_too_old' })).code).toBe('cc-too-old')
    expect(classifyClaudeCodeFailure(failure({ text: 'Claude Code 2.1.50 is older than the minimum version required by your organization\'s policy' })).facts).toMatchObject({ policy: true })
  })

  it('the other common failures: sign-in, limits, credit, overload, model, length, outage', () => {
    const code = (patch: Partial<CliFailure>): string => classifyClaudeCodeFailure(failure(patch)).code
    expect(code({ text: 'Invalid API key · Please run /login', kind: 'authentication_failed' })).toBe('cc-signed-out')
    expect(code({ text: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}' })).toBe('cc-signed-out')
    expect(code({ text: 'Claude usage limit reached.', limited: true })).toBe('cc-limit')
    expect(code({ text: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit."}}', kind: 'rate_limit' })).toBe('cc-limit')
    expect(code({ text: 'Credit balance is too low', kind: 'billing_error' })).toBe('quota')
    expect(code({ text: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', kind: 'overloaded' })).toBe('overloaded')
    expect(code({ text: 'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-5-5"}}', kind: 'model_not_found' })).toBe('cc-model')
    expect(code({ text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}' })).toBe('too-long')
    expect(code({ text: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}', kind: 'server_error' })).toBe('unavailable')
    expect(code({ text: 'Something odd happened' })).toBe('other')
  })

  it('an overload retries by itself; a model error names the model; a request id is never read as a 429', () => {
    expect(classifyClaudeCodeFailure(failure({ text: 'Overloaded', kind: 'overloaded' })).retryAfterMs).toBeGreaterThan(0)
    expect(classifyClaudeCodeFailure(failure({ text: 'model not found', kind: 'model_not_found', model: 'claude-fable-5-1' })).message).toContain('Fable 5.1')
    expect(cliFailureKind(failure({ text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"},"request_id":"req_4290"}' })).kind).toBe('other')
  })

  it('an unknown failure shows the API’s message, not its JSON', () => {
    const error = classifyClaudeCodeFailure(failure({ text: 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"tools.0: bad schema"}}' }))
    expect(error.code).toBe('other')
    expect(error.message).toBe('Claude Code couldn’t finish this reply: tools.0: bad schema')
    expect(error.details).toContain('"invalid_request_error"')
  })
})

describe('the stream-json lines', () => {
  it('turns the CLI’s error message into an api-error event, never reply text, and fails the result', () => {
    const reader = new StreamJsonReader()
    const error = reader.read(JSON.stringify({ type: 'assistant', message: { id: 'msg_err', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: fixture.text }] }, parent_tool_use_id: null, error: 'invalid_request', session_id: 's' }))
    expect(error).toEqual([{ kind: 'api-error', messageId: 'msg_err', text: fixture.text, error: 'invalid_request', apiError: null, status: null }])
    const [result] = reader.read(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: fixture.text, session_id: 's', num_turns: 1 }))
    expect(result).toMatchObject({ kind: 'result', ok: false, text: fixture.text })
  })

  it('reads newer CLIs’ typed cause, and an older CLI’s synthetic message without one', () => {
    const reader = new StreamJsonReader()
    const typed = reader.read(JSON.stringify({ type: 'assistant', message: { id: 'm1', model: '<synthetic>', content: [{ type: 'text', text: fixture.text }] }, is_api_error_message: true, api_error: 'claude_code_version_too_old', api_error_status: 400, parent_tool_use_id: null }))
    expect(typed[0]).toMatchObject({ kind: 'api-error', apiError: 'claude_code_version_too_old', status: 400 })
    const old = reader.read(JSON.stringify({ type: 'assistant', message: { id: 'm2', model: '<synthetic>', content: [{ type: 'text', text: fixture.text }] }, parent_tool_use_id: null }))
    expect(old[0]?.kind).toBe('api-error')
  })

  it('leaves a model’s own words alone, even when they mention an API error', () => {
    const reader = new StreamJsonReader()
    const reply = reader.read(JSON.stringify({ type: 'assistant', message: { id: 'm3', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'An API Error: 400 means a bad request.' }] }, parent_tool_use_id: null }))
    expect(reply[0]).toMatchObject({ kind: 'text', text: 'An API Error: 400 means a bad request.' })
  })
})

describe('the card', () => {
  it('fills "too old" with the versions and the model, and offers Update and Use another model', () => {
    const card = errorCard('cc-too-old', 'x', { version: '2.1.50', required: '2.1.280', model: 'claude-opus-5-5' })
    expect(card).toMatchObject({ title: 'engines.chat.error.ccTooOld.title', body: 'engines.chat.error.ccTooOld.body', bodyVars: { version: '2.1.50', required: '2.1.280', model: 'Opus 5.5' }, action: 'engine-step', secondary: 'pick-model' })
    expect(errorCard('cc-too-old', 'x', { version: '2.1.50', policy: true }).body).toBe('engines.chat.error.ccTooOld.bodyPolicy')
    // No facts (an older log): the saved message shows.
    expect(errorCard('cc-too-old', 'Your Claude Code is too old.').body).toBeNull()
    expect(errorCard('cc-model', 'x', { model: 'claude-haiku-5-5' })).toMatchObject({ action: 'pick-model', bodyVars: { model: 'Haiku 5.5' } })
  })

  it('keeps the raw text for Details, trimmed', () => {
    expect(detailsText(`\n${fixture.text}\n\n\n\n`)).toBe(fixture.text)
    expect(detailsText('  ')).toBeNull()
    expect(detailsText(undefined)).toBeNull()
  })

  it('names models the way the picker does', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
    expect(modelName('claude-sonnet-5-5-20260101')).toBe('Sonnet 5.5')
    expect(modelName('custom-model')).toBe('custom-model')
  })
})
