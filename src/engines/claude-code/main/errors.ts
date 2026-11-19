/* Copyright (c) 2026 The Atelier Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ERROR_DETAILS_MAX, modelName, type ChatError, type ChatErrorCode, type ChatErrorFacts } from '@shared/chatErrors'
import { DEFAULT_RETRY_MS } from '../../../../src/main/agent/errors'
import { mainT } from '../../../../src/main/i18n/mainT'
import { looksSignedOut } from './cli'

// Claude Code's failures as chat errors (SS-03): the bridge's own wording, and
// the API errors the CLI reports in its stream-json result and error messages.

/** Claude Code's own failures, from the bridge's wording (see engines/claudeCode.ts MESSAGES). */
export function claudeCodeErrorCode(message: string): ChatErrorCode {
  if (/isn’t signed in|not signed in|sign in/i.test(message)) return 'cc-signed-out'
  if (/reached its limit|limit for now|rate.?limit/i.test(message)) return 'cc-limit'
  if (/isn’t on this (?:Mac|computer)|doesn’t include/i.test(message)) return 'cc-missing'
  if (/no credit/i.test(message)) return 'quota'
  return 'other'
}

// ---- Claude Code's API errors (the CLI's stream-json result and error messages) ----

/** What an "API Error: 400 {…}" text holds. */
export interface CliApiError {
  status: number | null
  /** The API's error type, e.g. 'invalid_request_error'. */
  type: string | null
  /** The API's own message. */
  message: string | null
  /** details.error_code, e.g. 'claude_code_version_too_old'. */
  errorCode: string | null
}

/**
 * Reads the API error the CLI wraps in text: `API Error: 400 {"type":"error",
 * "error":{"type":…,"message":…,"details":{"error_code":…}}}`. Null when the
 * text has no "API Error" in it.
 */
export function parseCliApiError(text: string): CliApiError | null {
  const at = text.search(/API Error\b/i)
  if (at < 0) return null
  const rest = text.slice(at)
  const status = /^API Error(?:\s*\([^)]*\))?:?\s*(\d{3})\b/i.exec(rest)?.[1]
  const out: CliApiError = { status: status ? Number(status) : null, type: null, message: null, errorCode: null }
  const start = rest.indexOf('{')
  const end = rest.lastIndexOf('}')
  if (start < 0 || end <= start) {
    out.message = rest.replace(/^API Error(?:\s*\([^)]*\))?:?\s*(\d{3})?\s*/i, '').trim() || null
    return out
  }
  try {
    const body: unknown = JSON.parse(rest.slice(start, end + 1))
    const error = isRecord(body) ? (isRecord(body.error) ? body.error : body) : {}
    const details = isRecord(error.details) ? error.details : {}
    out.type = typeof error.type === 'string' ? error.type : null
    out.message = typeof error.message === 'string' ? error.message : null
    out.errorCode = typeof details.error_code === 'string' ? details.error_code : typeof error.error_code === 'string' ? error.error_code : null
  } catch {
    out.message = rest.slice(start, end + 1)
  }
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const TOO_OLD = /\bClaude Code (\S+) does not support this model; version (\S+?)\.? or newer is required/i
const POLICY_FLOOR = /\bClaude Code (\S+) is older than the minimum version required by your organization['’]s policy/i

/** The CLI's own words for "too old": its version and the one needed, when the text names them. */
export function tooOldFacts(text: string): { version: string | null; required: string | null; policy: boolean } | null {
  const model = TOO_OLD.exec(text)
  if (model) return { version: model[1] ?? null, required: model[2] ?? null, policy: false }
  const policy = POLICY_FLOOR.exec(text)
  if (policy) return { version: policy[1] ?? null, required: null, policy: true }
  return null
}

export interface CliFailure {
  /** The failure in the CLI's words: the result's text and errors, or its API error message. */
  text: string
  /** The error kind on the CLI's error message (`assistant.error`): 'authentication_failed', 'rate_limit', 'invalid_request', … */
  kind?: string | null
  /** Newer CLIs' typed cause (`api_error`), e.g. 'claude_code_version_too_old'. */
  apiError?: string | null
  /** The API's HTTP status, when the CLI reported one. */
  status?: number | null
  /** Claude Code said the account is at its limit (a rate_limit_event). */
  limited?: boolean
  resetsAt?: number | null
  /** The chat's model id. */
  model: string
  /** The CLI's version as Atelier read it. */
  version: string | null
}

export type CliFailureKind = 'too-old' | 'signed-out' | 'limit' | 'credit' | 'overloaded' | 'model' | 'unavailable' | 'too-long' | 'other'

const AUTH = /authentication_error|invalid api key|invalid x-api-key|oauth token (?:has )?(?:expired|revoked)|please run \/login|not logged in|not signed in|login required/i
const LIMIT = /rate.?limit|usage limit|limit reached|hit your limit/i
const CREDIT = /credit balance|insufficient.?credit|billing_error/i
const MODEL = /model.{0,40}(?:not found|not available|isn['’]t available|invalid|not supported)|invalid model|model_not_found|unknown model/i

/** Which failure it is, from the CLI's typed fields first and its words after. */
export function cliFailureKind(failure: CliFailure): { kind: CliFailureKind; api: CliApiError | null } {
  const api = parseCliApiError(failure.text)
  const status = failure.status ?? api?.status ?? null
  const words = `${failure.text} ${api?.message ?? ''}`
  const code = failure.apiError ?? api?.errorCode ?? null
  if (code === 'claude_code_version_too_old' || tooOldFacts(words)) return { kind: 'too-old', api }
  if (failure.kind === 'authentication_failed' || status === 401 || api?.type === 'authentication_error' || AUTH.test(words) || looksSignedOut(words)) return { kind: 'signed-out', api }
  if (failure.kind === 'billing_error' || CREDIT.test(words)) return { kind: 'credit', api }
  if (failure.limited || failure.kind === 'rate_limit' || status === 429 || api?.type === 'rate_limit_error' || code === 'usage_limit_reached' || LIMIT.test(words)) return { kind: 'limit', api }
  if (failure.kind === 'overloaded' || status === 529 || api?.type === 'overloaded_error' || /overloaded/i.test(words)) return { kind: 'overloaded', api }
  if (failure.kind === 'model_not_found' || (status === 404 && /model/i.test(words)) || (api?.type === 'not_found_error' && /model/i.test(words)) || MODEL.test(words)) return { kind: 'model', api }
  if (/prompt is too long|context.{0,20}(?:window|length)|maximum context/i.test(words)) return { kind: 'too-long', api }
  if (failure.kind === 'server_error' || (status !== null && status >= 500) || api?.type === 'api_error') return { kind: 'unavailable', api }
  return { kind: 'other', api }
}

/**
 * A Claude Code failure as a chat error: what happened in Atelier's words, the
 * code for its card, the facts the card fills in, and the CLI's raw text kept
 * for Details only, so no JSON reaches the chat.
 */
export function classifyClaudeCodeFailure(failure: CliFailure): ChatError {
  const { kind, api } = cliFailureKind(failure)
  const raw = failure.text.trim()
  const details = raw ? { details: raw.length > ERROR_DETAILS_MAX ? `${raw.slice(0, ERROR_DETAILS_MAX - 1)}…` : raw } : {}
  const said = clip(api?.message ?? raw)
  switch (kind) {
    case 'too-old': {
      const found = tooOldFacts(`${raw} ${api?.message ?? ''}`)
      const version = found?.version ?? failure.version ?? undefined
      const required = found?.required ?? undefined
      const facts: ChatErrorFacts = { model: failure.model, ...(version ? { version } : {}), ...(required ? { required } : {}), ...(found?.policy ? { policy: true } : {}) }
      const model = modelName(failure.model)
      const message = found?.policy
        ? mainT('engines.chat.mainErrors.ccTooOldPolicy', { version: version ?? '?' })
        : required
          ? mainT('engines.chat.mainErrors.ccTooOld', { version: version ?? '?', model, required })
          : mainT('engines.chat.mainErrors.ccTooOldNoVersion', { version: version ?? '?', model })
      return { code: 'cc-too-old', message, facts, ...details }
    }
    case 'signed-out':
      return { code: 'cc-signed-out', message: mainT('engines.chat.mainClaudeCode.claudeCodeIsnT2'), ...details }
    case 'credit':
      return { code: 'quota', message: mainT('engines.chat.mainClaudeCode.theAnthropicAccountClaude'), ...details }
    case 'limit': {
      const at = failure.resetsAt ? mainT('engines.chat.mainClaudeCode.itOpensAgainAt', { value: new Date(failure.resetsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }) : ''
      return { code: 'cc-limit', message: mainT('engines.chat.mainClaudeCode.yourClaudeAccountHas', { value: at }), ...details }
    }
    case 'overloaded':
      return { code: 'overloaded', message: mainT('chat.mainErrors.anthropicSServersAre'), retryAfterMs: DEFAULT_RETRY_MS, ...details }
    case 'model':
      return { code: 'cc-model', message: mainT('engines.chat.mainErrors.ccModel', { model: modelName(failure.model) }), facts: { model: failure.model }, ...details }
    case 'too-long':
      return { code: 'too-long', message: mainT('chat.mainErrors.thisChatIsToo'), ...details }
    case 'unavailable':
      return { code: 'unavailable', message: mainT('chat.mainErrors.theAnthropicApiIs'), ...details }
    case 'other':
      return { code: 'other', message: mainT('engines.chat.mainClaudeCode.claudeCodeCouldnT', { value: said ? `: ${said}` : '.' }), ...details }
  }
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 240 ? `${clean.slice(0, 239)}…` : clean
}
